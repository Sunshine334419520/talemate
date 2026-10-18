/**
 * 按轮收集落盘改动。消息流是唯一来源：界面与主进程都从这儿取，不另存一份改动索引。
 *
 * 一轮 = 一条用户消息到下一條用户消息之间；一开始就存在的助手消息也算一轮（自检、续写）。
 * 改动只是 tool part 上的结构化字段，模型上下文不读它。
 */
import type { AssistantPart, StoredMessage, WriteChange } from "../core/types";

export interface MessageTurn {
  /** 这一轮的消息，按原顺序——界面要照原样画出来 */
  messages: StoredMessage[];
  /** 这一轮所有成功落盘留下的记录，按发生顺序 */
  changes: WriteChange[];
}

export function changesOfParts(parts: AssistantPart[] | undefined): WriteChange[] {
  const out: WriteChange[] = [];
  for (const p of parts ?? []) {
    if (p.type === "tool" && p.change !== undefined) out.push(p.change);
  }
  return out;
}

export function messageTurns(messages: StoredMessage[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  for (const m of messages) {
    // 只有用户消息开新一轮；开头没有用户消息时也让助手消息有自己的落点
    if (m.role === "user" || turns.length === 0) turns.push({ messages: [], changes: [] });
    const turn = turns[turns.length - 1];
    turn.messages.push(m);
    if (m.role === "assistant") turn.changes.push(...changesOfParts(m.parts));
  }
  return turns;
}
