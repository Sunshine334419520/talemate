/**
 * 跨会话 trace 索引 + 保留策略。
 *
 * 索引是读侧投影，不是第二份真源：`~/.../trace-index.json` 只缓存每个会话的摘要，
 * 以 events.jsonl 的 size/mtime 判定是否需要重扫；删掉缓存、重建，结果一样。
 *
 * 保留（retention）不偷偷删文件：`archiveTraces` 只把超过阈值的**整份会话目录**移到
 * `trace-index` 之外的 `archive/<projectId>/`；canonical 日志在归档里仍可回放。
 *
 * 边界：只读 projects / sessions / events；不读 messages，不触发模型。
 */
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { sessionPaths, talemateHome } from "../core/config";
import { readText, writeAtomic } from "../storage/atomic";
import { listProjects } from "../storage/project";
import { isSubagentSession, listSessionIds, loadSessionMeta } from "../storage/session-store";
import { eventLogFor, resetEventLogs } from "../telemetry/log";
import { projectStats } from "../telemetry/projection";
import { buildTraceModel } from "../telemetry/view";
import type { AnyTraceEvent, TurnStatus } from "../telemetry/events";
import type { ProjectMeta, SessionMeta } from "../core/types";

export type TraceSessionStatus = "open" | TurnStatus;

export interface TraceIndexEntry {
  projectId: string;
  projectTitle: string;
  sessionId: string;
  title: string;
  agent: string;
  model?: string;
  depth: number;
  parentSessionId?: string;
  startedAt: number;
  lastAt: number;
  status: TraceSessionStatus;
  turns: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  failedAttempts: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
  eventsPath: string;
}

export interface TraceFailureBucket {
  kind: "turn" | "request" | "tool";
  name: string;
  message: string;
  count: number;
  sessions: string[];
}

export interface TraceIndex {
  entries: TraceIndexEntry[];
  /** 过滤前的会话数（按 includeSubagents 计） */
  total: number;
  failures: TraceFailureBucket[];
  retention: { oldestAt?: number; newestAt?: number };
  /** 本次有多少会话命中了缓存、多少重新扫了日志 */
  cache?: { hit: number; miss: number };
}

export interface TraceIndexOptions {
  /** 只搜项目名 / 会话名 / agent / model / id；不扫事件正文 */
  query?: string;
  projectId?: string;
  since?: number;
  until?: number;
  limit?: number;
  includeSubagents?: boolean;
}

interface CacheSession {
  eventsSize: number;
  eventsMtimeMs: number;
  entry: TraceIndexEntry;
  failures: TraceFailureBucket[];
}

interface IndexCache {
  schemaVersion: 1;
  sessions: Record<string, CacheSession>;
}

const CACHE_SCHEMA = 1;

function cachePath(): string {
  return join(talemateHome(), "trace-index.json");
}

function cacheKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}

async function readCache(): Promise<IndexCache> {
  const raw = await readText(cachePath());
  if (raw === undefined) return { schemaVersion: CACHE_SCHEMA, sessions: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<IndexCache>;
    if (parsed.schemaVersion !== CACHE_SCHEMA || typeof parsed.sessions !== "object" || parsed.sessions === null) {
      return { schemaVersion: CACHE_SCHEMA, sessions: {} };
    }
    return { schemaVersion: CACHE_SCHEMA, sessions: parsed.sessions };
  } catch {
    return { schemaVersion: CACHE_SCHEMA, sessions: {} };
  }
}

async function writeCache(cache: IndexCache): Promise<void> {
  await writeAtomic(cachePath(), `${JSON.stringify(cache)}\n`);
}

/** 归档/手工清理后让下一次索引重建；缓存本身不是真源，删掉不丢历史。 */
export async function clearTraceIndexCache(): Promise<void> {
  await writeAtomic(cachePath(), `${JSON.stringify({ schemaVersion: CACHE_SCHEMA, sessions: {} })}\n`);
}

function matches(entry: TraceIndexEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [entry.projectTitle, entry.title, entry.agent, entry.model ?? "", entry.projectId, entry.sessionId]
    .some((value) => value.toLowerCase().includes(q));
}

function lastStatus(events: readonly AnyTraceEvent[]): TraceSessionStatus {
  const model = buildTraceModel(events);
  return model.turns.at(-1)?.status ?? "open";
}

interface FailureAccumulator {
  kind: TraceFailureBucket["kind"];
  name: string;
  message: string;
  sessions: Set<string>;
  count: number;
}

