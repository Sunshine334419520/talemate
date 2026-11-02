/**
 * 事件视图模型的守卫：turn → step → attempt / tool 的树只吃事件，失败与没有结果的调用都不能丢。
 */
import { describe, expect, test } from "bun:test";
import type { AnyTraceEvent, TraceEventData, TraceEventType } from "../src/telemetry/events";
import { buildTraceModel } from "../src/telemetry/view";

function ev<T extends TraceEventType>(seq: number, type: T, data: TraceEventData[T]): AnyTraceEvent {
  return { schemaVersion: 1, sessionId: "s", seq, time: 1000 + seq, type, data } as AnyTraceEvent;
}

const HEADER: TraceEventData["request/header"] = {
  step: 0,
  agent: "mate",
  provider: "mock",
  model: "mock",
  temperature: 0.8,
  maxTokens: 1000,
  reasoning: "off",
  systemHash: "a".repeat(64),
  toolsHash: "b".repeat(64),
  messagesHash: "c".repeat(64),
  promptHash: "d".repeat(64),
  systemChars: 10,
  toolsChars: 20,
  messagesChars: 30,
};

describe("事件视图 · turn/step", () => {
  test("成功的一轮：request header、工具成对、usage 都在 step 上", () => {
    const model = buildTraceModel([
      ev(1, "session/start", { agent: "mate", model: "mock", provider: "mock", title: "t" }),
      ev(2, "turn/start", { agent: "mate", resumed: false }),
      ev(3, "step/start", { step: 0 }),
      ev(4, "request/header", HEADER),
      ev(5, "tool/call", { callId: "c1", name: "read", inputChars: 10, step: 0 }),
      ev(6, "tool/result", {
        callId: "c1",
        name: "read",
        state: "completed",
        outputChars: 20,
        durationMs: 5,
      }),
      ev(7, "step/end", {
        step: 0,
        finish: "tool_calls",
        durationMs: 10,
        usage: { input: 100, output: 10 },
      }),
      ev(8, "turn/end", { status: "completed", durationMs: 20 }),
    ]);

    expect(model.turns).toHaveLength(1);
    const turn = model.turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.endedAt).toBe(1008);
    const step = turn.steps[0]!;
    expect(step.status).toBe("ok");
    expect(step.request?.promptHash).toBe(HEADER.promptHash);
    expect(step.usage).toEqual({ input: 100, output: 10 });
    expect(step.tools).toHaveLength(1);
    expect(step.tools[0]).toMatchObject({ state: "completed", outputChars: 20, durationMs: 5 });
  });

  test("失败的请求没有 step/end：attempt 仍把这一步标成 error", () => {
    const model = buildTraceModel([
      ev(1, "turn/start", { agent: "mate", resumed: false }),
      ev(2, "step/start", { step: 0 }),
      ev(3, "assistant/attempt", {
        step: 0,
        outcome: "error",
        durationMs: 7,
        streamedChars: 0,
        error: { name: "X", message: "boom" },
      }),
      ev(4, "turn/end", { status: "error", durationMs: 8, error: { name: "X", message: "boom" } }),
    ]);
    const step = model.turns[0]!.steps[0]!;
    expect(step.status).toBe("error");
    expect(step.attempts[0]?.error.message).toBe("boom");
    expect(step.endedAt).toBe(1003);
    expect(model.turns[0]!.status).toBe("error");
  });

  test("压缩、回退、harness 工具都挂到正确层级", () => {
    const model = buildTraceModel([
      ev(1, "turn/start", { agent: "mate", resumed: false }),
      ev(2, "tool/call", { callId: "h1", name: "apply-design", inputChars: 4 }),
      ev(3, "tool/result", {
        callId: "h1",
        name: "apply-design",
        state: "completed",
        outputChars: 12,
        durationMs: 1,
      }),
      ev(4, "compaction/start", { model: "mock" }),
      ev(5, "compaction/end", { durationMs: 3, ok: true, compacted: true }),
      ev(6, "session/rewind", { targetSeq: 2 }),
    ]);
    const turn = model.turns[0]!;
    expect(turn.status).toBe("open");
    expect(turn.tools[0]?.callId).toBe("h1");
    expect(turn.tools[0]?.state).toBe("completed");
    expect(turn.compactions[0]).toMatchObject({ model: "mock", ok: true, compacted: true });
    expect(model.rewinds).toEqual([{ at: 1006, targetSeq: 2 }]);
  });

  test("工具没有结果时保持 pending，不补一个假的结束", () => {
    const model = buildTraceModel([
      ev(1, "turn/start", { agent: "mate", resumed: false }),
      ev(2, "step/start", { step: 0 }),
      ev(3, "tool/call", { callId: "c1", name: "read", inputChars: 10, step: 0 }),
    ]);
    expect(model.turns[0]!.steps[0]!.tools[0]?.state).toBe("pending");
    expect(model.turns[0]!.steps[0]!.tools[0]?.outputChars).toBeUndefined();
  });
});
