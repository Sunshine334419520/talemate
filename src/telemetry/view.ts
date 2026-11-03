/**
 * 事件级视图模型：把 canonical 事件折成 turn → step → attempt / tool 的树。
 *
 * 与 `projection.ts` 的分工：那边折的是"会话内容"（messages / spans / stats），这边折的是
 * "一次排查要看的过程"——每一步发了什么请求、失败在哪、工具什么时候开始、压缩和回退发生在哪。
 * 它**不读 messages**，所以失败/中止的请求、没有结果的工具调用也都还在。
 *
 * 边界：纯函数，只吃事件；不读文件、不认识 Session。桌面轨迹 UI 将来从它渲染。
 */
import type { ToolState } from "../core/types";
import type { AnyTraceEvent, TraceError, TraceEventData, TraceUsage } from "./events";

export type TraceStepStatus = "open" | "ok" | "error" | "interrupted";
export type TraceTurnStatus = "open" | "completed" | "error" | "aborted";

export interface TraceToolView {
  callId: string;
  name: string;
  /** 发起它的 step；undefined = harness 代模型执行（例如 apply-design） */
  step?: number;
  state: ToolState;
  at: number;
  inputChars: number;
  outputChars?: number;
  durationMs?: number;
  error?: string;
  change?: { path: string; kind: string };
}

export interface TraceAttemptView {
  outcome: "error" | "interrupted";
  at: number;
  durationMs: number;
  streamedChars: number;
  error: TraceError;
}

export interface TraceStepView {
  /** 本轮内的步号（从 0 起，和 `step/start` 的 step 一致） */
  index: number;
  status: TraceStepStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  finish?: TraceEventData["step/end"]["finish"];
  usage?: TraceUsage;
  /** 轻量 header：不把完整 tools schema 复制进过程树；请求详情按需从事件折叠 */
  request?: Omit<TraceEventData["request/header"], "tools">;
  /** 该步 request/header 事件的 seq，供请求详情按需折叠 */
  requestSeq?: number;
  attempts: TraceAttemptView[];
  tools: TraceToolView[];
}

export interface TraceCompactionView {
  at: number;
  model?: string;
  endedAt?: number;
  durationMs?: number;
  ok?: boolean;
  compacted?: boolean;
}

export interface TraceTurnView {
  index: number;
  agent: string;
  resumed: boolean;
  startedAt: number;
  endedAt?: number;
  status: TraceTurnStatus;
  error?: TraceError;
  steps: TraceStepView[];
  /** 没有 step 的工具（harness 直接执行） */
  tools: TraceToolView[];
  compactions: TraceCompactionView[];
}

export interface TraceRewindView {
  at: number;
  targetSeq: number;
}

export interface TraceModel {
  sessionId: string;
  startedAt?: number;
  model?: string;
  provider?: string;
  depth?: number;
  parentSessionId?: string;
  turns: TraceTurnView[];
  rewinds: TraceRewindView[];
}

function appendTool(tools: TraceToolView[], event: Extract<AnyTraceEvent, { type: "tool/call" }>): TraceToolView {
  const call: TraceToolView = {
    callId: event.data.callId,
    name: event.data.name,
    ...(event.data.step === undefined ? {} : { step: event.data.step }),
    state: "pending",
    at: event.time,
    inputChars: event.data.inputChars,
  };
  tools.push(call);
  return call;
}

function findTool(tools: TraceToolView[], callId: string): TraceToolView | undefined {
  return tools.find((tool) => tool.callId === callId);
}

