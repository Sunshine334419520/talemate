/**
 * 投影：把一条 canonical 事件日志折成**只读**的视图——消息历史、span 树、会话统计。
 *
 * 它们都不落盘、也都不回写：同一份事件按同一套规则再折一次，结果必须一样。这条纪律是"单一真源"
 * 唯一能验证的形式——如果某个数字只能从别处得来，那它就是第二份真相。
 *
 * 三个投影的共同点：不猜、不修补。事件缺一段（被中断），投影如实反映（未闭合的 span 标 error），
 * 而不是替它编一个结束时间。
 *
 * 边界：纯函数，只吃事件、吐视图；不读文件、不认识 Session。
 */
import type { StoredMessage } from "../core/types";
import { isMessageEvent } from "./events";
import type { AnyTraceEvent } from "./events";

/** 消息投影：旧会话种子、三种消息事件、回退。 */
export function projectMessages(events: AnyTraceEvent[]): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const event of events) {
    if (event.type === "session/rewind") {
      // 回退只遮住历史，不删除事件：目标及其之后的段落从投影里消失，日志仍然完整
      const kept = messages.filter((m) => m.seq < event.data.targetSeq);
      messages.length = 0;
      messages.push(...kept);
      continue;
    }
    if (!isMessageEvent(event)) continue;
    if (event.type === "session/seed") messages.push(...event.data.messages);
    else messages.push(event.data.message);
  }
  return messages;
}

export type SpanName = "invoke_agent" | "chat" | "execute_tool" | "compaction";

/**
 * 一段有始有终的执行。它是**查询视图**，不是记录：同一条日志能折出任意多份，删掉重算不会丢东西。
 *
 * `spanId` 由起始事件的 seq 派生——不用随机 id，重放/重开时它才是同一个。
 */
export interface Span {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: SpanName;
  startMs: number;
  durationMs: number;
  status: "ok" | "error";
  attrs: Record<string, string | number | boolean>;
  error?: { type: string };
}

type OpenSpan = { span: Span; seq: number };

function open(
  seq: number,
  traceId: string,
  name: SpanName,
  startMs: number,
  parentId: string | undefined,
  attrs: Record<string, string | number | boolean>,
): OpenSpan {
  return {
    seq,
    span: {
      traceId,
      spanId: `${name}:${seq}`,
      ...(parentId === undefined ? {} : { parentId }),
      name,
      startMs,
      durationMs: 0,
      status: "ok",
      attrs,
    },
  };
}

/** 用事件里量好的耗时收尾；没有就用时间差。 */
function close(
  target: OpenSpan,
  at: number,
  measuredMs: number | undefined,
  status: "ok" | "error",
  errorType?: string,
): Span {
  target.span.durationMs = measuredMs ?? Math.max(0, at - target.span.startMs);
  target.span.status = status;
  if (errorType !== undefined) target.span.error = { type: errorType };
  return target.span;
}

/** 工具挂到发起它的那次模型请求下；没有步号（harness 代执行）就挂到轮。 */
function stepParent(
  step: number | undefined,
  ids: Map<number, string>,
  turn: OpenSpan | undefined,
): string | undefined {
  if (step !== undefined) {
    const id = ids.get(step);
    if (id !== undefined) return id;
  }
  return turn?.span.spanId;
}

/**
 * 事件 → span 树：
 *
 * ```text
 * turn/start + turn/end          → invoke_agent（挂载一轮）
 *   step/start + step/end        → chat（一次模型请求）
 *     tool/call + tool/result    → execute_tool
 *   compaction/start + end       → compaction
 * ```
 *
 * 没闭合的段（进程被杀、请求抛错）在日志末尾补一个 `status: "error"` 且 `incomplete: true` 的 span。
 * 不补的话，这类失败在视图里完全消失——而它们正是排查时最想看的。
 */
