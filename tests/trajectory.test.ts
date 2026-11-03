/**
 * 轨迹表投影：消息、system、工具、压缩、失败尝试必须落在同一张记录表里，
 * 而不是再分“事件 / 消息”两个模式。
 */
import { describe, expect, test } from "bun:test";
import type { AnyTraceEvent, TraceEventData, TraceEventType } from "../src/telemetry/events";
import { buildTrajectory } from "../src/telemetry/trajectory";

function ev<T extends TraceEventType>(seq: number, type: T, data: TraceEventData[T]): AnyTraceEvent {
  return { schemaVersion: 2, sessionId: "s", seq, time: 1000 + seq, type, data } as AnyTraceEvent;
}

const HEADER: TraceEventData["request/header"] = {
  step: 0,
  agent: "mate",
  provider: "mock",
  model: "mock",
  temperature: 0.8,
  maxTokens: 1000,
  reasoning: "low",
  systemHash: "a".repeat(64),
  toolsHash: "b".repeat(64),
  messagesHash: "c".repeat(64),
  promptHash: "d".repeat(64),
  systemChars: 10,
  toolsChars: 20,
  messagesChars: 30,
  reason: "initial",
};

describe("轨迹记录 · 一张表", () => {
  test("system / user / tool / assistant 都在 turn 的记录里，且带 requestSeq", () => {
    const view = buildTrajectory([
      ev(1, "session/start", { agent: "mate", model: "mock", provider: "mock", title: "t" }),
      ev(2, "turn/start", { agent: "mate", resumed: false }),
      ev(3, "system/prompt", { step: 0, text: "你是搭档", hash: "e".repeat(64) }),
      ev(4, "request/header", HEADER),
      ev(5, "user/message", { message: { seq: 1, role: "user", ts: 1, text: "你好" } }),
      ev(6, "step/start", { step: 0 }),
      ev(7, "tool/call", { callId: "c1", name: "read", inputChars: 2, step: 0 }),
      ev(8, "tool/result", { callId: "c1", name: "read", state: "completed", outputChars: 2, durationMs: 1 }),
      ev(9, "assistant/message", {
        message: {
          seq: 2,
          role: "assistant",
          ts: 2,
          parts: [
            { type: "text", text: "看过了" },
            { type: "tool", id: "c1", name: "read", state: "completed", input: "{}", output: "ok" },
          ],
        },
      }),
      ev(10, "step/end", { step: 0, finish: "stop", durationMs: 5 }),
      ev(11, "turn/end", { status: "completed", durationMs: 6 }),
    ]);

    expect(view.turns).toHaveLength(1);
    const turn = view.turns[0]!;
    expect(turn.records.map((r) => r.kind)).toEqual(["system", "user", "tool", "assistant"]);
    const system = turn.records.find((r) => r.kind === "system")!;
    expect(system.text).toBe("你是搭档");
    expect(system.requestSeq).toBe(4);
    const tool = turn.records.find((r) => r.kind === "tool")!;
    expect(tool).toMatchObject({ toolName: "read", toolState: "completed", input: "{}", output: "ok", requestSeq: 4 });
    const assistant = turn.records.find((r) => r.kind === "assistant")!;
    expect(assistant.text).toBe("看过了");
    expect(assistant.requestSeq).toBe(4);
  });

  test("压缩、失败尝试、回退都留在同一张表", () => {
    const view = buildTrajectory([
      ev(1, "turn/start", { agent: "mate", resumed: false }),
      ev(2, "compaction/start", { model: "mock" }),
      ev(3, "compaction/summary", { message: { seq: 1, role: "compaction", ts: 1, summary: "摘要", recent: "最近" } }),
      ev(4, "compaction/end", { durationMs: 2, ok: true, compacted: true }),
      ev(5, "step/start", { step: 0 }),
      ev(6, "assistant/attempt", {
        step: 0,
        outcome: "error",
        durationMs: 3,
        streamedChars: 0,
        error: { name: "X", message: "失败" },
      }),
      ev(7, "session/rewind", { targetSeq: 1 }),
      ev(8, "turn/end", { status: "error", durationMs: 4, error: { name: "X", message: "失败" } }),
    ]);
    const turn = view.turns[0]!;
    expect(turn.records.map((r) => r.kind)).toEqual(["compaction", "attempt", "rewind"]);
    expect(turn.records[0]).toMatchObject({ text: "摘要\n\n最近", status: "completed" });
    expect(turn.records[1]).toMatchObject({ status: "error", error: "失败" });
    expect(turn.records[2]).toMatchObject({ targetSeq: 1 });
    expect(turn.status).toBe("error");
  });
});
