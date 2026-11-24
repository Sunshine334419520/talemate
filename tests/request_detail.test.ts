/**
 * 请求详情的守卫：它是日志的纯折叠，不依赖“捕获开关”；旧日志缺 system/tools 时就明确缺失。
 */
import { describe, expect, test } from "bun:test";
import type { AnyTraceEvent, TraceEventData, TraceEventType } from "../src/telemetry/events";
import { buildRequestDetail } from "../src/telemetry/request_detail";

function ev<T extends TraceEventType>(seq: number, type: T, data: TraceEventData[T]): AnyTraceEvent {
  return { schemaVersion: 2, sessionId: "s", seq, time: 1000 + seq, type, data } as AnyTraceEvent;
}

const HEADER = (step: number): TraceEventData["request/header"] => ({
  step,
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
});

const TOOL = { name: "read", description: "Read", inputSchema: { type: "object" } };

const PERCEPTION: TraceEventData["perception/plan"] = {
  step: 0,
  purpose: "prose",
  chapter: 1,
  hash: "ph",
  builtAt: 1,
  budget: { ceiling: 100, used: 20 },
  decisions: [
    {
      id: "character.state.沈越",
      tier: "P0",
      action: "include",
      placement: "system.tail",
      source: { kind: "state", path: "state/characters/沈越.md", rev: "r1" },
      sourceChars: 4,
      chars: 4,
      reason: "p0-required",
    },
  ],
  missing: [],
  metrics: { p0Coverage: 1, dropped: 0, compressionRatio: 1, stale: 0, duplicate: 0, missing: 0, deferred: 0 },
};

describe("请求详情 · 折叠", () => {
  test("header 配置 + 最近 system/prompt + 最近带 tools 的快照 + 消息窗口", () => {
    const events = [
      ev(1, "system/prompt", { step: 0, text: "sys v1", hash: "e".repeat(64) }),
      ev(2, "request/header", { ...HEADER(0), reason: "initial", tools: [TOOL] }),
      ev(3, "request/context", { provider: "mock", model: "mock", contextWindow: 1000 }),
      ev(4, "user/message", { message: { seq: 1, role: "user", ts: 1, text: "你好" } }),
      ev(5, "assistant/message", { message: { seq: 2, role: "assistant", ts: 2, parts: [{ type: "text", text: "在" }] } }),
      ev(6, "request/header", { ...HEADER(1) }),
      ev(7, "user/message", { message: { seq: 3, role: "user", ts: 3, text: "继续" } }),
    ];
    const detail = buildRequestDetail(events, 6);
    expect(detail).not.toBeNull();
    expect(detail?.step).toBe(1);
    expect(detail?.config).toMatchObject({ provider: "mock", model: "mock", temperature: 0.8 });
    expect(detail?.system?.text).toBe("sys v1");
    expect(detail?.tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(detail?.context).toMatchObject({ contextWindow: 1000 });
    expect(
      detail?.messages.map((message) =>
        message.role === "assistant" ? (message.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("") : message.text ?? "",
      ),
    ).toEqual(["你好", "在"]);
  });

  test("header 的 perceptionHash 指到哪份 plan，才给哪份；不拿最近一条冒充", () => {
    const events = [
      ev(1, "perception/plan", PERCEPTION),
      ev(2, "request/header", { ...HEADER(0), perceptionHash: "ph" }),
      ev(3, "request/header", HEADER(1)),
    ];
    const matched = buildRequestDetail(events, 2);
    expect(matched?.perception?.decisions[0]?.id).toBe("character.state.沈越");
    const unmatched = buildRequestDetail(events, 3);
    expect(unmatched?.perception).toBeUndefined();
  });

  test("compaction 之后只取窗口，不把整份历史再喂回去", () => {
    const events = [
      ev(1, "system/prompt", { step: 0, text: "sys", hash: "e".repeat(64) }),
      ev(2, "request/header", { ...HEADER(0), reason: "initial", tools: [TOOL] }),
      ev(3, "user/message", { message: { seq: 1, role: "user", ts: 1, text: "旧" } }),
      ev(4, "assistant/message", { message: { seq: 2, role: "assistant", ts: 2, parts: [{ type: "text", text: "旧答" }] } }),
      ev(5, "compaction/summary", { message: { seq: 3, role: "compaction", ts: 3, summary: "摘要", recent: "最近" } }),
      ev(6, "user/message", { message: { seq: 4, role: "user", ts: 4, text: "新" } }),
      ev(7, "request/header", { ...HEADER(1) }),
    ];
    const detail = buildRequestDetail(events, 7);
    expect(detail?.messages.map((message) => message.role)).toEqual(["compaction", "user"]);
    expect(detail?.messages.at(-1)?.text).toBe("新");
  });

  test("旧日志没有 system/tools 时不伪造，返回缺失字段", () => {
    const events = [
      ev(1, "user/message", { message: { seq: 1, role: "user", ts: 1, text: "x" } }),
      ev(2, "request/header", HEADER(0)),
    ];
    const detail = buildRequestDetail(events, 2);
    expect(detail?.system).toBeUndefined();
    expect(detail?.tools).toBeUndefined();
    expect(detail?.messages).toHaveLength(1);
  });

  test("不是 request/header 的 seq 返回 null", () => {
    expect(buildRequestDetail([ev(1, "step/start", { step: 0 })], 1)).toBeNull();
  });
});
