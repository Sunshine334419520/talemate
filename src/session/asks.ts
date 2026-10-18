/**
 * asks：提问的纯规则——模型入参校验、用户答案校验、tool 结果文案、从消息投影未答问题。
 *
 * 这里不碰 io、存储与界面：交付层只负责“问”和“等”，答案的合法性与回灌文案都在这一层。
 * 投影是纯函数，桌面端与测试共用同一份“哪些问题还开着”的判据。
 */
import type {
  AskAnswer,
  AskQuestion,
  AskRecord,
  PendingAskRecord,
  StoredMessage,
} from "../core/types";

/** 推荐项的标记：label 末尾的「（推荐）」/「(Recommended)」。UI 与提示词只认这一种写法。 */
export const RECOMMENDED_RE = /[（(]\s*(?:推荐|recommended)\s*[)）]\s*$/i;

export function isRecommended(label: string): boolean {
  return RECOMMENDED_RE.test(label);
}

/** 显示名去掉推荐标记；回传值仍是模型给的原 label。 */
export function stripRecommended(label: string): string {
  return label.replace(RECOMMENDED_RE, "").trim();
}

export interface ParsedAsk {
  questions: AskQuestion[];
  /** undefined = 不限时；缺省为 120 秒。 */
  timeoutMs: number | undefined;
}

type Parsed = { ok: true; value: ParsedAsk } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * 模型入参 → 域模型。失败一律返回可自愈的中文文案，让模型同轮改对再调。
 *
 * 三条硬限制值得在这里而不是在提示词里：题数 ≤ 3、选项 2–5、同一题内 label 不重复。
 * 前两条防“把一张卡堆成问卷”，第三条是答案按 label 回传的唯一性前提。
 */
export function parseAskArgs(args: unknown): Parsed {
  if (!isRecord(args)) {
    return { ok: false, error: "ask-user 的入参必须是对象——请带 questions 重新调用。" };
  }
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: `ask-user 缺少 questions（收到：${JSON.stringify(args).slice(0, 200)}）——请带 1–3 个问题重新调用。`,
    };
  }
  if (raw.length > 3) {
    return { ok: false, error: `ask-user 一次最多 3 个问题（收到 ${raw.length} 个）——请拆成更少的决定重新调用。` };
  }

  const questions: AskQuestion[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    if (!isRecord(q)) {
      return { ok: false, error: `ask-user 的第 ${i + 1} 个问题必须是对象——请检查 questions 的形状。` };
    }
    if (!nonEmpty(q.id)) {
      return { ok: false, error: `ask-user 的第 ${i + 1} 个问题缺少 id——每题都要一个稳定 id，答案里会回传它。` };
    }
    const id = q.id.trim();
    if (ids.has(id)) {
      return { ok: false, error: `ask-user 的 question id「${id}」重复了——请给每题一个不同的 id。` };
    }
    ids.add(id);
    if (!nonEmpty(q.question)) {
      return { ok: false, error: `ask-user 的「${id}」缺少 question——请写清要用户决定什么。` };
    }
    if (q.header !== undefined && typeof q.header !== "string") {
      return { ok: false, error: `ask-user 的「${id}」header 必须是字符串。` };
    }
    if (q.multi_select !== undefined && typeof q.multi_select !== "boolean") {
      return { ok: false, error: `ask-user 的「${id}」multi_select 必须是布尔值。` };
    }

    let options: AskQuestion["options"];
    if (q.options !== undefined) {
      if (!Array.isArray(q.options)) {
        return { ok: false, error: `ask-user 的「${id}」options 必须是数组。` };
      }
      if (q.options.length === 1) {
        return {
          ok: false,
          error: `ask-user 的「${id}」只有一个选项——只有一个方案可走时不要提问，直接执行并在结果里说明。`,
        };
      }
      if (q.options.length > 5) {
        return { ok: false, error: `ask-user 的「${id}」有 ${q.options.length} 个选项——每题最多 5 个，请合并或删掉。` };
      }
      if (q.options.length >= 2) {
        const labels = new Set<string>();
        const parsedOptions: NonNullable<AskQuestion["options"]> = [];
        for (let j = 0; j < q.options.length; j++) {
          const o = q.options[j];
          if (!isRecord(o) || !nonEmpty(o.label)) {
            return { ok: false, error: `ask-user 的「${id}」第 ${j + 1} 个选项缺少 label。` };
          }
          const label = o.label;
          if (labels.has(label)) {
            return { ok: false, error: `ask-user 的「${id}」选项 label「${label}」重复了——答案按 label 回传，必须唯一。` };
          }
          labels.add(label);
          if (o.description !== undefined && typeof o.description !== "string") {
            return { ok: false, error: `ask-user 的「${id}」选项「${label}」的 description 必须是字符串。` };
          }
          parsedOptions.push({ label, ...(o.description === undefined ? {} : { description: o.description }) });
        }
        options = parsedOptions;
      }
    }

    questions.push({
      id,
      ...(typeof q.header === "string" && q.header.trim() !== "" ? { header: q.header.trim() } : {}),
      question: q.question.trim(),
      ...(options === undefined ? {} : { options }),
      ...(q.multi_select === true ? { multiSelect: true } : {}),
    });
  }

  let timeoutMs: number | undefined = 120_000;
  if (args.timeout !== undefined) {
    if (typeof args.timeout !== "number" || !Number.isFinite(args.timeout)) {
      return { ok: false, error: "ask-user 的 timeout 必须是秒数；不填默认 120，-1 表示不限时。" };
    }
    if (args.timeout === -1) {
      timeoutMs = undefined;
    } else if (args.timeout <= 0 || args.timeout > 3600) {
      return { ok: false, error: "ask-user 的 timeout 只能是 -1，或 1–3600 秒。" };
    } else {
      timeoutMs = Math.round(args.timeout * 1000);
    }
  }

  return { ok: true, value: { questions, timeoutMs } };
}

