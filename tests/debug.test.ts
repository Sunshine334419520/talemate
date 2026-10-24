/**
 * `/debug` 的渲染守卫：它要给出会话目录与 messages.jsonl 的绝对路径（排查要拿这个），
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
  messagesPath: "/Users/x/.talemate/novels/novel-a556/.talemate/sessions/30d5b481/messages.jsonl",
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
  lastUsage: { input: 12496, output: 3142 },
};

describe("/debug 渲染", () => {
  test("给全三个路径与会话事实", () => {
    const text = renderSessionDebug(info);
    expect(text).toContain(info.projectRoot);
    expect(text).toContain(info.sessionDir);
    expect(text).toContain(info.messagesPath);
    expect(text).toContain("共 33 条，最后 seq=33");
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
