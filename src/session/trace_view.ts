/**
 * 轨迹视图：把 canonical 事件日志渲染成人能读的一页摘要，并把**脱敏后**的副本导出成 JSONL。
 *
 * 它只读事件、不写事件：摘要是投影（`projection.ts`），导出是副本（`redact.ts`）。canonical 日志
 * 永远不改写——本地账本要能完整回放，脱敏只发生在离开进程的那一份上。
 *
 * 边界：CLI 与将来的 eval reader 共用这里；不认识 Session，也不触发任何模型调用。
 */
import { join } from "node:path";
import { talemateHome, sessionPaths } from "../core/config";
import { writeAtomic } from "../storage/atomic";
import { eventLogFor } from "../telemetry/log";
import { projectPerception, projectSpans, projectStats } from "../telemetry/projection";
import type { Span, SpanName } from "../telemetry/projection";
import { redactEvents } from "../telemetry/redact";
import type { RedactionPolicy } from "../telemetry/redact";
import type { AnyTraceEvent } from "../telemetry/events";

function spanLabel(span: Span): string {
  const tool = span.attrs["tool.name"];
  const name = typeof tool === "string" ? `${span.name} ${tool}` : span.name;
  const error = span.error === undefined ? "" : `（${span.error.type}）`;
  const parent = span.parentId === undefined ? "" : ` ← ${span.parentId}`;
  return `${name}${error}${parent}`;
}

interface ContextWatermark {
  latest: { system: number; tools: number; messages: number; total: number };
  peak: number;
  compactions: {
    before: number;
    after: number;
    turns?: number;
    evidence?: number;
    droppedMessages?: number;
    toolResults?: number;
    degraded?: boolean;
  }[];
}

/**
 * 上下文水位只从 `request/header` 的三段字符数折，不另记事件。
 *
 * 压缩效果靠"压缩前最后一个请求"与"压缩后第一个请求"的 messages 对比：中间没有请求就不算，
 * 免得把没发出去的窗口当成已发生的下降。
 */
function contextWatermark(events: AnyTraceEvent[]): ContextWatermark | undefined {
  let latest: ContextWatermark["latest"] | undefined;
  let peak = 0;
  let before: number | undefined;
  let pending: number | undefined;
  let recorded = false;
  const compactions: ContextWatermark["compactions"] = [];
  for (const event of events) {
    if (event.type === "request/header") {
      const data = event.data;
      latest = {
        system: data.systemChars,
        tools: data.toolsChars,
        messages: data.messagesChars,
        total: data.systemChars + data.toolsChars + data.messagesChars,
      };
      peak = Math.max(peak, latest.total);
      if (pending !== undefined) {
        compactions.push({ before: pending, after: data.messagesChars });
        pending = undefined;
      }
      continue;
    }
    if (event.type === "compaction/start") {
      before = latest?.messages;
      recorded = false;
      continue;
    }
    if (event.type === "context/compaction") {
      // 记录自带进/出估算：比"压缩前后两次请求"更贴近这次折叠本身
      compactions.push({
        before: event.data.budget.before,
        after: event.data.budget.after,
        turns: event.data.consumed.turns,
        evidence: event.data.evidence.length,
        droppedMessages: event.data.dropped.messages,
        toolResults: event.data.dropped.toolResults,
        degraded: event.data.degraded,
      });
      recorded = true;
      continue;
    }
    if (event.type === "compaction/end" && event.data.ok && event.data.compacted && !recorded) {
      pending = before;
    }
  }
  return latest === undefined ? undefined : { latest, peak, compactions };
}

