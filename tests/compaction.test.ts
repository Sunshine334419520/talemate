/**
 * 上下文折叠的守卫（docs/compaction.md §13.2 的离线用例）。
 *
 * 全部用 mock provider / 注入的 summarizer，不打网络：这里钉的是"累积、工具账、最近原文、
 * 计划、决定、原子性、降级、迟滞、system 超限、重启、旧格式"这些结构，不是摘要文笔。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionRecord, DecisionEntry, ModelConfig, StoredMessage } from "../src/core/types";
import { PLAN_KEY } from "../src/core/types";
import { contextWindow } from "../src/core/windows";
import { budgetFor, estimateMessagesTokens, estimateTokens, preflight } from "../src/context/budget";
import { foldContext } from "../src/context/fold";
import { evidenceFrom, decisionsFrom } from "../src/context/ledger";
import { selectFold, turnsOf, previousRecordOf, legacyRecordOf } from "../src/context/segments";
import { parseSummaryOutput, archiveFold } from "../src/context/summary";
import { renderContextState } from "../src/context/assemble";
import { buildPinned } from "../src/context/project_state";
import type { ContextBudget } from "../src/context/budget";
import type { Summarizer } from "../src/context/summary";
import {
  appendContextRecord,
  appendMessage,
  appendProposalDecision,
  appendProposalPresented,
  createSession,
  loadMessages,
  loadModelWindow,
} from "../src/storage/session-store";
import { createProject, writeDoc } from "../src/storage/project";
import { planRelPath, readPlan, savePlan } from "../src/framework/plan";
import { hashText } from "../src/core/hash";
import { eventLogFor } from "../src/telemetry/log";
import { projectMessages } from "../src/telemetry/projection";
import { openSession } from "../src/session/session";

let home: string;
let prevHome: string | undefined;
let projectId: string;
let serial = 0;

const MODEL: ModelConfig = { provider: "mock", model: "mock", maxTokens: 1000, reasoning: "off" };

const BUDGET: ContextBudget = {
  model: "mock",
  window: 128_000,
  maxOutput: 1000,
  safety: 4096,
  usable: 100_000,
  trigger: 40,
  lowWater: 10,
  recentFloor: 6,
  summaryBudget: 1200,
  systemCap: 40_000,
  toolsCap: 15_000,
  stateCap: 10_000,
};

function nextSession(): string {
  serial++;
  return `fold-${serial}`;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-fold-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = home;
  projectId = (await createProject({ title: "折叠测试" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

function user(seq: number, text: string): StoredMessage {
  return { seq, role: "user", agent: "mate", ts: seq, text };
}

function assistant(seq: number, text: string, tool?: StoredMessage["parts"]): StoredMessage {
  return {
    seq,
    role: "assistant",
    agent: "mate",
    ts: seq,
    parts: [{ type: "text", text }, ...(tool ?? [])],
  };
}

const FOUR_SECTIONS = (marker: string): string =>
  `<accomplished>\n- 完成了 ${marker}\n</accomplished>\n<intent>\n- 用户要求 ${marker}\n</intent>\n<open>\n- 还没定\n</open>\n<pointers>\n- state/foreshadowing.md\n</pointers>`;

function fake(marker = "甲"): Summarizer {
  return async ({ user }) => FOUR_SECTIONS(user.includes("沈越") ? `${marker} 沈越` : marker);
}

async function seedSession(
  turns: number,
  opts: { tool?: boolean } = {},
): Promise<{ sessionId: string; messages: StoredMessage[] }> {
  const sessionId = nextSession();
  await createSession(projectId, { id: sessionId, projectId, title: "折叠", agent: "mate" });
  for (let i = 1; i <= turns; i++) {
    await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: `第${i}问` });
    if (opts.tool && i === 2) {
      await appendMessage(projectId, sessionId, {
        role: "assistant",
        agent: "mate",
        parts: [
          { type: "text", text: `第${i}答` },
          {
            type: "tool",
            id: `c${i}`,
            name: "read",
            state: "completed",
            input: JSON.stringify({ path: "state/foreshadowing.md", section: "账册" }),
            output: `${"账册正文".repeat(50)} @a1b2c3`,
          },
        ],
      });
    } else {
      await appendMessage(projectId, sessionId, {
        role: "assistant",
        agent: "mate",
        parts: [{ type: "text", text: `第${i}答` }],
      });
    }
  }
  return { sessionId, messages: await loadMessages(projectId, sessionId) };
}

async function foldOnce(
  sessionId: string,
  summary: Summarizer,
  budget: ContextBudget = BUDGET,
  extra: { decisions?: DecisionEntry[]; plan?: { chapter: number; path: string; hash: string }; open?: string[] } = {},
): Promise<CompactionRecord | undefined> {
  const messages = loadModelWindow(await loadMessages(projectId, sessionId));
  const outcome = await foldContext({
    projectId,
    sessionId,
    model: MODEL,
    messages,
    budget,
    system: "fold",
    pinned: { decisions: extra.decisions ?? [] },
    decisions: extra.decisions ?? [],
    open: extra.open ?? [],
    ...(extra.plan === undefined ? {} : { plan: extra.plan }),
    summarizer: summary,
  });
  if (outcome.record === undefined) return undefined;
  await appendContextRecord(projectId, sessionId, outcome.record);
  return outcome.record;
}

describe("预算与估算", () => {
  test("token 估算：CJK 按 1、其余按 0.28", () => {
    expect(estimateTokens("中".repeat(10))).toBe(10);
    expect(estimateTokens("x".repeat(100))).toBe(28);
  });

  test("1M 模型的预算是窗口的 85%，不是固定值", () => {
    expect(contextWindow("deepseek-v4-flash")).toBe(1_000_000);
    const b = budgetFor("deepseek-v4-flash", 32_000);
    expect(b.trigger).toBe(Math.round((1_000_000 - 32_000 - 4096) * 0.85));
  });

  test("提示词底子超 55% 时 preflight 拒绝，且文案带数字", () => {
    const small: ContextBudget = { ...BUDGET, usable: 1000 };
    const r = preflight(small, 6000, 0);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("提示词底子过大");
    expect(preflight(small, 100, 100).ok).toBe(true);
    // 分层上限：合计没超 55%，但单独一层超了
    const layered: ContextBudget = { ...BUDGET, usable: 1000, systemCap: 400, toolsCap: 150, stateCap: 100 };
    expect(preflight(layered, 750, 0).message).toContain("40%");
    expect(preflight(layered, 0, 600).message).toContain("15%");
  });
});

describe("段与选择", () => {
  test("压缩单位是 turn：Q/A 不拆，最近 turn 原文保留", () => {
    const messages: StoredMessage[] = [
      user(1, "问一"),
      assistant(2, "答一"),
      user(3, "问二"),
      assistant(4, "答二"),
    ];
    expect(turnsOf(messages).map((t) => [t.fromSeq, t.toSeq])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    const sel = selectFold(messages, { recentFloorTokens: 999, needToDropTokens: 999 });
    expect(sel.picked).toEqual([]);
  });

  test("未闭合的 turn 不压：工具还在跑的段落会截止选择", () => {
    const running: StoredMessage = {
      seq: 2,
      role: "assistant",
      ts: 2,
      parts: [{ type: "tool", id: "c", name: "read", state: "running" }],
    };
    const sel = selectFold([user(1, "问一"), running, user(3, "问二"), assistant(4, "答二")], {
      recentFloorTokens: 0,
      needToDropTokens: 999,
    });
    expect(sel.picked).toEqual([]);
  });

  test("单个 turn 超预算只修剪工具结果，标 intraTurn", () => {
    const big: StoredMessage = {
      seq: 2,
      role: "assistant",
      ts: 2,
      parts: [{ type: "tool", id: "c", name: "read", state: "completed", output: "x".repeat(10_000) }],
    };
    const sel = selectFold([user(1, "问"), big, user(3, "问二"), assistant(4, "答二")], {
      recentFloorTokens: 0,
      needToDropTokens: 999_999,
      oversizedTurnTokens: 100,
    });
    expect(sel.intraTurn).toBe(true);
    const tool = sel.picked.find((m) => m.seq === 2)?.parts?.[0];
    expect(tool?.type === "tool" && (tool.output ?? "").length < 1000).toBe(true);
  });
});

describe("折叠 · 累积与账本", () => {
  test("第二次折叠包含第一次的摘要（不是从零重写）", async () => {
    const { sessionId } = await seedSession(5);
    const first = await foldOnce(sessionId, fake("沈越"));
    expect(first?.summary.session).toContain("沈越");

    for (let i = 6; i <= 9; i++) {
      await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: `第${i}问` });
      await appendMessage(projectId, sessionId, {
        role: "assistant",
        agent: "mate",
        parts: [{ type: "text", text: `第${i}答` }],
      });
    }
    const second = await foldOnce(sessionId, fake("林晚"));
    expect(second?.previousId).toBe(first?.id);
    expect(second?.summary.session).toContain("沈越");
    expect(second?.summary.session).toContain("林晚");
  });

  test("工具结果进证据账：路径、小节与 rev 都在", async () => {
    const { sessionId } = await seedSession(5, { tool: true });
    const record = await foldOnce(sessionId, fake());
    const evidence = record?.evidence.find((e) => e.kind === "read");
    expect(evidence?.path).toBe("state/foreshadowing.md");
    expect(evidence?.section).toBe("账册");
    expect(evidence?.rev).toBe("a1b2c3");
    expect(record?.dropped.toolResults).toBe(1);
  });

  test("最近 turn 的结构与内容原样留在窗口里（tool part 不拍平）", async () => {
    const { sessionId } = await seedSession(6, { tool: true });
    await foldOnce(sessionId, fake());
    const window = loadModelWindow(await loadMessages(projectId, sessionId));
    const latest = window.at(-1);
    expect(latest?.role).toBe("assistant");
    expect(latest?.parts?.[0]).toEqual({ type: "text", text: "第6答" });
    expect(window[0]?.role).toBe("context");
  });

  test("决定账保留用户原话，跨折叠不丢", async () => {
    const { sessionId } = await seedSession(5);
    const decision: DecisionEntry = {
      at: Date.now(),
      proposal: PLAN_KEY,
      chapter: 1,
      verdict: "refine",
      note: "把账册那一场往后挪一章",
    };
    await appendProposalDecision(projectId, sessionId, decision);
    const events = await eventLogFor(projectId, sessionId).read();
    expect(decisionsFrom(events)).toEqual([decision]);
    const record = await foldOnce(sessionId, fake(), BUDGET, { decisions: decisionsFrom(events) });
    expect(record?.pinned.decisions[0]?.note).toBe("把账册那一场往后挪一章");
  });

  test("渲染的 <context-state> 只带对话投影与恢复坐标", () => {
    const record: CompactionRecord = {
      id: "r1",
      at: 1,
      consumed: { fromSeq: 1, toSeq: 4, turns: 2 },
      summary: { session: "第 13 章按用户要求让林晚保持沉默", accomplished: [], intent: [], open: ["账册何时暴露"], pointers: ["state/foreshadowing.md"] },
      pinned: {
        decisions: [{ at: 1, proposal: "plan:13", verdict: "refine", note: "把账册往后挪" }],
        project: "写到第 12 章",
      },
      evidence: [{ kind: "read", path: "state/foreshadowing.md", rev: "a1b2c3", label: "read", chars: 812 }],
      budget: { usable: 1000, trigger: 850, before: 900, after: 200 },
      dropped: { messages: 10, toolResults: 3, toolChars: 5000 },
      degraded: false,
    };
    const text = renderContextState(record);
    expect(text).toContain("<session>");
    expect(text).toContain("read state/foreshadowing.md @a1b2c3");
    expect(text).toContain("refine plan:13");
    expect(text).not.toContain("世界规则");
  });
});

describe("折叠 · 失败与降级", () => {
  test("没有可压段时拒绝折叠，不写事件", async () => {
    const { sessionId, messages } = await seedSession(1);
    const before = (await eventLogFor(projectId, sessionId).read()).length;
    const outcome = await foldContext({
      projectId,
      sessionId,
      model: MODEL,
      messages,
      budget: { ...BUDGET, trigger: 0, lowWater: 0 },
      system: "fold",
      pinned: { decisions: [] },
      decisions: [],
      open: [],
      summarizer: fake(),
    });
    expect(outcome.record).toBeUndefined();
    expect(outcome.refused).toContain("可折叠");
    expect((await eventLogFor(projectId, sessionId).read()).length).toBe(before);
  });

  test("summarizer 抛错 → 确定性降级：工具结果变指针，user 原文保留", async () => {
    const { sessionId } = await seedSession(5, { tool: true });
    const boom: Summarizer = async () => {
      throw new Error("summarizer 超时");
    };
    const record = await foldOnce(sessionId, boom);
    expect(record?.degraded).toBe(true);
    expect(record?.summary.session).toContain("第1问");
    expect(record?.summary.session).not.toContain("账册正文账册正文");
  });

  test("降级折叠仍累积上一次摘要，不从零重写", async () => {
    const { sessionId } = await seedSession(5);
    const first = await foldOnce(sessionId, fake("沈越"));
    expect(first?.summary.session).toContain("沈越");
    for (let i = 6; i <= 9; i++) {
      await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: `第${i}问` });
      await appendMessage(projectId, sessionId, {
        role: "assistant",
        agent: "mate",
        parts: [{ type: "text", text: `第${i}答` }],
      });
    }
    const boom: Summarizer = async () => {
      throw new Error("timeout");
    };
    const second = await foldOnce(sessionId, boom);
    expect(second?.degraded).toBe(true);
    expect(second?.summary.session).toContain("沈越");
  });

  test("输出缺段 → 重试一次后仍失败则降级", async () => {
    let calls = 0;
    const bad: Summarizer = async () => {
      calls++;
      return "只有一段散文，没有 XML";
    };
    const { sessionId } = await seedSession(5);
    const record = await foldOnce(sessionId, bad);
    expect(calls).toBe(2);
    expect(record?.degraded).toBe(true);
  });

  test("摘要输出校验：四段齐全且不超预算", () => {
    const good = parseSummaryOutput(FOUR_SECTIONS("甲"), BUDGET);
    expect(good.ok).toBe(true);
    expect(good.summary?.pointers).toEqual(["state/foreshadowing.md"]);
    expect(parseSummaryOutput("<accomplished>\n- x\n</accomplished>", BUDGET).ok).toBe(false);
    const tooLong = parseSummaryOutput(
      `<accomplished>\n- ${"很长的内容".repeat(2000)}\n</accomplished><intent>\n- x\n</intent><open></open><pointers></pointers>`,
      { ...BUDGET, summaryBudget: 100 },
    );
    expect(tooLong.ok).toBe(false);
  });
});

describe("折叠 · 项目状态与计划", () => {
  test("pinned 现读 progress 最后 7 节与未回收承诺", async () => {
    await writeDoc(
      projectId,
      "state/progress.md",
      Array.from({ length: 9 }, (_, i) => `## 第 ${i + 1} 章\n内容 ${i + 1}\n落点 ${i + 1}\n`).join("\n"),
    );
    await writeDoc(
      projectId,
      "state/foreshadowing.md",
      "## 账册暴露\n状态：已埋\n计划第 14 章\n\n## 旧信\n状态：已回收\n",
    );
    const pinned = await buildPinned(projectId);
    expect(pinned.project).toContain("第 9 章");
    expect(pinned.project).not.toContain("第 1 章\n");
    expect(pinned.promises).toContain("账册暴露");
    expect(pinned.promises).not.toContain("旧信");
  });

  test("已批准计划在折叠后仍能进正文窗口，重开也能恢复", async () => {
    const sessionId = nextSession();
    await createSession(projectId, { id: sessionId, projectId, title: "计划", agent: "mate" });
    const content = "## 节拍\n- 先把账册藏起来";
    await savePlan(projectId, 3, content);
    const at = Date.now();
    await appendProposalPresented(projectId, sessionId, {
      proposal: PLAN_KEY,
      chapter: 3,
      path: planRelPath(3),
      hash: hashText(content).slice(0, 16),
      at,
    });
    await appendProposalDecision(projectId, sessionId, {
      at: at + 1,
      proposal: PLAN_KEY,
      chapter: 3,
      verdict: "accept",
    });

    const session = await openSession({ projectId, sessionId, model: MODEL });
    expect(session.pending.get(PLAN_KEY)?.approved).toBe(true);
    expect(session.pending.get(PLAN_KEY)?.stale).toBeUndefined();
    expect(session.planExecutionChapter).toBe(3);
    const sys = await (session as unknown as { buildSystem(agent: unknown): Promise<string> }).buildSystem(session.agent);
    expect(sys).toContain("approved-plan");
    expect(sys).toContain("先把账册藏起来");
    expect((await readPlan(projectId, 3))?.includes("先把账册藏起来")).toBe(true);
  });
});

describe("旧格式兼容", () => {
  test("role:compaction 的旧消息能被继续累积", () => {
    const legacy: StoredMessage = { seq: 4, role: "compaction", ts: 4, summary: "旧摘要：沈越在码头" };
    const prev = previousRecordOf([legacy]);
    expect(prev?.legacy).toBe(true);
    expect(prev?.summary.session).toContain("沈越");
    expect(legacyRecordOf(legacy).id).toBe("legacy-4");
  });
});

describe("投影 · 折叠窗口", () => {
  test("折叠事件把窗口起点定在 consumed.toSeq 之后，记录合成一条 context 消息", async () => {
    const { sessionId } = await seedSession(5);
    const record = await foldOnce(sessionId, fake());
    const messages = await loadMessages(projectId, sessionId);
    const window = loadModelWindow(messages);
    expect(window[0].role).toBe("context");
    expect(window[0].context?.id).toBe(record?.id);
    // 完整历史还在（提问、改动索引要扫全部），只是不在窗口里
    expect(messages.some((m) => m.role === "user" && m.seq <= (record?.consumed.toSeq ?? 0))).toBe(true);
    expect(window.some((m) => m.role === "user" && m.seq <= (record?.consumed.toSeq ?? 0))).toBe(false);
  });

  test("回退到折叠点之前时折叠失效，原文重新出现", async () => {
    const { sessionId } = await seedSession(5);
    await foldOnce(sessionId, fake());
    const before = await loadMessages(projectId, sessionId);
    expect(before.some((m) => m.role === "context")).toBe(true);
    const log = eventLogFor(projectId, sessionId);
    await log.append("session/rewind", { targetSeq: 3 });
    const fresh = await loadMessages(projectId, sessionId);
    expect(fresh.some((m) => m.role === "context")).toBe(false);
    expect(fresh.map((m) => m.seq)).toEqual([1, 2]);
  });
});

test("结构化拍板真的写进决定账（按钮不产生用户消息）", async () => {
  const { sessionId } = await seedSession(1);
  const session = await openSession({ projectId, sessionId, model: MODEL });
  session.pending.set("design/brief.md", {
    name: "design/brief.md",
    content: "# 概览\n",
    approved: false,
    at: Date.now(),
  });
  session.setMode("draft");
  session.decideProposal("accept");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const events = await eventLogFor(projectId, sessionId).read();
  const decisions = decisionsFrom(events);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.verdict).toBe("accept");
  expect(decisions[0]?.proposal).toBe("design/brief.md");
});

test("Session 集成：越高水位折一次，折完不再折（迟滞）", async () => {
  const { sessionId } = await seedSession(40);
  const session = await openSession({ projectId, sessionId, model: MODEL });
  const prevTrigger = process.env.TALEMATE_COMPACT_TOKENS;
  const prevFloor = process.env.TALEMATE_RECENT_FLOOR_TOKENS;
  process.env.TALEMATE_COMPACT_TOKENS = "400";
  process.env.TALEMATE_RECENT_FLOOR_TOKENS = "0";
  try {
    const s = session as unknown as { maybeCompact(): Promise<void> };
    await s.maybeCompact();
    const records = (await eventLogFor(projectId, sessionId).read()).filter((e) => e.type === "context/compaction");
    expect(records.length).toBe(1);
    // mock summarizer 按折叠 prompt 返回四段 XML → 正常记录
    expect(records[0].type === "context/compaction" && records[0].data.degraded).toBe(false);

    // 折完低于低水位：下一次请求不再触发
    await s.maybeCompact();
    const after = (await eventLogFor(projectId, sessionId).read()).filter((e) => e.type === "context/compaction");
    expect(after.length).toBe(1);
    expect(loadModelWindow(await loadMessages(projectId, sessionId))[0].role).toBe("context");
  } finally {
    if (prevTrigger === undefined) delete process.env.TALEMATE_COMPACT_TOKENS;
    else process.env.TALEMATE_COMPACT_TOKENS = prevTrigger;
    if (prevFloor === undefined) delete process.env.TALEMATE_RECENT_FLOOR_TOKENS;
    else process.env.TALEMATE_RECENT_FLOOR_TOKENS = prevFloor;
  }
});

test("摘要满了两级折叠：旧行进 archive，session 不超预算", () => {
    const previous: CompactionRecord = {
      id: "p",
      at: 1,
      consumed: { fromSeq: 1, toSeq: 2, turns: 1 },
      summary: {
        session: Array.from({ length: 200 }, (_, i) => `旧行 ${i}，沈越在码头`).join("\n"),
        accomplished: [],
        intent: [],
        open: [],
        pointers: [],
      },
      pinned: { decisions: [] },
      evidence: [],
      budget: { usable: 0, trigger: 0, before: 0, after: 0 },
      dropped: { messages: 0, toolResults: 0, toolChars: 0 },
      degraded: false,
    };
    const folded = archiveFold(previous, "新行：用户要求改第 3 格", { ...BUDGET, summaryBudget: 200 });
    expect(folded.archive).toBeDefined();
    expect(estimateTokens(folded.session)).toBeLessThanOrEqual(200);
    expect(folded.session).toContain("新行");
    expect(folded.archive).toContain("沈越");
});

test("估计与 window 一致：after 小于 before", async () => {
  const { sessionId } = await seedSession(6);
  const messages = loadModelWindow(await loadMessages(projectId, sessionId));
  const record = await foldOnce(sessionId, fake());
  expect((record?.budget.before ?? 0) > (record?.budget.after ?? 0)).toBe(true);
  expect(estimateMessagesTokens(messages)).toBeGreaterThan(0);
});