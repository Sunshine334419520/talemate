/**
 * 提问契约的离线测试：模型入参、用户答案、tool 结果文案、pending 投影、以及 runner 的 halt。
 *
 * 这些用例盯的是“沉默不能被翻译成同意”：pending 必须带 halt；跳过必须是显式空答案；
 * 不合法的 label 不能进入模型上下文。全部离线，不需要模型。
 */
import { describe, expect, test } from "bun:test";
import type {
  AskAnswer,
  AskOutcome,
  AskQuestion,
  AskRecord,
  AskRequest,
  StoredMessage,
  ToolContext,
} from "../src/core/types";
import {
  mergeJournalAsk,
  openAsks,
  parseAskArgs,
  renderAnswerMessage,
  renderAskResult,
  renderOpenAskNote,
  renderPendingResult,
  settledCallIds,
  validateAnswers,
} from "../src/session/asks";
import { askUserTool } from "../src/tool/core_tools";
import { ToolRegistry } from "../src/tool/registry";
import { executeToolPart } from "../src/tool/runner";

const QUESTIONS: AskQuestion[] = [
  {
    id: "focus",
    header: "第 4 章 · 重心",
    question: "沈越第一次进县城，这一章的重心放在哪？",
    options: [
      { label: "先写他眼里的县城（推荐）", description: "把新场景立住。" },
      { label: "先写他和牙人的拉扯", description: "冲突来得快。" },
    ],
  },
  {
    id: "artifacts",
    question: "除了正文，这一章还要落哪些东西？",
    multiSelect: true,
    options: [{ label: "角色卡 · 陈六" }, { label: "伏笔账 · 那封信" }],
  },
];

const ARGS = {
  questions: [
    {
      id: "focus",
      header: "第 4 章 · 重心",
      question: "沈越第一次进县城，这一章的重心放在哪？",
      options: [
        { label: "先写他眼里的县城（推荐）", description: "把新场景立住。" },
        { label: "先写他和牙人的拉扯", description: "冲突来得快。" },
      ],
    },
    {
      id: "artifacts",
      question: "除了正文，这一章还要落哪些东西？",
      multi_select: true,
      options: [{ label: "角色卡 · 陈六" }, { label: "伏笔账 · 那封信" }],
    },
  ],
};

function makeCtx(
  outcome: AskOutcome,
  opts: { deny?: boolean } = {},
): { ctx: ToolContext; calls: AskRequest[] } {
  const calls: AskRequest[] = [];
  const ctx: ToolContext = {
    projectId: "test-project",
    sessionId: "test-session",
    agent: "mate",
    callId: "call-1",
    signal: new AbortController().signal,
    confirm: async () => "once",
    check: () => (opts.deny === true ? "deny" : "allow"),
    ask: async () => "allow",
    askUser: async (req) => {
      calls.push(req);
      return outcome;
    },
    showProposal: () => {},
    getProposal: () => undefined,
    setProposal: () => {},
    clearProposal: () => {},
    setMode: () => {},
    getMode: () => undefined,
    readDoc: async () => undefined,
    listIndex: async () => "",
    searchDocs: async () => "",
    runSubagent: async () => ({ text: "", sessionId: "sub-test" }),
    loadSkill: async () => undefined,
    webSettings: async () => ({}),
  };
  return { ctx, calls };
}

function toolMessage(ask: AskRecord): StoredMessage {
  return {
    seq: 1,
    role: "assistant",
    ts: 1,
    finish: "tool_calls",
    parts: [{ type: "tool", id: ask.callId, name: "ask-user", state: "completed", ask }],
  };
}

function answerMessage(ask: AskRecord, answers: AskAnswer[]): StoredMessage {
  return {
    seq: 2,
    role: "user",
    ts: 2,
    text: "回答",
    answersTo: { callId: ask.callId, questions: ask.questions, answers },
  };
}

function record(outcome: AskRecord["outcome"], answers?: AskAnswer[]): AskRecord {
  return {
    callId: "call-1",
    questions: QUESTIONS,
    outcome,
    ...(answers === undefined ? {} : { answers }),
    at: 1,
  };
}

