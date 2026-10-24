/**
 * 会话级存储：session.json（元信息）+ messages.jsonl（每条带 seq）。
 * 正常只追加；回退会先把整份日志备份到 `rewind-backups/`，再重写到目标消息之前。
 * compaction 也是一条消息。供模型上下文时用 loadModelWindow 取"最新 compaction 之后的 seq"。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { talemateHome, paths, projectPaths, sessionPaths } from "../core/config";
import type { PendingAskRecord, SessionMeta, StoredMessage } from "../core/types";
import { readText, writeAtomic } from "./atomic";
import { readLines, touch } from "./util";

export async function createSession(
  projectId: string,
  meta: Omit<SessionMeta, "time">,
): Promise<SessionMeta> {
  const sp = sessionPaths(talemateHome(), projectId, meta.id);
  await mkdir(sp.dir, { recursive: true });
  const full: SessionMeta = { ...meta, time: { created: Date.now(), updated: Date.now() } };
  await writeFile(sp.meta, JSON.stringify(full, null, 2), "utf-8");
  await touch(sp.messages);
  return full;
}

export async function loadSessionMeta(projectId: string, sessionId: string): Promise<SessionMeta> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  return JSON.parse(await readFile(sp.meta, "utf-8")) as SessionMeta;
}

export async function listSessionIds(projectId: string): Promise<string[]> {
  const dir = projectPaths(talemateHome(), projectId).sessions;
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * 这份会话是不是 `task` 派生的子会话。
 *
 * 子会话也落盘（轨迹与调试要能回看），但它不是一次用户会话：左栏与 `/sessions` 只列用户会话。
 * 判据是 `depth` / `parentSessionId` 这两个结构字段；`task:` 标题前缀只兜底旧数据——那时还没有这两个字段。
 */
export function isSubagentSession(
  meta: Pick<SessionMeta, "depth" | "parentSessionId" | "title"> | undefined,
): boolean {
  if (meta === undefined) return false;
  return (meta.depth ?? 0) > 0 || meta.parentSessionId !== undefined || meta.title.startsWith("task:");
}

/**
 * 回退前把**整份** messages.jsonl 备份到会话目录的 `rewind-backups/`，返回备份路径。
 *
 * 回退会重写 messages.jsonl（不是 append-only）——这是为了简单、可靠地做"就地回退"：
 * 不引入 surface/隐藏区间的模型。代价是日志不再是只追加的，所以先把原字节完整留一份。
 */
export async function backupMessages(projectId: string, sessionId: string): Promise<string | undefined> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  const raw = await readText(sp.messages);
  if (raw === undefined) return undefined;
  const dir = join(sp.dir, "rewind-backups");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `messages-${stamp}-${randomUUID().slice(0, 8)}.jsonl`);
  await writeAtomic(file, raw);
  return file;
}

/**
 * 就地回退：只保留 `seq < targetSeq` 的消息，返回留下的条数。
 *
 * 调用方必须先用 {@link backupMessages} 留底。目标消息本身也删——它的文本由外壳回填输入框，
 * 用户改完重发；留在上下文里会让模型把"已经撤回的那句话"再答一遍。
 */
export async function truncateMessagesBefore(
  projectId: string,
  sessionId: string,
  targetSeq: number,
): Promise<number> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  const all = await loadMessages(projectId, sessionId);
  const keep = all.filter((m) => m.seq < targetSeq);
  const text = keep.length === 0 ? "" : `${keep.map((m) => JSON.stringify(m)).join("\n")}\n`;
  await writeAtomic(sp.messages, text);
  return keep.length;
}

/** 追加一条消息，返回带 seq 的完整消息。seq 单调：读当前尾 seq +1。 */
export async function appendMessage(
  projectId: string,
  sessionId: string,
  msg: Omit<StoredMessage, "seq" | "ts">,
): Promise<StoredMessage> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  await mkdir(sp.dir, { recursive: true });
  const nonEmpty = (await readLines(sp.messages)).filter((l) => l.trim());
  const lastSeq = nonEmpty.length ? (JSON.parse(nonEmpty[nonEmpty.length - 1]) as StoredMessage).seq : 0;
  const full: StoredMessage = { ...msg, seq: lastSeq + 1, ts: Date.now() };
  await writeFile(
    sp.messages,
    (nonEmpty.length ? nonEmpty.join("\n") + "\n" : "") + JSON.stringify(full) + "\n",
    "utf-8",
  );
  return full;
}

/**
 * 追加一条用量。只动 `usage`，其余字段原样带过去——`createSession` 会把整份元信息重写一遍
 * （`time.created` 也重置），拿它来记用量会连别的字段一起弄丢。
 */
export async function appendUsage(
  projectId: string,
  sessionId: string,
  point: { input: number; output: number },
): Promise<void> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  let meta: SessionMeta;
  try {
    meta = JSON.parse(await readFile(sp.meta, "utf-8")) as SessionMeta;
  } catch {
    return; // 会话还没落元信息（刚开、还没存过）——下一轮再记
  }
  meta.usage = [...(meta.usage ?? []), point];
  meta.time = { ...meta.time, updated: Date.now() };
  await writeFile(sp.meta, JSON.stringify(meta, null, 2), "utf-8");
}

/** 读会话全部消息（保序）。无会话文件时返回 []。 */
export async function loadMessages(projectId: string, sessionId: string): Promise<StoredMessage[]> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  const lines = await readLines(sp.messages);
  return lines
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StoredMessage)
    .sort((a, b) => a.seq - b.seq);
}

/** 供模型上下文：最新 compaction 消息 + 其后的全部消息。 */
export function loadModelWindow(messages: StoredMessage[]): StoredMessage[] {
  let from = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "compaction") from = i;
  }
  return messages.slice(from);
}

/**
 * 未答提问的 write-ahead 记录。
 *
 * 为什么需要它：提问发生在工具执行中，而助手整条消息要等工具返回之后才落盘。这中间进程被杀，
 * 消息里既没有提问也没有答案，用户回来后无从回答。它只活在这段窗口里——助手消息一提交，
 * `openAsks` 就能从 tool part 投影出同一个问题，journal 随即清掉（见 `Session.hydrate`）。
 * 坏文件当没有：宁可丢一条未答问题，也不能让会话打不开。
 */
export async function savePendingAsk(
  projectId: string,
  sessionId: string,
  ask: PendingAskRecord,
): Promise<void> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  await writeAtomic(sp.pendingAsk, JSON.stringify(ask));
}

export async function loadPendingAsk(
  projectId: string,
  sessionId: string,
): Promise<PendingAskRecord | undefined> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  const raw = await readText(sp.pendingAsk);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as PendingAskRecord;
    if (typeof parsed.callId !== "string" || !Array.isArray(parsed.questions)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function clearPendingAsk(projectId: string, sessionId: string): Promise<void> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  await rm(sp.pendingAsk, { force: true });
}
