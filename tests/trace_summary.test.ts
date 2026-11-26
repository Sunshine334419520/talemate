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

  test("感知摘要按 purpose 折 observed/plan，不报压缩比", () => {
    const summary = renderTraceSummary([
      event(1, "perception/observed", {
        step: 0,
        purpose: "prose",
        mode: "shadow",
        profile: "prose.v1",
        profiled: true,
        planHash: "p",
        hash: "o",
        builtAt: 1,
      }),
      event(2, "perception/plan", {
        step: 0,
        purpose: "prose",
        hash: "p",
        builtAt: 1,
        budget: { ceiling: 12_000, used: 7200 },
        decisions: [],
        missing: ["state/reader.md 未建立"],
        metrics: { p0Coverage: 1, dropped: 3, compressionRatio: 0.42, stale: 1, duplicate: 2, missing: 1, deferred: 23 },
      }),
      event(3, "perception/observed", {
        step: 1,
        purpose: "chat",
        mode: "shadow",
        profile: "none",
        profiled: false,
        reason: "no-profile",
        hash: "o2",
        builtAt: 2,
      }),
    ]);
    expect(summary).toContain("感知：请求 0 · plan 1 · observed 2");
    expect(summary).toContain("prose：plan 1 · observed 1");
    expect(summary).toContain("P0 覆盖 1.00");
    expect(summary).toContain("延迟 23");
    expect(summary).toContain("过期 1 · 重复 2 · 缺失 1");
    expect(summary).toContain("最近预算 7.2k/12.0k");
    expect(summary).toContain("chat：observed 1 · no-profile");
    expect(summary).not.toContain("压缩比");
  });
});
