/**
 * "回退对话和文件"的文件半边：按检查点计划并执行还原。
 *
 * 回退目标是某条用户消息 seq；凡 `checkpoint.seq >= target` 的写都属于被撤回的那一段。
 * 同一路径可能被连续写多次，只取**最早**那条的 `before`——那才是这一段开始前的状态。
 *
 * 还原是显式动作，不自动发生；失败时先把自己已改的文件回滚，再抛错，对话回退也随之不发生。
 * 外部进程在计划与落盘之间改了同一个文件时，CAS 会让那一个文件失败并整体回滚。
 */
import type { FileCheckpoint } from "../storage/file-history";
import { loadFileCheckpoints } from "../storage/file-history";
import { readText, removeIfUnchanged, writeIfUnchanged } from "../storage/atomic";
import { docAbs } from "../storage/corpus";

export type FileRewindAction = "restore" | "delete";

export interface FileRewindItem {
  path: string;
  action: FileRewindAction;
  /** 写前内容；action=delete 时为 null */
  before: string | null;
}

export interface FileRewindPreview {
  items: { path: string; action: FileRewindAction }[];
}

export interface FileRewindOutcome {
  restored: string[];
  deleted: string[];
}

/** 从检查点计划出每个路径要还原成什么；同一路径取最早一条。 */
function plan(checkpoints: FileCheckpoint[], targetSeq: number): FileRewindItem[] {
  const sorted = checkpoints
    .filter((c) => c.seq >= targetSeq)
    .sort((a, b) => a.seq - b.seq || a.at - b.at);
  const first = new Map<string, FileCheckpoint>();
  for (const c of sorted) if (!first.has(c.path)) first.set(c.path, c);
  return [...first.values()].map((c) => ({
    path: c.path,
    action: c.before === null ? "delete" : "restore",
    before: c.before,
  }));
}

/** 给确认框看的清单：只报路径和动作，不把文件内容送到渲染层。 */
export async function previewFileRewind(
  projectId: string,
  sessionId: string,
  targetSeq: number,
): Promise<FileRewindPreview> {
  const checkpoints = await loadFileCheckpoints(projectId, sessionId);
  return { items: plan(checkpoints, targetSeq).map(({ path, action }) => ({ path, action })) };
}

async function rollback(applied: { abs: string; current: string | null }[]): Promise<void> {
  for (const a of [...applied].reverse()) {
    try {
      const now = (await readText(a.abs)) ?? null;
      if (a.current === null) {
        if (now !== null) await removeIfUnchanged({ abs: a.abs, expected: now });
      } else if (now !== a.current) {
        await writeIfUnchanged({ abs: a.abs, expected: now ?? null, content: a.current });
      }
    } catch {
      // 回滚是尽力而为：原错误更重要，不能被回滚的二次失败盖掉
    }
  }
}

/**
 * 执行文件还原。成功返回改了哪些文件；失败先回滚已改的，再抛错——调用方据此决定
 * 不撤回对话。检查点由调用方在成功后清理（对话和文件两条路都要清）。
 */
export async function restoreFilesForRewind(
  projectId: string,
  sessionId: string,
  targetSeq: number,
): Promise<FileRewindOutcome> {
  const checkpoints = await loadFileCheckpoints(projectId, sessionId);
  const items = plan(checkpoints, targetSeq);
  const applied: { abs: string; current: string | null }[] = [];
  const restored: string[] = [];
  const deleted: string[] = [];

  try {
    for (const item of items) {
      const abs = docAbs(projectId, item.path);
      if (abs === undefined) throw new Error(`路径不在可还原的根下：${item.path}`);
      const current = (await readText(abs)) ?? null; // 原样读，含 BOM；还原要逐字节忠实
      if (item.action === "delete") {
        if (current === null) continue;
        await removeIfUnchanged({ abs, expected: current });
        applied.push({ abs, current });
        deleted.push(item.path);
      } else {
        if (current === item.before) continue;
        await writeIfUnchanged({ abs, expected: current ?? null, content: item.before as string });
        applied.push({ abs, current });
        restored.push(item.path);
      }
    }
  } catch (e) {
    await rollback(applied);
    throw new Error(
      `文件还原失败：${e instanceof Error ? e.message : String(e)}（已回滚本次已还原的文件）`,
    );
  }

  return { restored, deleted };
}