function addFailure(
  buckets: Map<string, FailureAccumulator>,
  kind: TraceFailureBucket["kind"],
  name: string,
  message: string,
  sessionId: string,
): void {
  const key = `${kind}\u0000${name}\u0000${message}`;
  const bucket = buckets.get(key) ?? { kind, name, message, sessions: new Set<string>(), count: 0 };
  bucket.count++;
  bucket.sessions.add(sessionId);
  buckets.set(key, bucket);
}

function indexEvents(
  project: ProjectMeta,
  meta: SessionMeta,
  sessionId: string,
  events: readonly AnyTraceEvent[],
): { entry: TraceIndexEntry; failures: TraceFailureBucket[] } {
  const stats = projectStats([...events]);
  const startedAt = events[0]?.time ?? meta.time.created;
  const lastAt = events.at(-1)?.time ?? meta.time.updated;
  const failures = new Map<string, FailureAccumulator>();
  for (const event of events) {
    if (event.type === "turn/end" && event.data.status !== "completed") {
      addFailure(failures, "turn", event.data.status, event.data.error?.message ?? event.data.status, sessionId);
    } else if (event.type === "assistant/attempt") {
      addFailure(failures, "request", event.data.outcome, event.data.error.message, sessionId);
    } else if (event.type === "tool/result" && event.data.state === "error") {
      addFailure(failures, "tool", event.data.name, event.data.error ?? "tool error", sessionId);
    }
  }
  return {
    entry: {
      projectId: project.id,
      projectTitle: project.title,
      sessionId,
      title: meta.title,
      agent: meta.agent,
      ...(meta.model === undefined ? {} : { model: meta.model.model }),
      depth: meta.depth ?? 0,
      ...(meta.parentSessionId === undefined ? {} : { parentSessionId: meta.parentSessionId }),
      startedAt,
      lastAt,
      status: lastStatus(events),
      turns: stats.turns,
      steps: stats.steps,
      toolCalls: stats.toolCalls,
      toolErrors: stats.toolErrors,
      failedAttempts: stats.attemptsFailed,
      compactions: stats.compactions,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      eventsPath: sessionPaths(talemateHome(), project.id, sessionId).events,
    },
    failures: [...failures.values()].map((bucket) => ({ ...bucket, sessions: [...bucket.sessions] })),
  };
}

let queue: Promise<void> = Promise.resolve();

