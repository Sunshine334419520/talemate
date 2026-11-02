/**
 * 跨会话 trace 索引：把每份会话的 events.jsonl 折成一行可排序/搜索的摘要，并聚合失败。
 *
 * 为什么不在写入时另建索引：事件日志已经是唯一真源，索引只是读侧投影（与 `projection.ts`
 * 同一条纪律）。删掉索引不会丢历史；重建的成本是扫一遍日志。
 *
 * 边界：只读 projects / sessions / events；不读 messages，不触发模型，不删除日志。
 * 保留/轮转是运维策略，不在这里偷偷删文件——这里只提供 since/until 读侧过滤。
 */
import { listProjects } from "../storage/project";
import { listSessionIds, loadSessionMeta, isSubagentSession } from "../storage/session-store";
import { eventLogFor } from "../telemetry/log";
import { projectStats } from "../telemetry/projection";
import { buildTraceModel } from "../telemetry/view";
import { sessionPaths, talemateHome } from "../core/config";
import type { AnyTraceEvent } from "../telemetry/events";
import type { TurnStatus } from "../telemetry/events";

export type TraceSessionStatus = "open" | TurnStatus;

export interface TraceIndexEntry {
  projectId: string;
  projectTitle: string;
  sessionId: string;
  title: string;
  agent: string;
  model?: string;
  depth: number;
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
  /** 过滤前的总会话数 */
  total: number;
  failures: TraceFailureBucket[];
  retention: { oldestAt?: number; newestAt?: number };
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

function matches(entry: TraceIndexEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [entry.projectTitle, entry.title, entry.agent, entry.model ?? "", entry.projectId, entry.sessionId]
    .some((value) => value.toLowerCase().includes(q));
}

function lastStatus(events: readonly AnyTraceEvent[]): TraceSessionStatus {
  const model = buildTraceModel(events);
  const last = model.turns.at(-1);
  if (last === undefined) return "open";
  return last.status;
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

/** 扫全部（或指定项目）的会话，返回按开始时间倒序的索引。 */
export async function buildTraceIndex(options: TraceIndexOptions = {}): Promise<TraceIndex> {
  const projects = (await listProjects()).filter(
    (project) => options.projectId === undefined || project.id === options.projectId,
  );
  const entries: TraceIndexEntry[] = [];
  const failures = new Map<string, FailureAccumulator>();
  let total = 0;

  for (const project of projects) {
    for (const sessionId of await listSessionIds(project.id)) {
      let meta;
      try {
        meta = await loadSessionMeta(project.id, sessionId);
      } catch {
        continue; // session.json 损坏：跳过，不拖垮整个索引
      }
      if (!options.includeSubagents && isSubagentSession(meta)) continue;

      const events = await eventLogFor(project.id, sessionId).read();
      if (events.length === 0) continue;
      total++;

      const stats = projectStats(events);
      const startedAt = events[0]?.time ?? meta.time.created;
      const lastAt = events.at(-1)?.time ?? meta.time.updated;
      if (options.since !== undefined && lastAt < options.since) continue;
      if (options.until !== undefined && startedAt > options.until) continue;

      const entry: TraceIndexEntry = {
        projectId: project.id,
        projectTitle: project.title,
        sessionId,
        title: meta.title,
        agent: meta.agent,
        ...(meta.model === undefined ? {} : { model: meta.model.model }),
        depth: meta.depth ?? 0,
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
      };
      if (!matches(entry, options.query ?? "")) continue;
      entries.push(entry);

      for (const event of events) {
        if (event.type === "turn/end" && event.data.status !== "completed") {
          addFailure(failures, "turn", event.data.status, event.data.error?.message ?? event.data.status, sessionId);
        } else if (event.type === "assistant/attempt") {
          addFailure(failures, "request", event.data.outcome, event.data.error.message, sessionId);
        } else if (event.type === "tool/result" && event.data.state === "error") {
          addFailure(failures, "tool", event.data.name, event.data.error ?? "tool error", sessionId);
        }
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
  };
}
