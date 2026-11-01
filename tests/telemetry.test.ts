/**
 * 事件日志与三个投影的守卫：canonical 日志只追加、seq 单调、投影可重算。
 *
 * 这里钉的是架构承诺，而不是实现细节——"唯一真源"只有在"删掉缓存还能重算出同样的消息"
 * 和"失败也留下事件"这两条可验证时才成立。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig, StoredMessage } from "../src/core/types";
import { openSession } from "../src/session/session";
import { createProject } from "../src/storage/project";
import { appendMessage, loadMessages, truncateMessagesBefore } from "../src/storage/session-store";
import { EventLog, eventLogFor, parseEvents, resetEventLogs } from "../src/telemetry/log";
import { projectMessages, projectSpans, projectStats } from "../src/telemetry/projection";
import { buildTraceView, exportTrace, readTraceSummary } from "../src/session/trace_view";
import { redactEvent, redactEvents, redactText } from "../src/telemetry/redact";
import { MemoryTraceSink, type TraceSink } from "../src/telemetry/sink";
import type { AnyTraceEvent } from "../src/telemetry/events";

let HOME: string;
let prevHome: string | undefined;
let projectId: string;
let serial = 0;

const MODEL: ModelConfig = { provider: "mock", model: "mock", maxTokens: 1000, reasoning: "off" };

/** 每个用例一份新会话目录：日志的尾 seq 有进程内缓存，复用目录会互相干扰 */
function nextSessionId(): string {
  serial++;
  return `telemetry-${serial}`;
}

