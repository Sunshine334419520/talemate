/**
 * 压缩的守卫：量的是模型窗口，不是整份会话文件；压缩本身也只能吃窗口。
 *
 * 这些用例全离线（mock provider），覆盖 estimateChars / isOverBudget / compact / loadModelWindow。
 * 1M 的真实请求不在单测里——这里钉的是"窗口边界"和"压完之后的窗口起点"。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig, StoredMessage } from "../src/core/types";
import { compactTrigger, contextWindow } from "../src/core/windows";
import { estimateChars, isOverBudget, compact } from "../src/session/compaction";
import { appendMessage, createSession, loadMessages, loadModelWindow } from "../src/storage/session-store";
import { createProject } from "../src/storage/project";

let home: string;
let prevHome: string | undefined;
let projectId: string;
let serial = 0;

const MODEL: ModelConfig = { provider: "mock", model: "mock", maxTokens: 1000, reasoning: "off" };

function nextSession(): string {
  serial++;
  return `compact-${serial}`;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-compact-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = home;
  projectId = (await createProject({ title: "压缩测试" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

function user(seq: number, text: string): StoredMessage {
  return { seq, role: "user", ts: seq, text };
}

function assistant(seq: number, text: string): StoredMessage {
  return { seq, role: "assistant", ts: seq, parts: [{ type: "text", text }] };
}

describe("压缩 · 文本量与阈值", () => {
  test("estimateChars 把正文、推理、工具入参/输出、compaction 两块都算进去", () => {
    const messages: StoredMessage[] = [
      user(1, "12345"),
      {
        seq: 2,
        role: "assistant",
        ts: 2,
        parts: [
          { type: "text", text: "123" },
          { type: "reasoning", text: "12" },
          { type: "tool", id: "c", name: "read", state: "completed", input: "1234", output: "123456" },
        ],
      },
      { seq: 3, role: "compaction", ts: 3, summary: "123", recent: "12" },
    ];
    expect(estimateChars(messages)).toBe(5 + 3 + 2 + 4 + 6 + 3 + 2);
  });

  test("lastInput 之外还保留字符守门：大工具输出不会被上一次请求的旧数字掩盖", () => {
    const small = [user(1, "x".repeat(100))];
    expect(isOverBudget("mock", 100, small, { TALEMATE_COMPACT_TOKENS: "500" })).toBe(false);
    expect(isOverBudget("mock", 900, small, { TALEMATE_COMPACT_TOKENS: "500" })).toBe(true);

    const huge: StoredMessage[] = [
      {
        seq: 1,
        role: "assistant",
        ts: 1,
        parts: [{ type: "tool", id: "c", name: "read", state: "completed", input: "", output: "x".repeat(1000) }],
      },
    ];
    // 上一次请求只有 100，但这一步的工具输出已经是 1000 字——不能等下一次请求再发现
    expect(isOverBudget("mock", 100, huge, { TALEMATE_COMPACT_TOKENS: "500" })).toBe(true);
  });

  test("1M 模型的触发点是 80 万，不是 8 万", () => {
    expect(contextWindow("deepseek-v4-flash")).toBe(1_000_000);
    expect(compactTrigger("deepseek-v4-flash")).toBe(800_000);
  });
});

describe("压缩 · 窗口", () => {
  test("<= 6 条不压；> 6 条压成一条 compaction，窗口从它开始", async () => {
    const sessionId = nextSession();
    await createSession(projectId, { id: sessionId, projectId, title: "压缩", agent: "mate" });
    for (let i = 0; i < 3; i++) {
      await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: `问 ${i}` });
      await appendMessage(projectId, sessionId, {
        role: "assistant",
        agent: "mate",
        parts: [{ type: "text", text: `答 ${i}` }],
      });
    }
    expect(await compact({ projectId, sessionId, model: MODEL })).toBeNull();

    await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: "再问" });
    await appendMessage(projectId, sessionId, {
      role: "assistant",
      agent: "mate",
      parts: [{ type: "text", text: "再答" }],
    });

    const before = await loadMessages(projectId, sessionId);
    const compaction = await compact({ projectId, sessionId, model: MODEL, messages: before });
    expect(compaction?.role).toBe("compaction");
    const after = await loadMessages(projectId, sessionId);
    expect(after.length).toBe(before.length + 1);
    const window = loadModelWindow(after);
    expect(window[0]?.role).toBe("compaction");
    // 窗口只从 compaction 起，不把整份历史再喂回去
    expect(window.length).toBeLessThan(after.length);
  });

  test("head 超过块大小时分块摘要，仍然只落一条 compaction", async () => {
    const sessionId = nextSession();
    await createSession(projectId, { id: sessionId, projectId, title: "分块", agent: "mate" });
    for (let i = 0; i < 8; i++) {
      await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: `${i} ` + "x".repeat(100) });
      await appendMessage(projectId, sessionId, {
        role: "assistant",
        agent: "mate",
        parts: [{ type: "text", text: "答 " + "y".repeat(100) }],
      });
    }
    process.env.TALEMATE_SUMMARY_CHUNK_CHARS = "120";
    try {
      const compaction = await compact({ projectId, sessionId, model: MODEL });
      expect(compaction?.role).toBe("compaction");
      expect((compaction?.summary ?? "").length).toBeGreaterThan(0);
    } finally {
      delete process.env.TALEMATE_SUMMARY_CHUNK_CHARS;
    }
  });

  test("第二次压缩吃的是窗口，不会把已压掉的段落再总结一遍", async () => {
    const sessionId = nextSession();
    await createSession(projectId, { id: sessionId, projectId, title: "二次压缩", agent: "mate" });
    for (let i = 0; i < 5; i++) {
      await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: `问 ${i}` });
      await appendMessage(projectId, sessionId, {
        role: "assistant",
        agent: "mate",
        parts: [{ type: "text", text: `答 ${i}` }],
      });
    }
    await compact({ projectId, sessionId, model: MODEL });
    const afterFirst = loadModelWindow(await loadMessages(projectId, sessionId));
    for (let i = 0; i < 4; i++) {
      await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: `续 ${i}` });
      await appendMessage(projectId, sessionId, {
        role: "assistant",
        agent: "mate",
        parts: [{ type: "text", text: `接 ${i}` }],
      });
    }
    const window = loadModelWindow(await loadMessages(projectId, sessionId));
    const second = await compact({ projectId, sessionId, model: MODEL, messages: window });
    expect(second?.role).toBe("compaction");
    const afterSecond = loadModelWindow(await loadMessages(projectId, sessionId));
    expect(afterSecond[0]?.role).toBe("compaction");
    // 第二次的输入应该是第一次的窗口，而不是从最早的消息开始
    expect(afterFirst[0]?.role).toBe("compaction");
  });
});
