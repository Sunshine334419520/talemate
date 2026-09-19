/**
 * 回合边界（runLoop）离线测试：halt 停轮 / 剩余调用补 part / "同意"判定。
 *
 * 最要紧的一条是"halt 之后同回合剩下的 tool call 必须补上带 id 的 part"——漏了不会崩，
 * 只会静默产出形状坏掉的请求（assemble 只回放 completed/error 的 part，而消息登记了全部 toolCalls）。
 */
import { describe, test, expect } from "bun:test";
import type { AgentDef, AssistantPart, PendingProposal, ToolCall } from "../src/core/types";
import { toNeutralMessages } from "../src/context/assemble";
import type { AssistantTurn, NeutralMsg } from "../src/llm/types";
import { runLoop, type LoopDeps } from "../src/session/loop";
import { isAgreement, renderPendingNote } from "../src/session/session";

const AGENT: AgentDef = {
  id: "editor",
  name: "主编",
  description: "",
  mode: "primary",
  tools: [],
  system: "",
};

const call = (id: string, name: string): ToolCall => ({ id, name, input: {} });

interface Harness {
  deps: LoopDeps;
  committed: { agent: string; parts: AssistantPart[]; finish: string }[];
  executed: string[];
  /** generate 被调了几次（halt 生效则应为 1） */
  generateCalls(): number;
}

/** 假 LoopDeps：按剧本逐轮返回，并记录落盘 / 执行了什么。 */
function harness(turns: AssistantTurn[], execute: (call: ToolCall) => AssistantPart): Harness {
  const committed: Harness["committed"] = [];
  const executed: string[] = [];
  let i = 0;
  const deps: LoopDeps = {
    signal: new AbortController().signal,
    onEvent: () => {},
    commitUser: async () => {},
    buildRequest: async () => ({ system: "", messages: [] as NeutralMsg[] }),
    generate: async () => {
      const t = turns[i++];
      if (!t) throw new Error("generate 被多调了——halt 没停住本回合");
      return t;
    },
    executeTool: async (_agent, c) => {
      executed.push(c.name);
      return execute(c);
    },
    commitAssistant: async (m) => {
      committed.push(m as Harness["committed"][number]);
    },
  };
  return { deps, committed, executed, generateCalls: () => i };
}

describe("runLoop · halt", () => {
  test("停在提案那一步：剩余调用不执行但补 error part，且不再请求模型", async () => {
    const h = harness(
      [
        { text: "", toolCalls: [call("c1", "propose-design"), call("c2", "apply-design")], finish: "tool_calls" },
        { text: "不该到这里", toolCalls: [], finish: "stop" },
      ],
      (c) =>
        c.name === "propose-design"
          ? { type: "tool", id: c.id, name: c.name, state: "completed", output: "提案已交给用户审阅", halt: true }
          : { type: "tool", id: c.id, name: c.name, state: "completed", output: "落了盘" },
    );

    const reply = await runLoop(AGENT, "讲个故事", h.deps);

    expect(h.generateCalls()).toBe(1); // 没有第二次请求
    expect(h.executed).toEqual(["propose-design"]); // 第二个调用根本没执行
    expect(h.committed).toHaveLength(1); // 只落盘一条 assistant 消息

    const parts = h.committed[0].parts;
    const skipped = parts.find((p) => p.type === "tool" && p.id === "c2");
    expect(skipped?.type === "tool" && skipped.state).toBe("error");
    expect(skipped?.type === "tool" && skipped.error).toContain("本回合已结束");

    // 那一步没有正文 → 回落到工具的确认语，别给调用方一个空回复
    expect(reply).toBe("提案已交给用户审阅");
  });

  test("工具失败不 halt：留给模型同轮自纠", async () => {
    const h = harness(
      [
        { text: "", toolCalls: [call("c1", "propose-design")], finish: "tool_calls" },
        { text: "自纠后的正文", toolCalls: [], finish: "stop" },
      ],
      (c) => ({ type: "tool", id: c.id, name: c.name, state: "error", error: "文档里没有小节「金手指」" }),
    );

    const reply = await runLoop(AGENT, "x", h.deps);

    expect(h.generateCalls()).toBe(2); // 同轮继续，模型看得到自愈文案
    expect(reply).toBe("自纠后的正文");
  });

  test("有正文时不回落（正文优先）", async () => {
    const h = harness(
      [{ text: "这是前言", toolCalls: [call("c1", "propose-design")], finish: "tool_calls" }],
      (c) => ({ type: "tool", id: c.id, name: c.name, state: "completed", output: "提案已交给用户审阅", halt: true }),
    );
    expect(await runLoop(AGENT, "x", h.deps)).toBe("这是前言");
  });
});

describe("halt 之后的消息仍是合法请求形状", () => {
  test("N 个 toolCall 对应 N 条 tool 消息（缺一个都是静默坏请求）", () => {
    const parts: AssistantPart[] = [
      { type: "tool", id: "c1", name: "propose-design", state: "completed", output: "提案", halt: true },
      { type: "tool", id: "c2", name: "apply-design", state: "error", error: "本回合已结束，这次调用没有执行。" },
    ];
    const msgs = toNeutralMessages([
      { seq: 1, role: "assistant", ts: 0, agent: "editor", parts, finish: "tool_calls" },
    ]);

    const assistant = msgs.find((m) => m.role === "assistant");
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    expect(assistant?.role === "assistant" && assistant.toolCalls?.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(toolMsgs.map((m) => (m.role === "tool" ? m.toolCallId : ""))).toEqual(["c1", "c2"]);
  });
});

describe("isAgreement · 同意由 harness 判，不问模型", () => {
  test("认得的同意", () => {
    for (const s of ["没问题", "没问题。", "好", "好的", "可以", "可以，写吧", "同意", "确认", "就这样", "ok", "OK", "y"]) {
      expect(isAgreement(s)).toBe(true);
    }
  });

  test("带改动要求的一律不算同意（fail-closed）", () => {
    for (const s of [
      "没问题，但第 3 格改成雨夜",
      "好，不过主角名字再想想",
      "先别写",
      "第 2 格改一下",
      "不行",
      "再想想",
      "",
    ]) {
      expect(isAgreement(s)).toBe(false);
    }
  });
});

describe("renderPendingNote · 协议状态独立于消息历史", () => {
  const p = (over: Partial<PendingProposal>): PendingProposal => ({
    name: "core.md",
    content: "x",
    approved: false,
    at: 1,
    ...over,
  });

  test("没有提案 → 不注入（system 里不留空壳）", () => {
    expect(renderPendingNote(new Map())).toBeUndefined();
  });

  test("有提案 → 说清「哪一份 / 是否已同意」，与历史是否被压缩无关", () => {
    const note = renderPendingNote(
      new Map([
        ["core.md", p({})],
        ["wiki/world.md", p({ name: "wiki/world.md", section: "规则与秩序", approved: true })],
      ]),
    )!;
    expect(note).toContain("<pending-proposal>");
    expect(note).toContain("core.md（整篇）：用户还没同意");
    expect(note).toContain("wiki/world.md（只改「规则与秩序」这一格）：用户已表示同意 → 可以 apply-design");
    expect(note).toContain("</pending-proposal>");
  });
});
