/**
 * Compaction（上下文压缩）：把最早的一段历史压成一条 role:"compaction" 消息（summary+recent），
 * 之后 loadModelWindow 只取"最新 compaction 之后"的 seq。
 *
 * estimateChars / isOverBudget 估文本量、判是否该压；compact 把 head 喂给 LLM 生成摘要。
 * 触发在 session 侧：用它内存缓存的消息判 isOverBudget，超阈值才调 compact（免重复读盘）。
 */
import { SUMMARIZER_SYSTEM } from "../agent/registry";
import type { ModelConfig, StoredMessage } from "../core/types";
import { compactTrigger } from "../core/windows";
import { chat } from "../llm/provider";
import { appendMessage, loadMessages } from "../storage/session-store";

/** 粗略文本量估算（字符数）。中文 ~1 字符/token 近似，足够做触发阈值。 */
export function estimateChars(messages: StoredMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const p of m.parts ?? []) {
        if (p.type === "text" || p.type === "reasoning") n += p.text.length;
        // tool 的入参也算：提案（propose-design）的正文就在 input 侧，只算 output 会让
        // 一整份草稿对压缩预算完全不可见。
        if (p.type === "tool") n += (p.output?.length ?? 0) + (p.input?.length ?? 0);
      }
    } else {
      // compaction 的正文分两块：summary 与 recent，两块都要算。只算 summary 会让窗口估算偏低
      // （实测 recent 有几百到两千多字），阈值就白设了。
      n += (m.text?.length ?? 0) + (m.summary?.length ?? 0) + (m.recent?.length ?? 0);
    }
  }
  return n;
}

/**
 * 这个会话是否该压缩。判据是真实用量：provider 报回的 `usage.input`（那一次请求到底发了多少 token），
 * 会话记在 `SessionMeta.usage` 里。触发点按模型的窗口算（`core/windows.ts` 的 `compactTrigger`，八成），
 * 所以 1M 窗口的模型到 80 万才动手，而不是所有模型按同一个数。没有真数时退回字符估算（这个会话还没
 * 发过请求）——新会话离阈值本来就远，所以是兜底不是常态。
 *
 * `messages` 必须是模型实际会看到的那一段（`loadModelWindow` 之后），不是整份会话文件：文件只增不减，
 * 量它等于越过阈值一次就永远超预算——此后每回合压一次，而每压一次就把上下文洗掉一次，
 * 模型只能把刚读过的文档重读一遍。
 */
export function isOverBudget(
  model: string,
  lastInput: number | undefined,
  messages: StoredMessage[],
  env = process.env,
): boolean {
  const trigger = Number(env.TALEMATE_COMPACT_TOKENS) || compactTrigger(model);
  // 真数是上一次请求的输入；它看不到"这一步刚产生的大工具输出"。字符估算补这一刀：
  // 中文按 1 字符 ≈ 1 token 估，宁可早压，也不要在下一次请求时才被 provider 顶回来。
  return estimateChars(messages) > trigger || (lastInput !== undefined && lastInput > trigger);
}

/** 保留的 recent 消息条数（原样留在上下文里，防止摘要丢细节） */
const RECENT_KEEP = 6;

/** 把一段文本按不超过 size 切块；优先在换行处切，单行过长才硬切。 */
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

/**
 * 摘要的输入上限：一次把 80 万字的 head 喂给 summarizer，摘要请求自己就会超窗。
 * 按模型窗口的一半切块；测试可以用 TALEMATE_SUMMARY_CHUNK_CHARS 压小。
 */
function summaryChunkChars(model: string, env = process.env): number {
  const pinned = Number(env.TALEMATE_SUMMARY_CHUNK_CHARS);
  if (Number.isFinite(pinned) && pinned > 0) return Math.floor(pinned);
  return Math.max(20_000, Math.floor(compactTrigger(model) * 0.5));
}

/**
 * 执行一次压缩。messages 可由调用方传入（会话内存缓存）以免重复读盘；缺省从盘读。
 * system 由调用方（session，取 hidden summarizer agent）提供；缺省回落 SUMMARIZER_SYSTEM。
 * 返回写入的 compaction 消息；head 无可压内容/过小则返回 null。
 */
export async function compact(opts: {
  projectId: string;
  sessionId: string;
  model: ModelConfig;
  system?: string;
  messages?: StoredMessage[];
}): Promise<StoredMessage | null> {
  const { projectId, sessionId, model } = opts;
  const messages = opts.messages ?? (await loadMessages(projectId, sessionId));
  if (messages.length <= RECENT_KEEP) return null;

  const split = messages.length - RECENT_KEEP;
  const head = messages.slice(0, split);
  const recent = messages.slice(split);

  // head 里已经没有可压内容（比如之前刚压过且几乎都是 compaction）
  if (!head.some((m) => m.role !== "compaction")) return null;

  const headText = head
    .map((m) => {
      if (m.role === "user" || m.role === "system") return `[${m.role}] ${m.text ?? ""}`;
      if (m.role === "assistant") {
        const t = (m.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("");
        return `[assistant] ${t}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  const recentText = recent
    .map((m) => {
      if (m.role === "user") return `[user] ${m.text ?? ""}`;
      if (m.role === "assistant") {
        const t = (m.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("");
        return `[assistant] ${t}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (headText.trim() === "") return null;

  const system = opts.system ?? SUMMARIZER_SYSTEM;
  const chunks = splitText(headText, summaryChunkChars(model.model));
  let summary: string;
  if (chunks.length === 1) {
    summary = (
      await chat({
        model,
        system,
        messages: [{ role: "user", text: `以下是需要摘要的内容：\n\n${chunks[0]}` }],
      })
    ).text;
  } else {
    const partials: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      partials.push(
        (
          await chat({
            model,
            system,
            messages: [
              {
                role: "user",
                text: `以下是需要摘要的内容（第 ${i + 1}/${chunks.length} 段）：\n\n${chunks[i]}`,
              },
            ],
          })
        ).text,
      );
    }
    summary = (
      await chat({
        model,
        system,
        messages: [
          {
            role: "user",
            text:
              "以下是同一段历史的分段摘要。把它们合并成一份摘要，保留人名、硬设定、未兑现的承诺与当前进度：\n\n" +
              partials.join("\n\n---\n\n"),
          },
        ],
      })
    ).text;
  }

  return appendMessage(
    projectId,
    sessionId,
    { role: "compaction", summary, recent: recentText },
    { seq: (messages.at(-1)?.seq ?? 0) + 1 },
  );
}
