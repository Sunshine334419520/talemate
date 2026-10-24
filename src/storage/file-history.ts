/**
 * 会话的文件改动检查点：只给"回退对话和文件"用。
 *
 * `write_ops` 在**成功落盘之后**记一条"写前内容"，按发起这一轮的用户消息 seq 分组。
 * 它不进 `messages.jsonl`：文件内容可能很大，而且它不是一条会话消息；这份账坏了最多是
 * 文件不能还原，对话本身不受影响。
 *
 * 同一个 `(seq, path)` 只留第一条——回退要的是这一轮开始前的内容，后面几次写都在同一轮里。
 */
import { join } from "node:path";
import { sessionPaths, talemateHome } from "../core/config";
import { readText, writeAtomic } from "./atomic";

export interface FileCheckpoint {
  /** 发起这一轮的用户消息 seq；回退到 seq 时，凡 `checkpoint.seq >= seq` 的写都要还原 */
  seq: number;
  /** 项目相对路径（与权限 pattern 同口径） */
  path: string;
  /** 写前内容（含 BOM）；null = 写前文件不存在，回退时应删除 */
  before: string | null;
  at: number;
}

function checkpointFile(projectId: string, sessionId: string): string {
  return join(sessionPaths(talemateHome(), projectId, sessionId).dir, "rewind-files.json");
}

export async function loadFileCheckpoints(projectId: string, sessionId: string): Promise<FileCheckpoint[]> {
  const raw = await readText(checkpointFile(projectId, sessionId));
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is FileCheckpoint => {
      if (typeof v !== "object" || v === null) return false;
      const c = v as Record<string, unknown>;
      return typeof c.seq === "number" && typeof c.path === "string" && typeof c.at === "number"
        && (c.before === null || typeof c.before === "string");
    });
  } catch {
    return []; // 坏账按没有处理：最坏是文件不能还原，不让它挡住对话回退
  }
}

/** 记一条写前快照；同一轮同一路径只记第一次（那才是这一轮开始前的状态）。 */
export async function recordFileCheckpoint(
  projectId: string,
  sessionId: string,
  entry: Omit<FileCheckpoint, "at">,
): Promise<void> {
  const list = await loadFileCheckpoints(projectId, sessionId);
  if (list.some((c) => c.seq === entry.seq && c.path === entry.path)) return;
  list.push({ ...entry, at: Date.now() });
  await writeAtomic(checkpointFile(projectId, sessionId), `${JSON.stringify(list)}\n`);
}

/** 回退后丢掉目标及之后的账：seq 会被新分支复用，旧账留着会还原错东西。 */
export async function dropFileCheckpointsFrom(
  projectId: string,
  sessionId: string,
  targetSeq: number,
): Promise<void> {
  const list = await loadFileCheckpoints(projectId, sessionId);
  const keep = list.filter((c) => c.seq < targetSeq);
  await writeAtomic(checkpointFile(projectId, sessionId), `${JSON.stringify(keep)}\n`);
}
