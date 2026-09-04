/**
 * 会话级存储：session.json（元信息）+ messages.jsonl（append-only，每条带 seq）。
 * compaction 也是一条消息。供模型上下文时用 loadModelWindow 取"最新 compaction 之后的 seq"。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { talemateHome, paths, projectPaths, sessionPaths } from "../core/config";
import type { SessionMeta, StoredMessage } from "../core/types";
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

/** 读会话全部消息（保序）。无会话文件时返回 []。 */
export async function loadMessages(projectId: string, sessionId: string): Promise<StoredMessage[]> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  const lines = await readLines(sp.messages);
  return lines
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StoredMessage)
    .sort((a, b) => a.seq - b.seq);
}

/** 供模型上下文：compaction 消息 + 其后的全部消息（§8：上下文=最新 compaction 之后的 seq） */
export function loadModelWindow(messages: StoredMessage[]): StoredMessage[] {
  let from = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "compaction") from = i;
  }
  return messages.slice(from);
}
