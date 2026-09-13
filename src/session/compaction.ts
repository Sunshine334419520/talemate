/**
 * Compaction（上下文压缩）：把最早的一段历史压成一条 role:"compaction" 消息（summary+recent）。
 * 之后 loadModelWindow 只取"最新 compaction 之后"的 seq。
 *
 * - estimateChars / isOverBudget：粗略估算文本量，作为是否压缩的信号。
 * - compact：把 head 喂给 LLM 生成摘要，以 summary+recent 追加一条 compaction 消息并返回它。
 *
 * 触发在 session 侧：用内存缓存的消息判 isOverBudget，超阈值才调 compact（内存消息传进来，避免重复读盘）。
 */
import { SUMMARIZER_SYSTEM } from "../agent/registry";
import type { ModelConfig, StoredMessage } from "../core/types";
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
      n += (m.text?.length ?? 0) + (m.summary?.length ?? 0);
    }
  }
  return n;
}

/** 触发压缩的粗略字符阈值（中文 ~1 字符/token 近似；取"明显变长"的门槛，避免小会话被误伤） */
const COMPACT_THRESHOLD_CHARS = 30_000;

/** 累计文本量是否超压缩阈值（用内存消息判断，避免每次读盘） */
export function isOverBudget(messages: StoredMessage[], threshold = COMPACT_THRESHOLD_CHARS): boolean {
  return estimateChars(messages) > threshold;
}

/** 保留的 recent 消息条数（原样留在上下文里，防止摘要丢细节） */
const RECENT_KEEP = 6;

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

  const summary = (
    await chat({
      model,
      system: opts.system ?? SUMMARIZER_SYSTEM,
      messages: [{ role: "user", text: `以下是需要摘要的内容：\n\n${headText}` }],
    })
  ).text;

  return appendMessage(projectId, sessionId, { role: "compaction", summary, recent: recentText });
}
