/**
 * 事件 schema 的契约：每种事件都有可读的样例，未知版本/未知类型不得被猜成合法事件。
 *
 * `SAMPLES` 是穷尽的 `Record<TraceEventType, ...>`——给事件表加一条却忘了补样例，编译就会红。
 */
import { describe, expect, test } from "bun:test";
import { parseEvents } from "../src/telemetry/log";
import type { TraceEventData, TraceEventType } from "../src/telemetry/events";
import { upgradeEvent } from "../src/telemetry/schema";

const SAMPLES: { [K in TraceEventType]: TraceEventData[K] } = {
  "session/start": { agent: "mate", model: "mock", provider: "mock", title: "t" },
  "session/seed": { messages: [] },
  "session/rewind": { targetSeq: 1 },
  "turn/start": { agent: "mate", resumed: false },
  "turn/end": { status: "completed", durationMs: 1 },
  "step/start": { step: 0 },
  "system/prompt": { step: 0, text: "system", hash: "e".repeat(64) },
  "request/header": {
    step: 0,
    agent: "mate",
    provider: "mock",
    model: "mock",
    temperature: 0.8,
    maxTokens: 1000,
    systemHash: "a".repeat(64),
    toolsHash: "b".repeat(64),
    messagesHash: "c".repeat(64),
    promptHash: "d".repeat(64),
    systemChars: 1,
    toolsChars: 2,
    messagesChars: 3,
  },
  "request/context": { provider: "mock", model: "mock", contextWindow: 1000 },
  "step/end": { step: 0, finish: "stop", durationMs: 1 },
  "assistant/attempt": {
    step: 0,
    outcome: "error",
    durationMs: 1,
    streamedChars: 0,
    error: { name: "X", message: "boom" },
  },
  "user/message": { message: { seq: 1, role: "user", ts: 1, text: "hi" } },
  "assistant/message": { message: { seq: 2, role: "assistant", ts: 2, parts: [] } },
  "compaction/start": { model: "mock" },
  "compaction/summary": { message: { seq: 3, role: "compaction", ts: 3, summary: "s" } },
  "compaction/end": { durationMs: 1, ok: true, compacted: true },
  "context/compaction": {
    id: "r1",
    at: 1,
    consumed: { fromSeq: 1, toSeq: 4, turns: 2 },
    summary: { session: "s", accomplished: [], intent: [], open: [], pointers: [] },
    pinned: { decisions: [], resident: [] },
    evidence: [],
    budget: { usable: 1000, trigger: 850, before: 900, after: 200 },
    dropped: { messages: 4, toolResults: 0, toolChars: 0 },
    degraded: false,
  },
  "perception/plan": {
    step: 0,
    purpose: "prose",
    hash: "p",
    builtAt: 1,
    budget: { ceiling: 100, used: 10 },
    decisions: [],
    missing: [],
    metrics: { p0Coverage: 1, dropped: 0, compressionRatio: 1, stale: 0, duplicate: 0, missing: 0, deferred: 0 },
  },
  "proposal/presented": { proposal: "design/core.md", hash: "h", at: 1 },
  "proposal/decision": { at: 1, proposal: "design/core.md", verdict: "accept" },
  "tool/call": { callId: "c", name: "read", inputChars: 1 },
  "tool/result": {
    callId: "c",
    name: "read",
    state: "completed",
    outputChars: 1,
    durationMs: 1,
  },
};

describe("事件 schema", () => {
  test("每种事件都有样例，且都能升级到当前版本", () => {
    const missing: string[] = [];
    for (const [type, data] of Object.entries(SAMPLES) as [TraceEventType, unknown][]) {
      const event = upgradeEvent({ schemaVersion: 1, sessionId: "s", seq: 1, time: 1, type, data });
      if (event === null || event.type !== type) missing.push(type);
    }
    expect(missing).toEqual([]);
  });

  test("未知类型、未来版本、缺 seq 都返回 null", () => {
    expect(
      upgradeEvent({ schemaVersion: 1, sessionId: "s", seq: 1, time: 1, type: "nope", data: {} }),
    ).toBeNull();
    expect(
      upgradeEvent({ schemaVersion: 99, sessionId: "s", seq: 1, time: 1, type: "turn/start", data: {} }),
    ).toBeNull();
    expect(upgradeEvent({ schemaVersion: 1, sessionId: "s", time: 1, type: "turn/start", data: {} })).toBeNull();
  });

  test("parseEvents 跳过坏行与未知版本，按 seq 排序", () => {
    const text = [
      JSON.stringify({ schemaVersion: 1, sessionId: "s", seq: 2, time: 2, type: "turn/start", data: { agent: "mate", resumed: false } }),
      "{ broken",
      JSON.stringify({ schemaVersion: 9, sessionId: "s", seq: 3, time: 3, type: "turn/start", data: {} }),
      JSON.stringify({ schemaVersion: 1, sessionId: "s", seq: 1, time: 1, type: "turn/start", data: { agent: "mate", resumed: false } }),
    ].join("\n");
    expect(parseEvents(text).map((event) => event.seq)).toEqual([1, 2]);
  });
});