/**
 * 交付层提交的答案是否合法。主进程用它挡住重连后的旧消息与界面 bug，
 * 不让一个不属于这道题的 label 进入模型上下文。
 */
export function validateAnswers(questions: AskQuestion[], answers: unknown): string | undefined {
  if (!Array.isArray(answers)) return "answers 必须是数组。";
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const a of answers) {
    if (!isRecord(a) || typeof a.id !== "string") return "每一项答案都必须带 id。";
    const q = byId.get(a.id);
    if (q === undefined) return `答案里的 id「${a.id}」不属于这次提问。`;
    if (seen.has(a.id)) return `答案里的 id「${a.id}」出现了两次。`;
    seen.add(a.id);
    if (!Array.isArray(a.selected) || a.selected.some((s) => typeof s !== "string")) {
      return `「${a.id}」的 selected 必须是字符串数组。`;
    }
    if (a.custom !== undefined && typeof a.custom !== "string") {
      return `「${a.id}」的 custom 必须是字符串。`;
    }
    if (a.selected.length > 0) {
      const labels = new Set((q.options ?? []).map((o) => o.label));
      if (labels.size === 0) return `「${a.id}」没有选项，不能有 selected。`;
      const bad = a.selected.filter((s) => !labels.has(s));
      if (bad.length > 0) return `「${a.id}」选择了不存在的选项：${bad.join("、")}。`;
      if (q.multiSelect !== true && a.selected.length > 1) {
        return `「${a.id}」是单选题，只能选一个。`;
      }
    }
  }
  const missing = questions.filter((q) => !seen.has(q.id)).map((q) => q.id);
  return missing.length === 0 ? undefined : `答案缺少这些题：${missing.join("、")}。`;
}

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** 已回答的 tool 结果。被跳过的题明确标 skipped——空 selected 不是“随便”。 */
export function renderAskResult(record: AskRecord): string {
  const byId = new Map((record.answers ?? []).map((a) => [a.id, a]));
  const lines = ["用户已回答这次提问。照答案继续；被跳过的问题不要再问，除非它挡住了下一步。", "", `<user_answers call_id="${xmlEscape(record.callId)}">`];
  for (const q of record.questions) {
    const a = byId.get(q.id);
    if (a === undefined || (a.selected.length === 0 && (a.custom ?? "").trim() === "")) {
      lines.push(`<answer id="${xmlEscape(q.id)}" status="skipped" />`);
      continue;
    }
    lines.push(`<answer id="${xmlEscape(q.id)}" status="answered">`);
    for (const s of a.selected) lines.push(`<selected>${xmlEscape(s)}</selected>`);
    if ((a.custom ?? "").trim() !== "") lines.push(`<custom>${xmlEscape((a.custom ?? "").trim())}</custom>`);
    lines.push("</answer>");
  }
  lines.push("</user_answers>");
  return lines.join("\n");
}

