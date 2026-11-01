/**
 * `/debug` 的渲染守卫：它要给出会话目录、事件日志与改动索引的绝对路径（排查要拿这个），
 * 但**绝不能**把密钥写进去——这段文本会进终端、右栏，甚至被复制给别人。
 */
import { describe, test, expect } from "bun:test";
import { renderSessionDebug, type SessionDebugInfo } from "../src/session/debug";

const info: SessionDebugInfo = {
  projectId: "novel-a556",
  projectTitle: "重生之望族嫡女",
  projectRoot: "/Users/x/.talemate/novels/novel-a556",
  sessionId: "30d5b481",
  sessionDir: "/Users/x/.talemate/novels/novel-a556/.talemate/sessions/30d5b481",
  eventsPath: "/Users/x/.talemate/novels/novel-a556/.talemate/sessions/30d5b481/events.jsonl",
  eventCount: 120,
  stats: {
    events: 120,
    turns: 12,
    completedTurns: 10,
    failedTurns: 1,
    abortedTurns: 1,
    steps: 20,
    llmMs: 1500,
    attemptsFailed: 2,
    interruptions: 1,
    toolCalls: 14,
    toolErrors: 1,
    toolMs: 320,
    compactions: 1,
    inputTokens: 12496,
    outputTokens: 3142,
    messages: 33,
    firstTime: 1,
    lastTime: 2,
  },
  changesPath: "/Users/x/.talemate/novels/novel-a556/.talemate/sessions/30d5b481/changes.jsonl",
  pendingAskPath: "/Users/x/.talemate/novels/novel-a556/.talemate/sessions/30d5b481/pending-ask.json",
  pendingAskExists: false,
  agent: "mate",
  agentName: "搭档",
  depth: 0,
  model: { provider: "openai", model: "deepseek-flash", baseURL: "https://api.deepseek.com", reasoning: "low", maxTokens: 32000 },
  profile: "DeepSeek",
  mode: "工作区内修改",
  pending: [{ name: "__plan__", approved: true, chapter: 3 }],
  messageCount: 33,
  lastSeq: 33,
  modelWindowCount: 33,
  modelWindowFromSeq: 1,
  lastUsage: { input: 12496, output: 3142 },
};

describe("/debug 渲染", () => {
  test("给全三个路径与会话事实", () => {
    const text = renderSessionDebug(info);
    expect(text).toContain(info.projectRoot);
    expect(text).toContain(info.sessionDir);
    expect(text).toContain(info.eventsPath);
    expect(text).toContain("共 120 条");
    expect(text).toContain(info.changesPath);
    expect(text).toContain("消息：33 条");
    expect(text).toContain("最后 seq=33");
    expect(text).toContain("模型窗口：33 条，从 seq=1 起（无压缩）");
    expect(text).toContain("工作区内修改");
    expect(text).toContain("第 3 章");
    expect(text).toContain("input 12496 / output 3142");
  });

  test("密钥不出现（这段文本会进终端、右栏，也会被复制）", () => {
    expect(renderSessionDebug(info)).not.toContain("sk-");
  });

  test("没有 journal / 用量时说'无'，不编一个 0", () => {
    const text = renderSessionDebug({ ...info, pendingAskExists: false, lastUsage: undefined, pending: [] });
    expect(text).toContain("未答提问记录：无");
    expect(text).toContain("最近用量：无");
    expect(text).toContain("待批：无");
  });
});