beforeAll(async () => {
  HOME = await mkdtemp(join(tmpdir(), "talemate-telemetry-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = HOME;
  projectId = (await createProject({ title: "观测测试" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  resetEventLogs();
});

describe("事件日志 · 只追加", () => {
  test("seq 单调、read 按 seq 排序", async () => {
    const log = new EventLog(HOME, projectId, nextSessionId());
    await log.append("turn/start", { agent: "mate", resumed: false });
    await log.append("turn/end", { status: "completed", durationMs: 12 });

    const events = await log.read();
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(["turn/start", "turn/end"]);
  });

  test("崩溃留下的半行不吞掉下一条事件", async () => {
    const sessionId = nextSessionId();
    const log = new EventLog(HOME, projectId, sessionId);
    await log.append("turn/start", { agent: "mate", resumed: false });
    await appendFile(log.path, '{"seq":99,"type":"turn/start","data":{', "utf-8");

    // 崩溃 = 进程没了：下一次追加来自一个新的日志实例，它读文件时才发现末尾半行
    const revived = new EventLog(HOME, projectId, sessionId);
    const appended = await revived.append("turn/end", { status: "completed", durationMs: 1 });
    expect(appended.seq).toBe(2);

    const events = await revived.read();
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.at(-1)?.type).toBe("turn/end");
  });

  test("解析坏行时跳过，不抛", () => {
    expect(parseEvents('not json\n{"seq":3,"type":"turn/start","data":null}\n')).toHaveLength(1);
  });

  test("sink 在落盘后收到事件；sink 抛异常不影响 append", async () => {
    const log = new EventLog(HOME, projectId, nextSessionId());
    const memory = new MemoryTraceSink();
    const broken: TraceSink = {
      emit() {
        throw new Error("传输层炸了");
      },
    };
    log.attachSink(memory);
    log.attachSink(broken);

    await log.append("turn/start", { agent: "mate", resumed: false });
    expect(memory.events.map((e) => e.type)).toEqual(["turn/start"]);
  });
});

describe("投影 · 纯函数", () => {
  function message(seq: number, text: string): StoredMessage {
    return { seq, role: "user", agent: "mate", ts: seq, text };
  }

  test("消息投影：种子 + 消息 + 回退", () => {
    const events: AnyTraceEvent[] = [
      { schemaVersion: 1, sessionId: "s", seq: 1, time: 1, type: "session/seed", data: { messages: [message(1, "旧一")] } },
      { schemaVersion: 1, sessionId: "s", seq: 2, time: 2, type: "user/message", data: { message: message(2, "新二") } },
      { schemaVersion: 1, sessionId: "s", seq: 3, time: 3, type: "session/rewind", data: { targetSeq: 2 } },
      { schemaVersion: 1, sessionId: "s", seq: 4, time: 4, type: "user/message", data: { message: message(2, "重写二") } },
    ];
    expect(projectMessages(events).map((m) => m.text)).toEqual(["旧一", "重写二"]);
  });

  test("span 投影：turn → step → tool，未闭合的标 error", () => {
    const base = { schemaVersion: 1 as const, sessionId: "s" };
    const events: AnyTraceEvent[] = [
      { ...base, seq: 1, time: 100, type: "turn/start", data: { agent: "mate", resumed: false } },
      { ...base, seq: 2, time: 110, type: "step/start", data: { step: 0 } },
      { ...base, seq: 3, time: 120, type: "tool/call", data: { callId: "c1", name: "read", inputChars: 10, step: 0 } },
      { ...base, seq: 4, time: 130, type: "tool/result", data: { callId: "c1", name: "read", state: "completed", outputChars: 5, durationMs: 5 } },
      { ...base, seq: 5, time: 140, type: "step/end", data: { step: 0, finish: "tool_calls", durationMs: 20 } },
      { ...base, seq: 6, time: 150, type: "tool/call", data: { callId: "c2", name: "write", inputChars: 10, step: 0 } },
    ];

    const spans = projectSpans(events);
    const byName = (n: string) => spans.filter((s) => s.name === n);
    expect(byName("invoke_agent")).toHaveLength(1);
    expect(byName("chat")).toHaveLength(1);
    expect(byName("execute_tool").length).toBe(2);

    const tool = byName("execute_tool")[0];
    expect(tool.parentId).toBe("chat:2");
    expect(tool.status).toBe("ok");
    expect(tool.attrs["tool.name"]).toBe("read");

    // 没有 tool/result 的那次调用只能是 error——它确实失败了，哪怕日志里没写原因
    const unfinished = byName("execute_tool")[1];
    expect(unfinished.status).toBe("error");
    expect(unfinished.attrs.incomplete).toBe(true);
    // 整轮也没闭合
    expect(byName("invoke_agent")[0].attrs.incomplete).toBe(true);
  });

  test("统计投影：轮/步/工具/耗时/token", () => {
    const base = { schemaVersion: 1 as const, sessionId: "s" };
    const events: AnyTraceEvent[] = [
      { ...base, seq: 1, time: 1, type: "turn/start", data: { agent: "mate", resumed: false } },
      { ...base, seq: 2, time: 2, type: "step/start", data: { step: 0 } },
      { ...base, seq: 3, time: 3, type: "step/end", data: { step: 0, finish: "stop", durationMs: 100, usage: { input: 30, output: 10 } } },
      { ...base, seq: 4, time: 4, type: "tool/call", data: { callId: "c", name: "read", inputChars: 1 } },
      { ...base, seq: 5, time: 5, type: "tool/result", data: { callId: "c", name: "read", state: "error", outputChars: 0, durationMs: 7 } },
      { ...base, seq: 6, time: 6, type: "assistant/attempt", data: { step: 1, outcome: "interrupted", durationMs: 3, streamedChars: 9, error: { name: "AbortError", message: "aborted" } } },
      { ...base, seq: 7, time: 7, type: "turn/end", data: { status: "aborted", durationMs: 120 } },
    ];

    const stats = projectStats(events);
    expect(stats).toMatchObject({
      events: 7,
      turns: 1,
      abortedTurns: 1,
      steps: 1,
      llmMs: 100,
      toolCalls: 1,
      toolErrors: 1,
      toolMs: 7,
      inputTokens: 30,
      outputTokens: 10,
      interruptions: 1,
    });
  });
});

describe("存储 · 事件优先", () => {
  test("新会话：每条消息都进事件日志，读回时事件是账本", async () => {
    const sessionId = nextSessionId();
    await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: "第一问" });
    await appendMessage(projectId, sessionId, {
      role: "assistant",
      agent: "mate",
      parts: [{ type: "text", text: "第一答" }],
    });

    const events = await eventLogFor(projectId, sessionId).read();
    expect(events.map((e) => e.type)).toEqual(["user/message", "assistant/message"]);
    expect(projectMessages(events).map((m) => m.seq)).toEqual([1, 2]);
    expect((await loadMessages(projectId, sessionId)).map((m) => m.seq)).toEqual([1, 2]);
  });

  test("回退追加 session/rewind，投影按它裁，事件本身不删", async () => {
    const sessionId = nextSessionId();
    for (const text of ["一", "二", "三"]) {
      await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text });
    }

    expect(await truncateMessagesBefore(projectId, sessionId, 3)).toBe(2);
    expect((await loadMessages(projectId, sessionId)).map((m) => m.seq)).toEqual([1, 2]);

    const events = await eventLogFor(projectId, sessionId).read();
    expect(events.at(-1)?.type).toBe("session/rewind");
    // 历史本身没有被删：第三条消息的事件仍在，只是被 rewind 遮住
    expect(events.filter((e) => e.type === "user/message")).toHaveLength(3);

    // 没有 messages 文件可重写：历史只有事件日志，投影是现场折的
    expect(await loadMessages(projectId, sessionId)).toHaveLength(2);
  });
});