describe("ask-user · 模型入参", () => {
  test("合法的两题：multi_select 映射成域字段，默认 120 秒", () => {
    const parsed = parseAskArgs(ARGS);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.questions).toHaveLength(2);
    expect(parsed.value.questions[1].multiSelect).toBe(true);
    expect(parsed.value.timeoutMs).toBe(120_000);
  });

  test("timeout -1 = 不限时，正数换算成毫秒", () => {
    const forever = parseAskArgs({ ...ARGS, timeout: -1 });
    const timed = parseAskArgs({ ...ARGS, timeout: 30 });
    if (!forever.ok || !timed.ok) throw new Error("应当合法");
    expect(forever.value.timeoutMs).toBeUndefined();
    expect(timed.value.timeoutMs).toBe(30_000);
  });

  test("缺 questions / 超过 3 题 / 重复 id / 单选项 / 重复 label 都被挡下", () => {
    const failures: string[] = [];
    const cases: [string, unknown][] = [
      ["缺 questions", {}],
      ["超过 3 题", { questions: [1, 2, 3, 4].map((n) => ({ id: `q${n}`, question: `问题 ${n}` })) }],
      [
        "重复 id",
        { questions: [{ id: "x", question: "甲" }, { id: "x", question: "乙" }] },
      ],
      [
        "只有一个选项",
        { questions: [{ id: "x", question: "甲", options: [{ label: "唯一" }] }] },
      ],
      [
        "重复 label",
        {
          questions: [
            {
              id: "x",
              question: "甲",
              options: [{ label: "同一个" }, { label: "同一个" }],
            },
          ],
        },
      ],
      ["timeout 非法", { ...ARGS, timeout: 0 }],
    ];
    for (const [name, args] of cases) {
      const parsed = parseAskArgs(args);
      if (parsed.ok) failures.push(`${name} 应当失败`);
    }
    expect(failures).toEqual([]);
  });
});

describe("ask-user · 用户答案", () => {
  test("合法答案（含跳过、多选、自定义）", () => {
    expect(
      validateAnswers(QUESTIONS, [
        { id: "focus", selected: ["先写他眼里的县城（推荐）"] },
        { id: "artifacts", selected: ["角色卡 · 陈六"], custom: "再加一条" },
      ]),
    ).toBeUndefined();
    expect(
      validateAnswers(QUESTIONS, [
        { id: "focus", selected: [] },
        { id: "artifacts", selected: [] },
      ]),
    ).toBeUndefined();
  });

  test("未知 id、缺题、未知 label、单选多选都被挡下", () => {
    const failures: string[] = [];
    const cases: [string, AskAnswer[]][] = [
      ["未知 id", [{ id: "nope", selected: [] }, { id: "artifacts", selected: [] }]],
      ["缺题", [{ id: "focus", selected: [] }]],
      [
        "未知 label",
        [
          { id: "focus", selected: ["不存在的选项"] },
          { id: "artifacts", selected: [] },
        ],
      ],
      [
        "单选多选",
        [
          { id: "focus", selected: ["先写他眼里的县城（推荐）", "先写他和牙人的拉扯"] },
          { id: "artifacts", selected: [] },
        ],
      ],
    ];
    for (const [name, answers] of cases) {
      if (validateAnswers(QUESTIONS, answers) === undefined) failures.push(`${name} 应当失败`);
    }
    expect(failures).toEqual([]);
  });
});

describe("ask-user · tool 文案", () => {
  test("已回答：跳过写 skipped，自定义单独成项", () => {
    const text = renderAskResult(
      record("answered", [
        { id: "focus", selected: [] },
        { id: "artifacts", selected: ["角色卡 · 陈六"], custom: "再加一条" },
      ]),
    );
    expect(text).toContain('<answer id="focus" status="skipped" />');
    expect(text).toContain("<selected>角色卡 · 陈六</selected>");
    expect(text).toContain("<custom>再加一条</custom>");
  });

  test("pending 的结果明确写出“不是同意”，并带 call_id", () => {
    const text = renderPendingResult(record("pending"));
    expect(text).toContain("pending");
    expect(text).toContain("不是同意");
    expect(text).toContain("call-1");
  });

  test("迟到回答的自包含用户消息", () => {
    const text = renderAnswerMessage(
      QUESTIONS,
      [
        { id: "focus", selected: ["先写他眼里的县城（推荐）"] },
        { id: "artifacts", selected: [] },
      ],
      "call-1",
    );
    expect(text).toContain("[answer_to_pending_question call_id=call-1]");
    expect(text).toContain("沈越第一次进县城");
    expect(text).toContain("选择：先写他眼里的县城");
    expect(text).toContain("（跳过）");
  });
});

