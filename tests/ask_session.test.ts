/**
 * Session 层的提问接线：mock provider + 临时 home，验证 pending 落盘、迟到回答落成用户消息、
 * journal 在“助手消息还没提交”时能救回问题。全部离线，不需要模型。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "../src/core/types";
import { openSession, type UserIO } from "../src/session/session";
import { createProject } from "../src/storage/project";
import {
  loadMessages,
  loadPendingAsk,
  savePendingAsk,
} from "../src/storage/session-store";

let HOME: string;
let prevHome: string | undefined;
let prevTool: string | undefined;
let projectId: string;

const MODEL: ModelConfig = { provider: "mock", model: "mock", maxTokens: 1000, reasoning: "off" };

function makeIO(outcome: "pending" | "answered"): UserIO {
  return {
    onEvent: () => {},
    confirm: async () => "once",
    askUser: async (req) =>
      outcome === "pending"
        ? { kind: "pending", callId: req.callId }
        : {
            kind: "answered",
            answers: req.questions.map((q) => ({ id: q.id, selected: [], custom: "测试回答" })),
          },
  };
}

beforeAll(async () => {
  HOME = await mkdtemp(join(tmpdir(), "talemate-ask-session-"));
  prevHome = process.env.TALEMATE_HOME;
  prevTool = process.env.TALEMATE_MOCK_TOOL;
  process.env.TALEMATE_HOME = HOME;
  process.env.TALEMATE_MOCK_TOOL = "ask-user";
  projectId = (await createProject({ title: "提问接线测试" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  if (prevTool === undefined) delete process.env.TALEMATE_MOCK_TOOL;
  else process.env.TALEMATE_MOCK_TOOL = prevTool;
  await rm(HOME, { recursive: true, force: true });
});

describe("session · 提问的 pending 与迟到回答", () => {
  test("pending 落盘；迟到回答成为一条 answersTo 用户消息，问题不再开着", async () => {
    const session = await openSession({ projectId, model: MODEL, io: makeIO("pending") });
    await session.post("先问我一个问题。");

    const open = await session.openAskViews();
    expect(open).toHaveLength(1);
    const ask = open[0];
    expect(ask.questions[0].id).toBe("mock");

    const verdict = await session.preparePendingAnswer(ask.callId, [
      { id: ask.questions[0].id, selected: [], custom: "先写县城" },
    ]);
    expect(verdict).toBe("ok");
    expect(await session.openAskViews()).toEqual([]);

    const messages = await loadMessages(projectId, session.sessionId);
    const assistantAsk = messages
      .flatMap((m) => m.parts ?? [])
      .find((p) => p.type === "tool" && p.ask !== undefined);
    expect(assistantAsk?.type).toBe("tool");
    if (assistantAsk?.type === "tool") expect(assistantAsk.ask?.outcome).toBe("pending");

    const answered = messages.find((m) => m.answersTo !== undefined);
    expect(answered?.answersTo?.callId).toBe(ask.callId);
    expect(await loadPendingAsk(projectId, session.sessionId)).toBeUndefined();
  });

  test("journal 在助手消息还没提交时救回问题", async () => {
    const sessionId = "orphan-session";
    await savePendingAsk(projectId, sessionId, {
      callId: "call-orphan",
      questions: [{ id: "q", question: "这一章的重心？" }],
      at: 1,
    });
    const session = await openSession({
      projectId,
      sessionId,
      model: MODEL,
      io: makeIO("answered"),
    });
    const open = await session.openAskViews();
    expect(open).toHaveLength(1);
    expect(open[0].callId).toBe("call-orphan");
    expect(open[0].questions[0].question).toBe("这一章的重心？");
  });
});
