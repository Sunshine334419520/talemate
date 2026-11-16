/**
 * /trace 摘要的守卫：上下文水位从 request/header 折出来，压缩的降幅只在
 * "压缩前有请求、压缩后有请求"时才算——不能拿没发出去的窗口编一个下降。
 */
import { describe, expect, test } from "bun:test";
import { renderTraceSummary } from "../src/session/trace_view";
import type { AnyTraceEvent } from "../src/telemetry/events";

function event(seq: number, type: string, data: unknown): AnyTraceEvent {
  return { schemaVersion: 2, sessionId: "s1", seq, time: seq * 1000, type, data } as AnyTraceEvent;
}

function header(seq: number, system: number, tools: number, messages: number): AnyTraceEvent {
  return event(seq, "request/header", {
    step: 1,
    agent: "mate",
    provider: "test",
    model: "test",
    temperature: null,
    maxTokens: 1000,
    systemHash: "s",
    toolsHash: "t",
    messagesHash: "m",
    promptHash: "p",
    systemChars: system,
    toolsChars: tools,
    messagesChars: messages,
  });
}

describe("/trace 摘要 · 上下文水位", () => {
  test("最新与峰值都按三段之和算，压缩给出 messages 降幅", () => {
    const summary = renderTraceSummary([
      header(1, 100, 50, 200),
      event(2, "compaction/start", { model: "test" }),
      event(3, "compaction/end", { durationMs: 20, ok: true, compacted: true }),
      header(4, 100, 50, 60),
    ]);
    expect(summary).toContain("最新 210 字（system 100 + tools 50 + messages 60）");
    expect(summary).toContain("峰值 350");
    expect(summary).toContain("200 → 60（-70%）");
  });

  test("压缩后没有新请求就不报降幅", () => {
    const summary = renderTraceSummary([
      header(1, 100, 50, 200),
      event(2, "compaction/start", { model: "test" }),
      event(3, "compaction/end", { durationMs: 20, ok: true, compacted: true }),
    ]);
    expect(summary).toContain("上下文：最新 350");
    expect(summary).not.toContain("最近 messages");
  });
});
