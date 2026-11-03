/**
 * 轨迹记录投影：把 canonical 事件折成一张"人看的记录表"。
 *
 * 与 `view.ts` 的分工：`view.ts` 是结构树（turn/step/attempt/tool）；这里是**轨迹表的行**，
 * 把消息正文、system prompt、工具入参输出、压缩、失败尝试都放进同一条记录。DSH 的 Trajectory
 * 也是这个形状——消息不是单独的模式，只是记录的一种 kind。
 *
 * 边界：纯函数，只吃事件；不读文件、不认识 Session、不触发模型。
 */
import type { StoredMessage } from "../core/types";
import type { AnyTraceEvent } from "./events";

export type TrajectoryRecordKind = "system" | "user" | "assistant" | "tool" | "compaction" | "attempt" | "rewind";

export interface TrajectoryRecord {
  id: string;
  kind: TrajectoryRecordKind;
  seq?: number;
  at?: number;
  step?: number;
  status?: string;
  text?: string;
  reasoning?: string;
  toolName?: string;
  toolState?: string;
  input?: string;
  output?: string;
  error?: string;
  change?: { path: string; kind: string };
  durationMs?: number;
  /** 这一步模型请求的 usage（来自 step/end；只有 assistant 记录带） */
  inputTokens?: number;
  outputTokens?: number;
  /** 这一步模型请求的总耗时（来自 step/end） */
  stepMs?: number;
  model?: string;
  targetSeq?: number;
  requestSeq?: number;
}

export type TrajectoryTurnStatus = "open" | "completed" | "error" | "aborted";

export interface TrajectoryTurn {
  index: number;
  agent: string;
  resumed: boolean;
  startedAt: number;
  endedAt?: number;
  status: TrajectoryTurnStatus;
  records: TrajectoryRecord[];
}

export interface TrajectoryView {
  sessionId: string;
  startedAt?: number;
  model?: string;
  provider?: string;
  turns: TrajectoryTurn[];
}

function textOfMessage(message: StoredMessage): string {
  if (message.role === "compaction") return [message.summary, message.recent].filter(Boolean).join("\n\n");
  if (message.role === "assistant") {
    return (message.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }
  return message.text ?? "";
}

function reasoningOfMessage(message: StoredMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "reasoning")
    .map((part) => (part.type === "reasoning" ? part.text : ""))
    .join("");
}

