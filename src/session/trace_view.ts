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
import { projectSpans, projectStats } from "../telemetry/projection";
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
