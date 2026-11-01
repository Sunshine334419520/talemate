/**
 * 改动历史：把消息投影折成改动索引里的行，以及按索引里的指针回取 diff。
 *
 * 它连接两层：`storage/change_index.ts` 只管文件的追加/读取/墓碑，这里负责"从消息里认出一轮
 * 改了哪些文件"。**读改动不读 messages 文件**——消息本来就是事件日志的投影；索引只是把
 * "哪一轮改了哪个文件"提前折好，让本书视图不必折所有会话。
 *
 * 边界：只认消息与索引；不认识桌面、不认识 Session。
 */
import type { ChangePoint, StoredMessage } from "../core/types";
import { loadMessages } from "../storage/session-store";
import { writeChanges } from "../storage/change_index";
import type { ChangeRecord } from "../storage/change_index";

/** 组头那句话只取第一行；太长会把时间挤掉。 */
const USER_LINE = 80;

export function userLine(text: string | undefined): string {
  const first = (text ?? "").split("\n")[0]?.trim() ?? "";
  return first.length > USER_LINE ? `${first.slice(0, USER_LINE)}…` : first;
}

/** 一条已提交的 assistant 消息 → 它带出的改动行（没有改动就是空数组）。 */
export function changePointsOfMessage(
  message: StoredMessage,
  turnSeq: number,
  user: string,
): ChangePoint[] {
  const points: ChangePoint[] = [];
  for (const part of message.parts ?? []) {
    if (part.type !== "tool" || part.change === undefined) continue;
    const change = part.change;
    points.push({
      turnSeq,
      messageSeq: message.seq,
      callId: part.id,
      path: change.path,
      kind: change.kind,
      additions: change.additions,
      deletions: change.deletions,
    });
  }
  return points;
}

/** 整段消息 → 索引行。`turnSeq` 取最近一条用户消息；没有用户消息的那段算 turnSeq 0。 */
export function changeRecordsOf(messages: StoredMessage[]): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  let turnSeq = 0;
  let user = "";
  for (const message of messages) {
    if (message.role === "user") {
      turnSeq = message.seq;
      user = userLine(message.text);
      continue;
    }
    for (const point of changePointsOfMessage(message, turnSeq, user)) {
      records.push({ type: "change", ...point, ts: message.ts, user });
    }
  }
  return records;
}

/** 从事件重算一份会话的索引。索引落后、坏掉、或旧会话迁移时调用。 */
export async function rebuildSessionChanges(projectId: string, sessionId: string): Promise<number> {
  const records = changeRecordsOf(await loadMessages(projectId, sessionId));
  await writeChanges(projectId, sessionId, records);
  return records.length;
}

/**
 * 按指针取 diff。找不到消息或 part 时返回 undefined——索引行可能来自被回退掉的分支，
 * 也可能文件被手删过；界面对这种情况回退到"打开文档全文"，不编一份 diff。
 */
export async function readChangeDiff(
  projectId: string,
  sessionId: string,
  messageSeq: number,
  callId: string,
): Promise<string | undefined> {
  const message = (await loadMessages(projectId, sessionId)).find((m) => m.seq === messageSeq);
  if (message === undefined) return undefined;
  for (const part of message.parts ?? []) {
    if (part.type === "tool" && part.id === callId) return part.change?.diff;
  }
  return undefined;
}