/**
 * pending 的 tool 结果。这段话同时会作为 halt 的最终正文出现在界面上，所以写成用户也读得懂的中文。
 * “不是同意”必须落在结果里，而不是只写在旁白或系统提示里。
 */
export function renderPendingResult(record: AskRecord): string {
  return [
    "这次提问没有拿到回答（超时，或用户选择了稍后回答）。这是 pending，不是「跳过」，更不是同意。",
    `这一轮先停在这里。用户随时可以回答，答案会作为一条 answer_to_pending_question 用户消息送到你面前（call_id=${record.callId}）。`,
    "不要据此做任何决定，也不要把沉默当成许可。",
  ].join("\n");
}

export function renderCancelledResult(record: AskRecord): string {
  return `提问被取消（没有可用的回答方，或这一轮被中断，call_id=${record.callId}）。不要把它当作同意。`;
}

/** 迟到回答拼成的用户消息：自包含，压缩之后模型也读得懂问的是什么。 */
export function renderAnswerMessage(questions: AskQuestion[], answers: AskAnswer[], callId: string): string {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const lines = [`[answer_to_pending_question call_id=${callId}]`, "用户回答了之前没有答完的问题："];
  for (const q of questions) {
    const a = byId.get(q.id);
    lines.push(`- [${q.id}] ${q.question}`);
    if (a === undefined || (a.selected.length === 0 && (a.custom ?? "").trim() === "")) {
      lines.push("  （跳过）");
      continue;
    }
    if (a.selected.length > 0) lines.push(`  选择：${a.selected.map(stripRecommended).join("、")}`);
    if ((a.custom ?? "").trim() !== "") lines.push(`  自定义：${(a.custom ?? "").trim()}`);
  }
  return lines.join("\n");
}

export interface OpenAsk {
  callId: string;
  questions: AskQuestion[];
  at: number;
}

/** 消息里已经出现过的提问 callId（answered 或 cancelled），供界面去重与“不要再打开”。 */
export function settledCallIds(messages: StoredMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.answersTo !== undefined) out.add(m.answersTo.callId);
    for (const p of m.parts ?? []) {
      if (p.type === "tool" && p.ask !== undefined && p.ask.outcome !== "pending") out.add(p.ask.callId);
    }
  }
  return out;
}

/**
 * 仍然开着、可回答的提问：tool part 里 outcome=pending，且后面没有一条 answersTo 把它答掉。
 * 这是“问题状态不单独存一份”的投影——界面和系统注记都用它。
 */
export function openAsks(messages: StoredMessage[]): OpenAsk[] {
  const answered = new Set<string>();
  for (const m of messages) if (m.answersTo !== undefined) answered.add(m.answersTo.callId);

  const byCall = new Map<string, OpenAsk>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool" || p.ask === undefined) continue;
      const a = p.ask;
      if (a.outcome !== "pending" || answered.has(a.callId)) continue;
      byCall.set(a.callId, { callId: a.callId, questions: a.questions, at: a.at });
    }
  }
  return [...byCall.values()].sort((a, b) => a.at - b.at);
}

/** journal 里那条尚未提交的记录，若消息里还没有同 callId 的提问，就该并进开着的列表。 */
export function mergeJournalAsk(open: OpenAsk[], journal: PendingAskRecord | undefined): OpenAsk[] {
  if (journal === undefined) return open;
  if (open.some((a) => a.callId === journal.callId)) return open;
  return [...open, { callId: journal.callId, questions: journal.questions, at: journal.at }].sort(
    (a, b) => a.at - b.at,
  );
}

/**
 * 未答提问的系统注记（每轮注入）。和 `renderPendingNote` 同一个位置：它是状态，不是历史。
 * “pending 不是同意”必须写在模型每轮都看得到的地方——用户沉默之后模型最容易自作主张。
 */
export function renderOpenAskNote(asks: OpenAsk[]): string | undefined {
  if (asks.length === 0) return undefined;
  const lines = [
    "<open-question>",
    "有一组问题还没回答（超时、稍后或中断）。这是 pending，不是「跳过」，更不是同意；",
    "不要替用户回答，也不要据此往下做。用户回答后会收到一条 answer_to_pending_question 用户消息。",
  ];
  for (const a of asks) {
    lines.push(`- call_id=${a.callId}`);
    for (const q of a.questions) lines.push(`  [${q.id}] ${q.question}`);
  }
  lines.push("</open-question>");
  return lines.join("\n");
}
