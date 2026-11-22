/**
 * 折叠输入与摘要：把被压的 turn 渲染成 `<fold-input>`，调 summarizer，解析四段并校验。
 *
 * 摘要只写对话（D1）：做成什么、用户要什么、还欠什么、该看哪份文件。世界规则、人物事实、
 * 章节事件一个字都不进来——它们在文件里，路径由证据账指出。
 *
 * 工具结果分两类：原始材料只给指针 + 首段；结论（task / recall 的答复）给正文。
 * 结论是感知的产物，压掉它等于压掉取证结果。
 *
 * 边界：本模块不含折叠决策与落盘；只负责"构造输入 → 生成 → 校验"。
 */
import type { CompactionRecord, ModelConfig, StoredMessage } from "../core/types";
import { hashText } from "../core/hash";
import { chat } from "../llm/provider";
import type { ContextBudget } from "./budget";
import { estimateTokens } from "./budget";
import { renderPinned } from "./project_state";
import { turnsOf } from "./segments";

export interface FoldSummary {
  /** 更早的累积叙事（超过上限时把最老的行折进这里，≤300 token） */
  archive?: string;
  /** 累积的对话叙事（上次 + 这次） */
  session: string;
  accomplished: string[];
  intent: string[];
  open: string[];
  pointers: string[];
}

export interface SummaryResult {
  summary: FoldSummary;
  degraded: boolean;
  /** 生成的摘要失败时为 false；degraded 记录不走模型 */
  generated: boolean;
  promptHash: string;
}