/** 一页摘要：发生了什么、花了多少、哪几段失败了。失败只列最近 5 条，全部可从事件里查。 */
export function renderTraceSummary(events: AnyTraceEvent[]): string {
  if (events.length === 0) return "（还没有事件：这个会话还没跑过一轮）";
  const stats = projectStats(events);
  const spans = projectSpans(events);
  const counts = new Map<SpanName, number>();
  for (const span of spans) counts.set(span.name, (counts.get(span.name) ?? 0) + 1);
  const failed = spans.filter((s) => s.status === "error").slice(-5);
  const at = (t: number | undefined) => (t === undefined ? "?" : new Date(t).toISOString());

  const lines = [
    `轨迹 · 会话 ${events[0].sessionId}`,
    `- 事件：${stats.events} 条（${at(stats.firstTime)} → ${at(stats.lastTime)}）`,
    `- 轮 ${stats.turns}（完成 ${stats.completedTurns} · 失败 ${stats.failedTurns} · 中止 ${stats.abortedTurns}） · 步 ${stats.steps} · 压缩 ${stats.compactions}`,
    `- 工具 ${stats.toolCalls}（失败 ${stats.toolErrors}） · 失败请求 ${stats.attemptsFailed}（其中中断 ${stats.interruptions}）`,
    `- 耗时：模型 ${stats.llmMs}ms / 工具 ${stats.toolMs}ms · token input ${stats.inputTokens} / output ${stats.outputTokens}`,
    `- span：${[...counts].map(([name, n]) => `${name} ${n}`).join(" · ") || "无"}`,
  ];
  const context = contextWatermark(events);
  const perception = projectPerception(events);
  if (perception.plans > 0) {
    const latest = perception.latest;
    if (latest !== undefined) {
      const m = latest.metrics;
      const budget = `${(latest.budget.used / 1000).toFixed(1)}k/${(latest.budget.ceiling / 1000).toFixed(1)}k`;
      lines.push(
        `- 感知：plan ${perception.plans} 次 · P0 覆盖 ${m.p0Coverage.toFixed(2)} · 延迟 ${m.deferred} · 丢弃 ${m.dropped}` +
          `（过期 ${m.stale} · 重复 ${m.duplicate} · 缺失 ${m.missing}）· 压缩比 ${m.compressionRatio.toFixed(2)} · 最近预算 ${budget}`,
      );
    }
  }
  if (context !== undefined) {
    const { latest, peak, compactions } = context;
    const last = compactions.at(-1);
    const drop =
      last === undefined || last.before === 0
        ? ""
        : `，最近折叠 ${last.turns ?? "?"} turn（丢 ${last.droppedMessages ?? "?"} 条 / ${last.toolResults ?? 0} 个工具结果，保留 ${last.evidence ?? 0} 条证据${last.degraded === true ? "，降级" : ""}）· messages ${last.before} → ${last.after}（${Math.round(((last.after - last.before) / last.before) * 100)}%）`;
    lines.push(
      `- 上下文：最新 ${latest.total} 字（system ${latest.system} + tools ${latest.tools} + messages ${latest.messages}） · 峰值 ${peak}${compactions.length > 0 ? ` · 已折叠 ${compactions.length} 次${drop}` : ""}`,
    );
  }
  if (failed.length) {
    lines.push("", "失败的段（最近 5 条）：");
    for (const span of failed) lines.push(`  · ${spanLabel(span)}`);
  }
  return lines.join("\n");
}

/** `/trace export` 不带路径时的落点：会话目录里，和 events.jsonl 并排。 */
export function defaultTraceExportPath(projectId: string, sessionId: string): string {
  return join(sessionPaths(talemateHome(), projectId, sessionId).dir, "trace-export.jsonl");
}

/** 桌面右栏要的一屏：摘要 + 事件日志路径。路径是给排查的人（或 agent）接着读原始日志用的。 */
export interface TraceView {
  summary: string;
  eventsPath: string;
}

export async function buildTraceView(projectId: string, sessionId: string): Promise<TraceView> {
  const events = await eventLogFor(projectId, sessionId).read();
  return {
    summary: renderTraceSummary(events),
    eventsPath: sessionPaths(talemateHome(), projectId, sessionId).events,
  };
}

export async function readTraceSummary(projectId: string, sessionId: string): Promise<string> {
  return (await buildTraceView(projectId, sessionId)).summary;
}

export interface TraceExportResult {
  path: string;
  written: number;
  dropped: number;
}

/**
 * 导出脱敏副本。返回写了几条、扣了几条——扣下的意思是"这条洗不干净"，不是"没有这条"。
 * 覆盖写是故意的：一份导出就是一次快照，不是追加账本。
 */
export async function exportTrace(
  projectId: string,
  sessionId: string,
  absPath = defaultTraceExportPath(projectId, sessionId),
  policy: RedactionPolicy = {},
): Promise<TraceExportResult> {
  const events = await eventLogFor(projectId, sessionId).read();
  const { events: redacted, dropped } = redactEvents(events, policy);
  const text = redacted.length === 0 ? "" : `${redacted.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await writeAtomic(absPath, text);
  return { path: absPath, written: redacted.length, dropped };
}
