/**
 * 改动索引：每个会话一份 `changes.jsonl`，按轮记下"哪个文件被改了、去哪取 diff"。
 *
 * 它是投影，不是账本：只存 `ChangePoint`（路径 / 类型 / 增删行数 + 指向 tool part 的指针），
 * **不存 diff**——diff 在事件的 `assistant/message` 里。删掉这份索引能由事件重算
 * （见 `session/change_history.ts` 的 rebuild）。
 *
 * 只追加：
 * - 一条改动一行 `{type:"change",…}`；
 * - 回退追加 `{type:"rewind",targetSeq}`。读取时**按文件顺序重放**：rewind 丢掉此前
 *   `turnSeq >= targetSeq` 的行，**之后追加的行照收**——回退后 seq 会被复用，不能拿 target
 *   去过滤整份文件，否则新分支会被旧墓碑一起埋掉。
 *
 * 边界：只管这一个文件的读写；不认识 Session、不折消息。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionPaths, talemateHome } from "../core/config";
import type { ChangePoint } from "../core/types";
import { writeAtomic } from "./atomic";

export interface ChangeRecord extends ChangePoint {
  type: "change";
  ts: number;
  /** 这一轮的第一条用户消息（截断）；本书视图的组头靠它，不为了这句话去折会话 */
  user: string;
}

export interface ChangeRewind {
  type: "rewind";
  targetSeq: number;
  ts: number;
}

export type ChangeIndexRecord = ChangeRecord | ChangeRewind;

/** 同一路径上的追加串行化：两次提交挨得近时，后一次不该把前一次的行插到中间。 */
const writes = new Map<string, Promise<void>>();

function indexPath(projectId: string, sessionId: string): string {
  return sessionPaths(talemateHome(), projectId, sessionId).changes;
}

async function appendRecords(path: string, records: ChangeIndexRecord[]): Promise<void> {
  if (records.length === 0) return;
  const prev = writes.get(path) ?? Promise.resolve();
  const run = prev.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
  });
  // 链上挂一个永不拒绝的哨兵：一次写失败不能毒住后面每一次追加
  const gate = run.then(
    () => {},
    () => {},
  );
  writes.set(path, gate);
  try {
    await run;
  } finally {
    if (writes.get(path) === gate) writes.delete(path);
  }
}

/** 追加一条改动一行。`ts` / `user` 由调用方给——提交那一刻才有这两个值。 */
export async function appendChanges(
  projectId: string,
  sessionId: string,
  points: readonly ChangePoint[],
  meta: { ts: number; user: string },
): Promise<void> {
  const records: ChangeRecord[] = points.map((p) => ({
    type: "change",
    ...p,
    ts: meta.ts,
    user: meta.user,
  }));
  await appendRecords(indexPath(projectId, sessionId), records);
}

/** 回退：追加墓碑，不重写文件。 */
export async function appendChangeRewind(
  projectId: string,
  sessionId: string,
  targetSeq: number,
): Promise<void> {
  await appendRecords(indexPath(projectId, sessionId), [
    { type: "rewind", targetSeq, ts: Date.now() },
  ]);
}

/**
 * 读这份会话的改动，已按墓碑裁过。坏行跳过——它是投影，没资格让历史视图打不开。
 */
export async function readChanges(projectId: string, sessionId: string): Promise<ChangeRecord[]> {
  const path = indexPath(projectId, sessionId);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }

  let rows: ChangeRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: ChangeIndexRecord;
    try {
      record = JSON.parse(line) as ChangeIndexRecord;
    } catch {
      continue; // 崩在半行上的尾行
    }
    if (record.type === "rewind") {
      // 只丢掉"这条墓碑之前"的旧分支；之后追加的新行保留
      rows = rows.filter((r) => r.turnSeq < record.targetSeq);
      continue;
    }
    if (record.type === "change") rows.push(record);
  }
  return rows;
}

/** 重建用：整份覆盖（墓碑一并清掉）。调用方保证这是从事件重算出来的完整列表。 */
export async function writeChanges(
  projectId: string,
  sessionId: string,
  records: readonly ChangeRecord[],
): Promise<void> {
  const text = records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  await writeAtomic(indexPath(projectId, sessionId), text);
}