export function buildTraceModel(events: readonly AnyTraceEvent[]): TraceModel {
  const model: TraceModel = { sessionId: events[0]?.sessionId ?? "", turns: [], rewinds: [] };
  let turn: TraceTurnView | undefined;
  let step: TraceStepView | undefined;

  const ensureTurn = (): TraceTurnView | undefined => turn;
  const ensureStep = (index: number): TraceStepView | undefined => {
    if (turn === undefined) return undefined;
    let found = turn.steps.find((s) => s.index === index);
    if (found === undefined) {
      found = { index, status: "open", startedAt: 0, attempts: [], tools: [] };
      turn.steps.push(found);
    }
    return found;
  };

  for (const event of events) {
    switch (event.type) {
      case "session/start":
        model.startedAt = event.time;
        model.model = event.data.model;
        model.provider = event.data.provider;
        if (event.data.depth !== undefined) model.depth = event.data.depth;
        if (event.data.parentSessionId !== undefined) model.parentSessionId = event.data.parentSessionId;
        break;

      case "turn/start":
        turn = {
          index: model.turns.length,
          agent: event.data.agent,
          resumed: event.data.resumed,
          startedAt: event.time,
          status: "open",
          steps: [],
          tools: [],
          compactions: [],
        };
        model.turns.push(turn);
        step = undefined;
        break;

      case "turn/end":
        if (turn !== undefined) {
          turn.endedAt = event.time;
          turn.status = event.data.status;
          if (event.data.error !== undefined) turn.error = event.data.error;
        }
        step = undefined;
        break;

      case "step/start":
        step = ensureStep(event.data.step);
        if (step !== undefined) {
          step.startedAt = event.time;
          step.status = "open";
        }
        break;

      case "request/header":
        step = ensureStep(event.data.step);
        if (step !== undefined) {
          const { tools: _tools, ...header } = event.data;
          void _tools;
          step.request = header;
          step.requestSeq = event.seq;
        }
        break;

      case "system/prompt":
        // system 正文由请求详情按需读；过程树只保留 step 结构
        step = ensureStep(event.data.step);
        break;

      case "request/context":
        // 路由元数据由请求详情按需读事件，不塞进过程树
        break;

      case "step/end":
        step = ensureStep(event.data.step);
        if (step !== undefined) {
          step.endedAt = event.time;
          step.durationMs = event.data.durationMs;
          step.finish = event.data.finish;
          step.usage = event.data.usage;
          step.status = event.data.finish === "error" ? "error" : "ok";
        }
        break;

      case "assistant/attempt": {
        const target = ensureStep(event.data.step);
        if (target !== undefined) {
          target.attempts.push({
            outcome: event.data.outcome,
            at: event.time,
            durationMs: event.data.durationMs,
            streamedChars: event.data.streamedChars,
            error: event.data.error,
          });
          if (target.endedAt === undefined) {
            target.status = event.data.outcome === "interrupted" ? "interrupted" : "error";
            target.endedAt = event.time;
          }
        }
        break;
      }

      case "tool/call":
        if (event.data.step !== undefined) {
          const target = ensureStep(event.data.step);
          if (target !== undefined) appendTool(target.tools, event);
        } else if (ensureTurn() !== undefined) {
          appendTool(turn!.tools, event);
        }
        break;

      case "tool/result": {
        if (ensureTurn() === undefined) break;
        // tool/result 没有 step 字段（结果由 callId 对回来）。从最近一轮往前找，
        // 迟到的结果也不会被挂到新的一轮上；全找不到才补占位。
        let call: TraceToolView | undefined;
        for (let i = model.turns.length - 1; i >= 0 && call === undefined; i--) {
          const candidate = model.turns[i]!;
          call = findTool([...candidate.steps.flatMap((s) => s.tools), ...candidate.tools], event.data.callId);
        }
        if (call === undefined) {
          const placeholder: TraceToolView = {
            callId: event.data.callId,
            name: event.data.name,
            ...(step === undefined ? {} : { step: step.index }),
            state: "pending",
            at: event.time,
            inputChars: 0,
          };
          (step?.tools ?? turn!.tools).push(placeholder);
          call = placeholder;
        }
        call.state = event.data.state;
        call.outputChars = event.data.outputChars;
        call.durationMs = event.data.durationMs;
        if (event.data.error !== undefined) call.error = event.data.error;
        if (event.data.change !== undefined) call.change = event.data.change;
        break;
      }

      case "compaction/start":
        if (ensureTurn() !== undefined) {
          turn!.compactions.push({ at: event.time, model: event.data.model });
        }
        break;

      case "compaction/end": {
        const last = ensureTurn()?.compactions.at(-1);
        if (last !== undefined) {
          last.endedAt = event.time;
          last.durationMs = event.data.durationMs;
          last.ok = event.data.ok;
          last.compacted = event.data.compacted;
        }
        break;
      }

      case "session/rewind":
        model.rewinds.push({ at: event.time, targetSeq: event.data.targetSeq });
        break;

      // 消息类事件不参与过程视图；它们的内容由 messages 投影负责
      case "session/seed":
      case "user/message":
      case "assistant/message":
      case "compaction/summary":
        break;
    }
  }

  return model;
}
