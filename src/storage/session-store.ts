/**
 * 会话级存储：session.json（元信息）+ events.jsonl（canonical 事件日志）。
 *
 * 真源只有 events.jsonl 一条：消息是它折出来的投影，内存里缓存（`Session.cache`），
 * **不再落 messages 文件**。打开会话折一次、之后增量 push；冷读（`loadMessages`）现场折。
 * 一次 fold 的成本是 O(事件数)，换来的是只有一份可写历史。
 *
 * 回退不改写事件日志（它只追加）：追加一条 `session/rewind`，投影据此丢掉目标之后的段落；
 * 改动索引也追加一条墓碑（见 `change_index.ts`）。
 *
 * 供模型上下文时用 loadModelWindow 取"最新 compaction 之后的 seq"。compaction 也是一条消息。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { talemateHome, projectPaths, sessionPaths } from "../core/config";
import type { MessageRole, PendingAskRecord, SessionMeta, StoredMessage } from "../core/types";
import { readText, writeAtomic } from "./atomic";
import { touch } from "./util";
import { appendChangeRewind } from "./change_index";
import { eventLogFor } from "../telemetry/log";
import { projectMessages } from "../telemetry/projection";
import type { MessageEventType } from "../telemetry/events";

/** 消息角色 → 事件类型。`system` 不在其中：它是每轮现拼的，从不落成会话消息。 */
function messageEventType(role: MessageRole): Exclude<MessageEventType, "session/seed"> {
  switch (role) {
    case "user":
      return "user/message";
    case "assistant":
      return "assistant/message";
    case "compaction":
      return "compaction/summary";
    case "system":
      // 它每轮由 buildSystem 现拼，从不落成会话消息；真写了说明有人绕过了那条边界
      throw new Error("system 消息不进会话日志");
  }
}

export async function createSession(
  projectId: string,
  meta: Omit<SessionMeta, "time">,
): Promise<SessionMeta> {
  const sp = sessionPaths(talemateHome(), projectId, meta.id);
  await mkdir(sp.dir, { recursive: true });
  const full: SessionMeta = { ...meta, time: { created: Date.now(), updated: Date.now() } };
  await writeFile(sp.meta, JSON.stringify(full, null, 2), "utf-8");
  await touch(sp.events);
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
 * 就地回退：事件追加 `session/rewind`，改动索引追加墓碑；返回留下的条数。
 *
 * 历史本身不删，只是被投影遮住，所以没有东西需要备份。目标消息本身也裁掉——它的文本由外壳
 * 回填输入框，用户改完重发；留在上下文里会让模型把"已经撤回的那句话"再答一遍。
 */
export async function truncateMessagesBefore(
  projectId: string,
  sessionId: string,
  targetSeq: number,
): Promise<number> {
  const log = eventLogFor(projectId, sessionId);
  await log.append("session/rewind", { targetSeq });
  await appendChangeRewind(projectId, sessionId, targetSeq);
  return projectMessages(await log.read()).length;
}

/**
 * 追加一条消息，返回带 seq 的完整消息。seq 按投影里最后一条 +1，回退后可以复用序号。
 *
 * `opts.seq` 给热路径用：Session 手里有内存缓存，直接把尾 seq +1 传进来，省掉一次全量折。
 * 冷调用方（压缩、迟到回答）不传，这里现场折一份——它们本来就不频繁。
 */
export async function appendMessage(
  projectId: string,
  sessionId: string,
  msg: Omit<StoredMessage, "seq" | "ts">,
  opts: { seq?: number } = {},
): Promise<StoredMessage> {
  const log = eventLogFor(projectId, sessionId);
  const seq = opts.seq ?? (projectMessages(await log.read()).at(-1)?.seq ?? 0) + 1;
  const full: StoredMessage = { ...msg, seq, ts: Date.now() };
  await log.append(messageEventType(msg.role), { message: full });
  return full;
}

/**
 * 追加一条用量。只动 `usage`，其余字段原样带过去——`createSession` 会把整份元信息重写一遍
 * （`time.created` 也重置），拿它来记用量会连别的字段一起弄丢。
 *
 * 它是界面读的聚合缓存，不是历史：同一次用量已经随 `step/end` 进了事件日志。
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

/** 读会话全部消息（保序）。事件日志是唯一来源，这里现场折一份；打开着的会话用 `Session.cache` 折一次。 */
export async function loadMessages(projectId: string, sessionId: string): Promise<StoredMessage[]> {
  return projectMessages(await eventLogFor(projectId, sessionId).read());
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