describe("会话接线 · 一轮留下什么", () => {
  test("turn/step/消息各就各位，sink 收到同一批事件", async () => {
    const session = await openSession({ projectId, model: MODEL, title: "观测接线" });
    const sink = new MemoryTraceSink();
    eventLogFor(projectId, session.sessionId).attachSink(sink);

    await session.post("你好");
    const events = await eventLogFor(projectId, session.sessionId).read();
    const types: string[] = events.map((e) => e.type);
    const missing = [
      "session/start",
      "turn/start",
      "user/message",
      "step/start",
      "step/end",
      "assistant/message",
      "turn/end",
    ].filter((t) => !types.includes(t));
    expect(missing).toEqual([]);

    expect(projectStats(events)).toMatchObject({ turns: 1, completedTurns: 1, steps: 1, messages: 2 });
    // sink 是 openSession 之后才挂上的，所以从它挂上那一刻起的事件应当一条不少地到齐
    const captured = sink.events.map((e) => e.seq);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured).toEqual(events.slice(-captured.length).map((e) => e.seq));
    expect(await loadMessages(projectId, session.sessionId)).toEqual(projectMessages(events));
  });

  test("工具调用有 call/result 成对事件，span 能挂到 step 上", async () => {
    const prev = process.env.TALEMATE_MOCK_TOOL;
    process.env.TALEMATE_MOCK_TOOL = "read";
    try {
      const session = await openSession({ projectId, model: MODEL, title: "工具观测" });
      await session.post("读一下核心设定。");

      const events = await eventLogFor(projectId, session.sessionId).read();
      expect(events.filter((e) => e.type === "tool/call")).toHaveLength(1);
      expect(events.filter((e) => e.type === "tool/result")).toHaveLength(1);

      const spans = projectSpans(events);
      const toolSpans = spans.filter((s) => s.name === "execute_tool");
      const chat = spans.find((s) => s.name === "chat");
      expect(toolSpans).toHaveLength(1);
      expect(chat).toBeDefined();
      // 工具挂在发起它的那次模型请求下（step/end 先落盘，所以靠事件里的 step 号认父）
      expect(toolSpans[0].parentId).toBe(chat?.spanId);
      expect(projectStats(events).toolCalls).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.TALEMATE_MOCK_TOOL;
      else process.env.TALEMATE_MOCK_TOOL = prev;
    }
  });
});

describe("轨迹视图 · 摘要与导出", () => {
  test("摘要从事件折出轮/工具/耗时", async () => {
    const sessionId = nextSessionId();
    const log = eventLogFor(projectId, sessionId);
    await log.append("turn/start", { agent: "mate", resumed: false });
    await log.append("step/start", { step: 0 });
    await log.append("step/end", { step: 0, finish: "stop", durationMs: 40, usage: { input: 10, output: 2 } });
    await log.append("turn/end", { status: "completed", durationMs: 50 });

    const text = await readTraceSummary(projectId, sessionId);
    expect(text).toContain("轮 1（完成 1");
    expect(text).toContain("工具 0（失败 0）");
    expect(text).toContain("模型 40ms");

    // 桌面右栏多要一个路径：窗口里没有终端，没有路径就等于看不到原始日志
    const view = await buildTraceView(projectId, sessionId);
    expect(view.summary).toBe(text);
    expect(view.eventsPath.endsWith("events.jsonl")).toBe(true);
  });

  test("导出的是脱敏副本，canonical 日志一字不改", async () => {
    const sessionId = nextSessionId();
    await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: "api_key=abcdef123456" });
    const out = join(HOME, "trace-export.jsonl");

    const result = await exportTrace(projectId, sessionId, out, { homeDir: HOME });
    expect(result.written).toBe(1);
    expect(await readFile(out, "utf-8")).not.toContain("abcdef123456");
    // 本地账本仍带原文：脱敏只作用于离开进程的那一份
    expect(JSON.stringify(await eventLogFor(projectId, sessionId).read())).toContain("abcdef123456");
  });
});

describe("脱敏 · 只作用于副本", () => {
  test("密钥与家目录都洗掉", () => {
    const text = redactText(`key=sk-abcdefgh1234 Bearer abcdefgh1234 路径 /Users/x/novel/design/core.md`, {
      homeDir: "/Users/x",
    });
    expect(text).not.toContain("sk-abcdefgh1234");
    expect(text).not.toContain("abcdefgh1234");
    expect(text).toContain("~/novel/design/core.md");
  });

  test("redactEvent 返回副本，不改原事件", () => {
    const event: AnyTraceEvent = {
      schemaVersion: 1,
      sessionId: "s",
      seq: 1,
      time: 1,
      type: "user/message",
      data: { message: { seq: 1, role: "user", ts: 1, text: "token: supersecret" } },
    };
    const redacted = redactEvent(event, { homeDir: "/Users/x" });
    expect(JSON.stringify(redacted)).not.toContain("supersecret");
    expect(JSON.stringify(event)).toContain("supersecret");
  });

  test("洗不干净的记录整条扣下（fail-closed），其余照常导出", () => {
    const bad = {
      schemaVersion: 1,
      sessionId: "s",
      seq: 2,
      time: 2,
      type: "turn/start",
      data: { at: 10n },
    } as unknown as AnyTraceEvent;
    const good: AnyTraceEvent = { schemaVersion: 1, sessionId: "s", seq: 3, time: 3, type: "turn/end", data: { status: "completed", durationMs: 1 } };

    const result = redactEvents([bad, good], { homeDir: "/Users/x" });
    expect(result.dropped).toBe(1);
    expect(result.events.map((e) => e.seq)).toEqual([3]);
  });
});