/** 结论型输出保留的正文上限：它不是可重读的原文，截太狠会丢掉取证结果。 */
const CONCLUSION_KEEP_CHARS = 4000;
/** 用户/助手正文进入折叠输入的上限（超出部分由摘要承担，重读靠证据账）。 */
const DIALOGUE_KEEP_CHARS = 8000;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`;
}

function firstParagraph(text: string, max = 400): string {
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p !== "") ?? "";
  return clamp(para, max);
}

function parseInput(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 一个 assistant 消息里的工具结果 → 折叠输入里的一行（或整段结论）。 */
function renderTool(part: Extract<NonNullable<StoredMessage["parts"]>[number], { type: "tool" }>): string | undefined {
  if (part.state !== "completed" && part.state !== "error") return undefined;
  const input = parseInput(part.input);
  const path = typeof input.path === "string" ? input.path : undefined;
  const section = typeof input.section === "string" ? input.section : undefined;
  const chars = part.output?.length ?? 0;
  const outcome = part.error !== undefined ? ` error=${JSON.stringify(part.error.slice(0, 100))}` : "";

  const pointer = `[tool kind="${part.name}"${path === undefined ? "" : ` path="${path}"`}${
    section === undefined ? "" : ` section="${section}"`
  }${part.error === undefined ? ` chars=${chars}` : ""}${outcome}]`;

  if (part.name === "task" || part.name === "recall") {
    const body = part.error ?? part.output ?? "";
    return `${pointer}\n${clamp(body, CONCLUSION_KEEP_CHARS)}`;
  }
  if (part.name === "read" || part.name === "search" || part.name === "webfetch" || part.name === "websearch") {
    const body = part.error ?? firstParagraph(part.output ?? "");
    return `${pointer} ${body}`;
  }
  if (part.name === "skill") {
    return `${pointer} loaded`;
  }
  return pointer;
}

/** 被压的 turn → `<segment>` 文本。工具调用与结果同进同出。 */
export function renderFoldSegments(messages: readonly StoredMessage[]): string {
  const turns = turnsOf(messages);
  const blocks: string[] = [];
  for (const turn of turns) {
    const lines: string[] = [`<segment turn="${turn.fromSeq}-${turn.toSeq}">`];
    for (const m of turn.messages) {
      if (m.role === "user") {
        lines.push(`[user] ${clamp(m.text ?? "", DIALOGUE_KEEP_CHARS)}`);
      } else if (m.role === "assistant") {
        const text = (m.parts ?? [])
          .filter((p): p is Extract<NonNullable<StoredMessage["parts"]>[number], { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("");
        if (text.trim() !== "") lines.push(`[assistant] ${clamp(text, DIALOGUE_KEEP_CHARS)}`);
        for (const part of m.parts ?? []) {
          if (part.type !== "tool") continue;
          const line = renderTool(part);
          if (line !== undefined) lines.push(line);
        }
      }
    }
    lines.push("</segment>");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n");
}

/** 上一次折叠的累积叙事原样带进输入；不许从零重写（D3）。 */
function previousBlock(previous: CompactionRecord | undefined): string {
  if (previous === undefined) return "";
  const s = previous.summary;
  const tail = [...s.open.map((x) => `- open: ${x}`), ...s.pointers.map((x) => `- pointer: ${x}`)].join("\n");
  const archive = s.archive === undefined || s.archive.trim() === "" ? "" : `<archive>\n${s.archive}\n</archive>\n`;
  const body = s.session.trim() === "" ? "" : s.session;
  return `<previous-fold>\n${archive}${body}${tail === "" ? "" : `\n${tail}`}\n</previous-fold>\n`;
}

/** 累积摘要超过上限：把最老的行折进 `<archive>`（≤300 token，只增不减）。 */
export function archiveFold(
  previous: CompactionRecord | undefined,
  nextSession: string,
  budget: ContextBudget,
): { session: string; archive?: string } {
  const prevLines = (previous?.summary.session ?? "").split("\n").filter((l) => l.trim() !== "");
  let archiveLines = (previous?.summary.archive ?? "").split("\n").filter((l) => l.trim() !== "");
  const newLines = nextSession.split("\n").filter((l) => l.trim() !== "");
  let session = [...prevLines, ...newLines].join("\n");

  // 只搬旧行：新摘要已经校验过自己的长度，不能为了给历史腾地方把它截掉
  let i = 0;
  while (estimateTokens(session) > budget.summaryBudget && i < prevLines.length) {
    archiveLines.push(prevLines[i]);
    i++;
    session = [...prevLines.slice(i), ...newLines].join("\n");
  }
  // 归档本身也有上限：满了从最老的一行开始丢
  let archive = archiveLines.join("\n");
  while (estimateTokens(archive) > 300 && archiveLines.length > 1) {
    archiveLines = archiveLines.slice(1);
    archive = archiveLines.join("\n");
  }
  return { session, ...(archive.trim() === "" ? {} : { archive }) };
}

export function buildFoldInput(opts: {
  previous?: CompactionRecord;
  pinned: CompactionRecord["pinned"];
  messages: readonly StoredMessage[];
}): string {
  const pinned = renderPinned(opts.pinned);
  return [
    "<fold-input>",
    previousBlock(opts.previous),
    pinned === "" ? "" : `<pinned>\n${pinned}\n</pinned>`,
    renderFoldSegments(opts.messages),
    "</fold-input>",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function tagText(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m?.[1]?.trim();
}

function itemsOf(block: string | undefined): string[] {
  if (block === undefined || block.trim() === "") return [];
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => l.replace(/^[-*•]\s*/, "").replace(/^\d+[.、]\s*/, "").trim())
    .filter((l) => l !== "");
}

export interface ParsedSummary {
  ok: boolean;
  summary?: FoldSummary;
  error?: string;
}

/**
 * 解析 summarizer 输出。四段齐全、总长不超预算；空洞与未知专名只警告，不判失败——
 * 误杀一次折叠比多带一句话更贵。
 */
export function parseSummaryOutput(text: string, budget: ContextBudget): ParsedSummary {
  const accomplished = tagText(text, "accomplished");
  const intent = tagText(text, "intent");
  const open = tagText(text, "open");
  const pointers = tagText(text, "pointers");
  const missing: string[] = [];
  for (const [name, value] of [
    ["accomplished", accomplished],
    ["intent", intent],
    ["open", open],
    ["pointers", pointers],
  ] as const) {
    if (value === undefined) missing.push(name);
  }
  if (missing.length) return { ok: false, error: `缺少段落：${missing.join("、")}` };

  const a = itemsOf(accomplished);
  const i = itemsOf(intent);
  if (a.length === 0 && i.length === 0) return { ok: false, error: "accomplished 与 intent 都是空的" };

  const summary: FoldSummary = {
    session: [...a, ...i].join("\n"),
    accomplished: a,
    intent: i,
    open: itemsOf(open),
    pointers: itemsOf(pointers),
  };
  const tokens = estimateTokens(summary.session) + summary.open.reduce((n, x) => n + estimateTokens(x), 0);
  if (tokens > budget.summaryBudget) {
    return { ok: false, error: `摘要过长（约 ${tokens} token，上限 ${budget.summaryBudget}）` };
  }
  return { ok: true, summary };
}

/** 分块上限：一次把几十万字喂给 summarizer，摘要请求自己就会超窗。 */
function chunkChars(budget: ContextBudget, env: NodeJS.ProcessEnv): number {
  const pinned = Number(env.TALEMATE_SUMMARY_CHUNK_CHARS);
  if (Number.isFinite(pinned) && pinned > 0) return Math.floor(pinned);
  return Math.max(20_000, Math.floor(budget.usable * 0.5));
}

function splitText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export type Summarizer = (req: { system: string; user: string }) => Promise<string>;

const defaultSummarizer =
  (model: ModelConfig): Summarizer =>
  async ({ system, user }) =>
    (
      await chat({
        model,
        system,
        messages: [{ role: "user", text: user }],
      })
    ).text;

const FORMAT_RETRY =
  "上一份输出没有按四段 XML 组织。请只输出 <accomplished>、<intent>、<open>、<pointers> 四段，" +
  "不要写别的。";

/**
 * 生成摘要。模型失败/输出不合法 → 重试一次；再失败返回 degraded（确定性折叠）。
 * 降级不编叙事：session 只放被压段里 user/assistant 的原文，工具结果一律换成指针。
 */
export async function summarize(opts: {
  model: ModelConfig;
  system: string;
  budget: ContextBudget;
  input: string;
  previous?: CompactionRecord;
  messages: readonly StoredMessage[];
  summarizer?: Summarizer;
  env?: NodeJS.ProcessEnv;
}): Promise<SummaryResult> {
  const promptHash = hashText(opts.system);
  const run = opts.summarizer ?? defaultSummarizer(opts.model);
  const user = `以下是需要折叠的对话：\n\n${opts.input}`;
  const chunks = splitText(user, chunkChars(opts.budget, opts.env ?? process.env));

  try {
    let text: string;
    if (chunks.length === 1) {
      text = await run({ system: opts.system, user: chunks[0] });
    } else {
      const partials: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        partials.push(
          await run({
            system: opts.system,
            user: `${chunks[i]}\n\n（第 ${i + 1}/${chunks.length} 段；只折叠这一段，后面还有。）`,
          }),
        );
      }
      text = await run({
        system: opts.system,
        user: `以下是同一段历史的分段折叠。把它们合并成四段输出，保留上一次摘要里的人名与决定：\n\n${partials.join(
          "\n\n---\n\n",
        )}`,
      });
    }

    let parsed = parseSummaryOutput(text, opts.budget);
    if (!parsed.ok) {
      text = await run({ system: opts.system, user: `${chunks.join("\n\n")}\n\n${FORMAT_RETRY}` });
      parsed = parseSummaryOutput(text, opts.budget);
    }
    if (parsed.ok && parsed.summary !== undefined) {
      const folded = archiveFold(opts.previous, parsed.summary.session, opts.budget);
      const summary: FoldSummary = {
        ...parsed.summary,
        session: folded.session,
        ...(folded.archive === undefined ? {} : { archive: folded.archive }),
      };
      return { summary, degraded: false, generated: true, promptHash };
    }
  } catch {
    // 落到下面的确定性降级：宁可少一段叙事，也不要编一段
  }

  const degraded = degradedSummary(opts.messages, opts.budget);
  if (opts.previous !== undefined) {
    const folded = archiveFold(opts.previous, degraded.session, opts.budget);
    degraded.session = folded.session;
    if (folded.archive !== undefined) degraded.archive = folded.archive;
  }
  return { summary: degraded, degraded: true, generated: false, promptHash };
}

/** 确定性降级：只留 user/assistant 原文，工具结果变成指针。 */
export function degradedSummary(messages: readonly StoredMessage[], budget: ContextBudget): FoldSummary {
  const lines: string[] = [];
  let tokens = 0;
  for (const m of messages) {
    if (m.role === "user") {
      const line = `用户：${m.text ?? ""}`;
      const n = estimateTokens(line);
      if (tokens + n > budget.summaryBudget) break;
      tokens += n;
      lines.push(line);
    } else if (m.role === "assistant") {
      const text = (m.parts ?? [])
        .filter((p): p is Extract<NonNullable<StoredMessage["parts"]>[number], { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text.trim() === "") continue;
      const line = `搭档：${text}`;
      const n = estimateTokens(line);
      if (tokens + n > budget.summaryBudget) break;
      tokens += n;
      lines.push(line);
    }
  }
  return { session: lines.join("\n"), accomplished: [], intent: [], open: [], pointers: [] };
}