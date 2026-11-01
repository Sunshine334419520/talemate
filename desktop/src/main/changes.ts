/**
 * 改动记录：读每个会话的 `changes.jsonl`（投影），按轮分组给右栏的历史视图。
 *
 * 本次会话只读一个索引文件；本书读 N 个小文件（N = 会话数）+ N 个 `session.json`（标题）。
 * **不折任何会话的 messages**——索引存在的理由就是让这本书的历史视图不必把整本书的日志读一遍。
 *
 * 索引里没有 diff：界面点开某一行时才用 `changeDiff` 按指针去取。坏会话跳过，不因为一份
 * 写了一半的文件让整张记录打不开。
 */
import { readChanges } from "../../../src/storage/change_index";
import { listSessionIds, loadSessionMeta } from "../../../src/storage/session-store";
import type { ChangePoint } from "../../../src/core/types";
import type { SessionTurnChanges } from "../shared/api";

export async function listTurnChanges(
  projectId: string,
  sessionId?: string,
): Promise<SessionTurnChanges[]> {
  const ids = sessionId === undefined ? await listSessionIds(projectId) : [sessionId];
  const groups = await Promise.all(ids.map((id) => groupsOf(projectId, id)));
  return groups.flat().sort((a, b) => b.ts - a.ts);
}

/** 一个会话：读它的索引 + 元信息，按轮分组。坏会话返回空，不拖垮整张表。 */
async function groupsOf(projectId: string, id: string): Promise<SessionTurnChanges[]> {
  try {
    const [meta, records] = await Promise.all([
      loadSessionMeta(projectId, id),
      readChanges(projectId, id),
    ]);
    const turns = new Map<number, { ts: number; user: string; changes: ChangePoint[] }>();
    for (const record of records) {
      const turn = turns.get(record.turnSeq) ?? {
        ts: record.ts,
        user: record.user,
        changes: [],
      };
      turn.ts = Math.min(turn.ts, record.ts);
      if (turn.user === "") turn.user = record.user;
      turn.changes.push({
        turnSeq: record.turnSeq,
        messageSeq: record.messageSeq,
        callId: record.callId,
        path: record.path,
        kind: record.kind,
        additions: record.additions,
        deletions: record.deletions,
      });
      turns.set(record.turnSeq, turn);
    }
    return [...turns.values()].map((turn) => ({
      sessionId: id,
      sessionTitle: meta.title,
      user: turn.user,
      ts: turn.ts,
      changes: turn.changes,
    }));
  } catch {
    // 会话目录坏了一半：跳过它，别让整个历史视图跟着打不开
    return [];
  }
}