describe("ask-user · 未答问题投影", () => {
  test("pending 且没有迟到回答 = 仍然开着；答掉之后就不再开", () => {
    const pending = record("pending");
    expect(openAsks([toolMessage(pending)])).toHaveLength(1);
    const answered = answerMessage(pending, [
      { id: "focus", selected: [] },
      { id: "artifacts", selected: [] },
    ]);
    expect(openAsks([toolMessage(pending), answered])).toEqual([]);
    expect(settledCallIds([toolMessage(pending), answered]).has("call-1")).toBe(true);
    expect(openAsks([toolMessage(record("answered", []))])).toEqual([]);
  });

  test("journal 只在消息里还没有同 callId 时才并进来", () => {
    const journal = { callId: "call-1", questions: QUESTIONS, at: 1 };
    expect(mergeJournalAsk([], journal)).toHaveLength(1);
    expect(mergeJournalAsk([{ callId: "call-1", questions: QUESTIONS, at: 1 }], journal)).toHaveLength(1);
  });

  test("系统注记把 pending 的语义与问题一起交给模型", () => {
    const note = renderOpenAskNote([{ callId: "call-1", questions: QUESTIONS, at: 1 }]);
    expect(note).toBeDefined();
    expect(note ?? "").toContain("不是同意");
    expect(note ?? "").toContain("沈越第一次进县城");
  });
});

describe("ask-user · 工具与 runner", () => {
  test("answered：不 halt，记录带着答案", async () => {
    const answers: AskAnswer[] = [
      { id: "focus", selected: ["先写他眼里的县城（推荐）"] },
      { id: "artifacts", selected: [] },
    ];
    const { ctx, calls } = makeCtx({ kind: "answered", answers });
    const res = await askUserTool.execute(ARGS, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].callId).toBe("call-1");
    expect(res.ask?.outcome).toBe("answered");
    expect(res.ask?.answers).toEqual(answers);
    expect(res.halt).toBeUndefined();
    expect(res.output).toContain("<user_answers");
  });

  test("pending / cancelled：halt，且记录可以回看", async () => {
    const pending = await askUserTool.execute(
      ARGS,
      makeCtx({ kind: "pending", callId: "call-1" }).ctx,
    );
    expect(pending.halt).toBe(true);
    expect(pending.ask?.outcome).toBe("pending");
    const cancelled = await askUserTool.execute(
      ARGS,
      makeCtx({ kind: "cancelled", reason: "aborted" }).ctx,
    );
    expect(cancelled.halt).toBe(true);
    expect(cancelled.ask?.outcome).toBe("cancelled");
  });

  test("权限 deny：不打扰用户，回自愈文案", async () => {
    const { ctx, calls } = makeCtx({ kind: "pending", callId: "call-1" }, { deny: true });
    const res = await askUserTool.execute(ARGS, ctx);
    expect(calls).toHaveLength(0);
    expect(res.output).toContain("不允许打断用户");
  });

  test("入参不合法：回自愈文案，不调用 askUser", async () => {
    const { ctx, calls } = makeCtx({ kind: "pending", callId: "call-1" });
    const res = await askUserTool.execute({ questions: [] }, ctx);
    expect(calls).toHaveLength(0);
    expect(res.output).toContain("questions");
  });

  test("runner：把 ask 记录挂到 part 上，并尊重 per-result halt", async () => {
    const registry = new ToolRegistry();
    registry.register(askUserTool);
    const { ctx } = makeCtx({ kind: "pending", callId: "call-1" });
    const part = await executeToolPart(
      "mate",
      { id: "call-1", name: "ask-user", input: ARGS },
      registry,
      ctx,
    );
    expect(part.type).toBe("tool");
    if (part.type !== "tool") return;
    expect(part.state).toBe("completed");
    expect(part.halt).toBe(true);
    expect(part.ask?.outcome).toBe("pending");
  });
});
