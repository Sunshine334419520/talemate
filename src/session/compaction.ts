/**
 * Compaction（上下文压缩）：把最早的一段历史压成一条 role:"compaction" 消息（summary+recent）。
 *
 * 语义（04 §8）：上下文 = 最新 compaction 之后的 seq（storage.loadModelWindow 已实现"取最新 compaction 起"）。
 * 这里提供：
 *  - estimateChars：粗略估算消息文本量（决策是否压缩的廉价信号）
 *  - compact：把 head 部分喂 LLM 生成小说向摘要（当前写到哪/已定设定/未回收伏笔/下一步），
 *    以 summary+recent 追加一条 compaction 消息。
 *
 * P0 触发策略从简：会话外部（CLI/上层）在消息量超阈值时调用 compact()，不自动打断 agent 循环。
 */
import type { ModelConfig, StoredMessage } from "../core/types";
import { chat } from "../llm";
import { loadMessages, appendMessage } from "../storage";

/** 粗略文本量估算（字符数）。中文 ~1 字符/token 近似，足够做触发阈值。 */
export function estimateChars(messages: StoredMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const p of m.parts ?? []) {
        if (p.type === "text" || p.type === "reasoning") n += p.text.length;
        if (p.type === "tool") n += p.output?.length ?? 0;
      }
    } else {
      n += (m.text?.length ?? 0) + (m.summary?.length ?? 0);
    }
  }
  return n;
}

const COMPACTION_SYSTEM = [
  "你是一个小说项目的摘要器。把给定的对话/材料压成一段前情摘要，供后续写作继续时引用。",
  "要求：",
  "- 只保留对继续写作必要的信息：故事当前写到哪、已确定的设定与人物、未回收的伏笔/悬念、下一步要做什么。",
  "- 丢弃寒暄、工具调用细节、重复解释。",
  "- 用条目式，控制在 600 字内。",
].join("\n");

/** 保留的 recent 消息条数（原样留在上下文里，防止摘要丢细节） */
const RECENT_KEEP = 6;

/**
 * 执行一次压缩：把 head（去掉最近 RECENT_KEEP 条）喂 LLM 生成摘要，
 * 追加一条 compaction 消息。head 为空或过小则跳过。
 * 返回是否真的压缩了。
 */
export async function compact(opts: {
  projectId: string;
  sessionId: string;
  model: ModelConfig;
}): Promise<boolean> {
  const { projectId, sessionId, model } = opts;
  const messages = await loadMessages(projectId, sessionId);
  if (messages.length <= RECENT_KEEP) return false;

  const split = messages.length - RECENT_KEEP;
  const head = messages.slice(0, split);
  const recent = messages.slice(split);

  // head 里已经没有可压内容（比如之前刚压过且几乎都是 compaction）
  if (!head.some((m) => m.role !== "compaction")) return false;

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
      system: COMPACTION_SYSTEM,
      messages: [{ role: "user", text: `以下是需要摘要的内容：\n\n${headText}` }],
    })
  ).text;

  await appendMessage(projectId, sessionId, { role: "compaction", summary, recent: recentText });
  return true;
}