async function buildIndex(options: TraceIndexOptions): Promise<TraceIndex> {
  const cache = await readCache();
  const nextCache: IndexCache = { schemaVersion: CACHE_SCHEMA, sessions: {} };
  const projects = (await listProjects()).filter(
    (project) => options.projectId === undefined || project.id === options.projectId,
  );
  const all: TraceIndexEntry[] = [];
  let hit = 0;
  let miss = 0;

  for (const project of projects) {
    for (const sessionId of await listSessionIds(project.id)) {
      let meta: SessionMeta;
      try {
        meta = await loadSessionMeta(project.id, sessionId);
      } catch {
        continue; // session.json 损坏：跳过，不拖垮整个索引
      }
      const eventsPath = sessionPaths(talemateHome(), project.id, sessionId).events;
      let fileStat;
      try {
        fileStat = await stat(eventsPath);
      } catch {
        continue; // 没有事件文件的会话不进索引
      }
      if (fileStat.size === 0) continue;

      const key = cacheKey(project.id, sessionId);
      const cached = cache.sessions[key];
      const canReuse =
        cached !== undefined &&
        cached.eventsSize === fileStat.size &&
        cached.eventsMtimeMs === fileStat.mtimeMs;
      let indexed: { entry: TraceIndexEntry; failures: TraceFailureBucket[] };
      if (canReuse) {
        hit++;
        indexed = cached;
      } else {
        miss++;
        const events = await eventLogFor(project.id, sessionId).read();
        if (events.length === 0) continue;
        indexed = indexEvents(project, meta, sessionId, events);
      }

      // 标题/agent/model 可能在没有新事件时被改：用当前 meta/project 覆盖摘要字段
      const entry: TraceIndexEntry = {
        ...indexed.entry,
        projectTitle: project.title,
        title: meta.title,
        agent: meta.agent,
        ...(meta.model === undefined ? { model: undefined } : { model: meta.model.model }),
        depth: meta.depth ?? 0,
        ...(meta.parentSessionId === undefined ? { parentSessionId: undefined } : { parentSessionId: meta.parentSessionId }),
        eventsPath,
      };
      nextCache.sessions[key] = {
        eventsSize: fileStat.size,
        eventsMtimeMs: fileStat.mtimeMs,
        entry,
        failures: indexed.failures,
      };
      all.push(entry);
    }
  }

  // 被删掉的会话/项目从缓存里清掉
  if (JSON.stringify(cache.sessions) !== JSON.stringify(nextCache.sessions)) await writeCache(nextCache);

  const candidates = options.includeSubagents === true
    ? all
    : all.filter((entry) =>
        !isSubagentSession({ depth: entry.depth, parentSessionId: entry.parentSessionId, title: entry.title }),
      );
  const total = candidates.length;
  const failures = new Map<string, FailureAccumulator>();
  const entries: TraceIndexEntry[] = [];
  for (const entry of candidates) {
    if (options.since !== undefined && entry.lastAt < options.since) continue;
    if (options.until !== undefined && entry.startedAt > options.until) continue;
    if (!matches(entry, options.query ?? "")) continue;
    entries.push(entry);
    const cached = nextCache.sessions[cacheKey(entry.projectId, entry.sessionId)];
    for (const failure of cached?.failures ?? []) {
      for (const session of failure.sessions) {
        addFailure(failures, failure.kind, failure.name, failure.message, session);
      }
    }
  }

  entries.sort((a, b) => b.lastAt - a.lastAt);
  const oldestAt = entries.length === 0 ? undefined : Math.min(...entries.map((entry) => entry.startedAt));
  const newestAt = entries.length === 0 ? undefined : Math.max(...entries.map((entry) => entry.lastAt));
  const limited = options.limit === undefined ? entries : entries.slice(0, options.limit);

  return {
    entries: limited,
    total,
    failures: [...failures.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((bucket) => ({ ...bucket, sessions: [...bucket.sessions] })),
    retention: {
      ...(oldestAt === undefined ? {} : { oldestAt }),
      ...(newestAt === undefined ? {} : { newestAt }),
    },
    cache: { hit, miss },
  };
}

export function buildTraceIndex(options: TraceIndexOptions = {}): Promise<TraceIndex> {
  const run = queue.then(() => buildIndex(options));
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

export interface TraceArchiveOptions {
  /** 只归档 lastAt 早于 now - days 的会话 */
  olderThanDays: number;
  dryRun?: boolean;
  projectId?: string;
  /** 测试注入固定现在；缺省 Date.now() */
  now?: number;
  /** 不归档这些会话（例如当前正开着的会话） */
  excludeSessionIds?: readonly string[];
}

export interface TraceArchiveResult {
  cutoff: number;
  dryRun: boolean;
  archived: { projectId: string; sessionId: string; from: string; to: string }[];
  skipped: { projectId: string; sessionId: string; reason: string }[];
}

/**
 * 显式归档旧会话：整份会话目录移到 `<home>/archive/<projectId>/`。
 * 不删 events.jsonl，不裁剪活跃会话；索引缓存随后清空，下一次重建会自然排除。
 */
export async function archiveTraces(options: TraceArchiveOptions): Promise<TraceArchiveResult> {
  if (!Number.isFinite(options.olderThanDays) || options.olderThanDays < 0) {
    throw new Error("olderThanDays 必须是非负数");
  }
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanDays * 86_400_000;
  const index = await buildTraceIndex({
    includeSubagents: true,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
  });
  const result: TraceArchiveResult = {
    cutoff,
    dryRun: options.dryRun === true,
    archived: [],
    skipped: [],
  };

  const excluded = new Set(options.excludeSessionIds ?? []);
  for (const entry of index.entries) {
    if (excluded.has(entry.sessionId) || entry.lastAt >= cutoff) continue;
    const from = sessionPaths(talemateHome(), entry.projectId, entry.sessionId).dir;
    const to = join(
      talemateHome(),
      "archive",
      entry.projectId,
      `${entry.sessionId}-${now}`,
    );
    if (result.dryRun) {
      result.archived.push({ projectId: entry.projectId, sessionId: entry.sessionId, from, to });
      continue;
    }
    try {
      await mkdir(join(talemateHome(), "archive", entry.projectId), { recursive: true });
      await rename(from, to);
      result.archived.push({ projectId: entry.projectId, sessionId: entry.sessionId, from, to });
    } catch (err) {
      result.skipped.push({
        projectId: entry.projectId,
        sessionId: entry.sessionId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!result.dryRun && result.archived.length > 0) {
    await clearTraceIndexCache();
    resetEventLogs();
  }
  return result;
}