export function buildTrajectory(events: readonly AnyTraceEvent[]): TrajectoryView {
  const view: TrajectoryView = { sessionId: events[0]?.sessionId ?? "", turns: [] };
  let turn: TrajectoryTurn | undefined;
  let step: number | undefined;
  let compaction: TrajectoryRecord | undefined;
  let serial = 0;
  const tools = new Map<string, TrajectoryRecord>();
  const requestSeqs = new Map<number, number>();
  const stepResults = new Map<number, { input?: number; output?: number; ms?: number }>();
  const attachRequestSeq = (record: TrajectoryRecord | undefined): void => {
    if (record !== undefined && record.step !== undefined && record.requestSeq === undefined) {
      record.requestSeq = requestSeqs.get(record.step);
    }
  };

  const nextId = (kind: TrajectoryRecordKind): string => `${kind}-${++serial}`;
  const add = (kind: TrajectoryRecordKind, data: Omit<TrajectoryRecord, "id" | "kind">): TrajectoryRecord | undefined => {
    if (turn === undefined) return undefined;
    const record: TrajectoryRecord = { id: nextId(kind), kind, ...data };
    attachRequestSeq(record);
    turn.records.push(record);
    return record;
  };

  for (const event of events) {
    switch (event.type) {
      case "session/start":
        view.startedAt = event.time;
        view.model = event.data.model;
        view.provider = event.data.provider;
        break;

      case "turn/start":
        turn = {
          index: view.turns.length,
          agent: event.data.agent,
          resumed: event.data.resumed,
          startedAt: event.time,
          status: "open",
          records: [],
        };
        view.turns.push(turn);
        step = undefined;
        compaction = undefined;
        requestSeqs.clear();
        break;

      case "turn/end":
        if (turn !== undefined) {
          turn.endedAt = event.time;
          turn.status = event.data.status;
          // 失败请求已经由 assistant/attempt 记录；turn/end 只收状态，不再补一条重复记录
        }
        turn = undefined;
        step = undefined;
        break;

      case "step/start":
        step = event.data.step;
        break;

      case "step/end": {
        const result = {
          ...(event.data.usage === undefined ? {} : { input: event.data.usage.input, output: event.data.usage.output }),
          ms: event.data.durationMs,
        };
        stepResults.set(event.data.step, result);
        // 消息可能在 step/end 之后才落盘；先把已经存在的 assistant 记录补上
        for (const record of turn?.records ?? []) {
          if (record.kind !== "assistant" || record.step !== event.data.step) continue;
          if (result.input !== undefined) record.inputTokens = result.input;
          if (result.output !== undefined) record.outputTokens = result.output;
          record.stepMs = result.ms;
        }
        break;
      }

      case "request/header":
        requestSeqs.set(event.data.step, event.seq);
        for (const record of turn?.records ?? []) {
          if (record.step === event.data.step && record.requestSeq === undefined) record.requestSeq = event.seq;
        }
        break;

      case "system/prompt":
        add("system", { at: event.time, step: event.data.step, seq: event.seq, text: event.data.text });
        break;

      case "user/message":
        add("user", {
          at: event.time,
          seq: event.seq,
          text: textOfMessage(event.data.message),
        });
        break;

      case "assistant/message": {
        const message = event.data.message;
        const record = add("assistant", {
          at: event.time,
          step,
          text: textOfMessage(message) || undefined,
          reasoning: reasoningOfMessage(message) || undefined,
        });
        const result = step === undefined ? undefined : stepResults.get(step);
        if (record !== undefined && result !== undefined) {
          if (result.input !== undefined) record.inputTokens = result.input;
          if (result.output !== undefined) record.outputTokens = result.output;
          if (result.ms !== undefined) record.stepMs = result.ms;
        }
        for (const part of message.parts ?? []) {
          if (part.type !== "tool") continue;
          let tool = tools.get(part.id);
          if (tool === undefined) {
            tool = add("tool", {
              at: event.time,
              step,
              toolName: part.name,
              toolState: part.state,
              input: part.input,
              output: part.output,
              error: part.error,
            });
            if (tool !== undefined) tools.set(part.id, tool);
          } else {
            tool.toolName = part.name;
            tool.toolState = part.state;
            if (part.input !== undefined) tool.input = part.input;
            if (part.output !== undefined) tool.output = part.output;
            if (part.error !== undefined) tool.error = part.error;
          }
        }
        break;
      }

      case "tool/call":
        step = event.data.step ?? step;
        {
          const tool = add("tool", {
            at: event.time,
            seq: event.seq,
            ...(event.data.step === undefined ? {} : { step: event.data.step }),
            toolName: event.data.name,
            toolState: "pending",
            input: undefined,
          });
          if (tool !== undefined) tools.set(event.data.callId, tool);
        }
        break;

      case "tool/result": {
        const tool = tools.get(event.data.callId);
        if (tool !== undefined) {
          tool.toolState = event.data.state;
          tool.durationMs = event.data.durationMs;
          if (event.data.error !== undefined) tool.error = event.data.error;
          if (event.data.change !== undefined) tool.change = event.data.change;
        }
        break;
      }

      case "compaction/start":
        compaction = add("compaction", { at: event.time, step, model: event.data.model, status: "running" });
        break;

      case "compaction/summary":
        if (compaction !== undefined) compaction.text = textOfMessage(event.data.message);
        break;


      case "compaction/end":
        if (compaction !== undefined) {
          compaction.durationMs = event.data.durationMs;
          compaction.status = event.data.ok ? "completed" : "error";
        }
        break;

      case "assistant/attempt":
        add("attempt", {
          at: event.time,
          step: event.data.step,
          status: event.data.outcome,
          durationMs: event.data.durationMs,
          error: event.data.error.message,
        });
        break;

      case "session/rewind":
        add("rewind", { at: event.time, seq: event.seq, targetSeq: event.data.targetSeq });
        break;
    }
  }

  return view;
}
