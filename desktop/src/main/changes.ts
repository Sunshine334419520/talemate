/**
 * 改动记录：扫描这本书所有会话的 messages.jsonl，按轮收集 tool part 上的 WriteChange。
 *
 * 不另存索引——消息流是唯一来源；这里只做聚合，读的是已经落盘的那一份。坏会话跳过，
 * 不因为一份写了一半的文件让整张记录打不开。
 */
import { messageTurns } from "../../../src/session/turn_changes";
import { listSessionIds, loadMessages, loadSessionMeta } from "../../../src/storage/session-store";
import type { SessionTurnChanges } from "../shared/api";

/** 组头那句话只取第一行；太长会把时间挤掉 */
const USER_LINE = 80;

export async function listTurnChanges(projectId: string): Promise<SessionTurnChanges[]> {
  const ids = await listSessionIds(projectId);
  const out: SessionTurnChanges[] = [];

  for (const sessionId of ids) {
    try {
      const meta = await loadSessionMeta(projectId, sessionId);
      const messages = await loadMessages(projectId, sessionId);
      for (const turn of messageTurns(messages)) {
        if (turn.changes.length === 0) continue;
        const user = turn.messages.find((m) => m.role === "user");
        const first = (user?.text ?? "").split("\n")[0]?.trim() ?? "";
        out.push({
          sessionId,
          sessionTitle: meta.title,
          user: first.length > USER_LINE ? `${first.slice(0, USER_LINE)}…` : first,
          ts: user?.ts ?? turn.messages[0]?.ts ?? 0,
          changes: turn.changes,
        });
      }
    } catch {
      // 会话文件坏了一半：跳过它，别让整个历史视图跟着打不开
    }
  }

  return out.sort((a, b) => b.ts - a.ts);
}