export function projectSpans(events: AnyTraceEvent[]): Span[] {
  const traceId = events[0]?.sessionId ?? "";
  const spans: Span[] = [];
  let turn: OpenSpan | undefined;
  let step: OpenSpan | undefined;
  /** 这一轮里 step 号 → spanId。step/end 先于工具执行落日志，所以工具靠这个号认父，不靠"当前开着的是谁" */
  const stepIds = new Map<number, string>();
  const tools = new Map<string, OpenSpan>();
  let compaction: OpenSpan | undefined;
  let lastTime = 0;

  for (const event of events) {
    lastTime = Math.max(lastTime, event.time);
    switch (event.type) {
      case "turn/start":
        stepIds.clear();
        turn = open(event.seq, traceId, "invoke_agent", event.time, undefined, {
          agent: event.data.agent,
          resumed: event.data.resumed,
        });
        break;
      case "turn/end": {
        if (turn === undefined) break;
        const status = event.data.status === "completed" ? "ok" : "error";
        turn.span.attrs["turn.status"] = event.data.status;
        spans.push(close(turn, event.time, event.data.durationMs, status, status === "error" ? event.data.status : undefined));
        turn = undefined;
        break;
      }
      case "step/start":
        step = open(event.seq, traceId, "chat", event.time, turn?.span.spanId, { step: event.data.step });
        stepIds.set(event.data.step, step.span.spanId);
        break;
      case "step/end": {
        if (step === undefined) break;
        const failed = event.data.finish === "error";
        step.span.attrs["step.finish"] = event.data.finish;
        if (event.data.usage !== undefined) {
          step.span.attrs["usage.input"] = event.data.usage.input;
          step.span.attrs["usage.output"] = event.data.usage.output;
        }
        spans.push(close(step, event.time, event.data.durationMs, failed ? "error" : "ok", failed ? "step_error" : undefined));
        step = undefined;
        break;
      }
      case "tool/call":
        tools.set(
          event.data.callId,
          open(event.seq, traceId, "execute_tool", event.time, stepParent(event.data.step, stepIds, turn), {
            "tool.name": event.data.name,
            "tool.input_chars": event.data.inputChars,
          }),
        );
        break;
      case "tool/result": {
        const target = tools.get(event.data.callId);
        if (target === undefined) break;
        const failed = event.data.state !== "completed";
        target.span.attrs["tool.state"] = event.data.state;
        target.span.attrs["tool.output_chars"] = event.data.outputChars;
        spans.push(close(target, event.time, event.data.durationMs, failed ? "error" : "ok", failed ? event.data.state : undefined));
        tools.delete(event.data.callId);
        break;
      }
      case "compaction/start":
        compaction = open(event.seq, traceId, "compaction", event.time, turn?.span.spanId ?? step?.span.spanId, {
          model: event.data.model,
        });
        break;
      case "compaction/end": {
        if (compaction === undefined) break;
        compaction.span.attrs["compaction.compacted"] = event.data.compacted;
        spans.push(
          close(compaction, event.time, event.data.durationMs, event.data.ok ? "ok" : "error", event.data.ok ? undefined : "compaction_error"),
        );
        compaction = undefined;
        break;
      }
      default:
        break;
    }
  }

  // 走到日志末尾还开着的：进程被杀在两次事件之间。它们是真实发生过的失败，不能从视图里消失
  for (const openSpan of [compaction, ...tools.values(), step, turn]) {
    if (openSpan === undefined) continue;
    openSpan.span.attrs["incomplete"] = true;
    spans.push(close(openSpan, lastTime, undefined, "error", "incomplete"));
  }

  return spans.sort((a, b) => a.startMs - b.startMs || a.spanId.localeCompare(b.spanId));
}

/** 一份会话的账：从事件折出来的数字。界面、`/debug`、将来的 eval reader 读同一处。 */
export interface SessionStats {
  events: number;
  turns: number;
  completedTurns: number;
  failedTurns: number;
  abortedTurns: number;
  steps: number;
  /** 模型请求耗时合计（成功与失败都算，失败的那一步按它自己量的耗时） */
  llmMs: number;
  attemptsFailed: number;
  interruptions: number;
  toolCalls: number;
  toolErrors: number;
  toolMs: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
  messages: number;
  firstTime?: number;
  lastTime?: number;
}

export function projectStats(events: AnyTraceEvent[]): SessionStats {
  const stats: SessionStats = {
    events: events.length,
    turns: 0,
    completedTurns: 0,
    failedTurns: 0,
    abortedTurns: 0,
    steps: 0,
    llmMs: 0,
    attemptsFailed: 0,
    interruptions: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolMs: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    messages: 0,
  };

  for (const event of events) {
    stats.firstTime ??= event.time;
    stats.lastTime = event.time;
    switch (event.type) {
      case "turn/start":
        stats.turns++;
        break;
      case "turn/end":
        if (event.data.status === "completed") stats.completedTurns++;
        else if (event.data.status === "aborted") stats.abortedTurns++;
        else stats.failedTurns++;
        break;
      case "step/start":
        stats.steps++;
        break;
      case "step/end":
        stats.llmMs += event.data.durationMs;
        if (event.data.usage !== undefined) {
          stats.inputTokens += event.data.usage.input;
          stats.outputTokens += event.data.usage.output;
        }
        break;
      case "assistant/attempt":
        stats.attemptsFailed++;
        if (event.data.outcome === "interrupted") stats.interruptions++;
        break;
      case "tool/call":
        stats.toolCalls++;
        break;
      case "tool/result":
        if (event.data.state !== "completed") stats.toolErrors++;
        stats.toolMs += event.data.durationMs;
        break;
      case "compaction/end":
        if (event.data.compacted) stats.compactions++;
        break;
      default:
        break;
    }
  }

  stats.messages = projectMessages(events).length;
  return stats;
}
