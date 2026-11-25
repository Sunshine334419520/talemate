/**
 * 判据执行的守卫：每条 Check 都要给出 pass/fail + 能定位的证据。
 *
 * 这里用合成快照，不跑 Session、不调模型；测的是"判据读对了没有"，不是 case 好坏。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase } from "../eval/types";
import type { StoredMessage } from "../src/core/types";
import type { AnyTraceEvent } from "../src/telemetry/events";
import type { ChangeRecord } from "../src/storage/change_index";
import { runChecks, type TurnSnapshot } from "../eval/checks";

let fixtureRoot: string;
let prevHome: string | undefined;

const EVENTS: AnyTraceEvent[] = [
  { schemaVersion: 1, sessionId: "s", seq: 1, time: 1, type: "step/start", data: { step: 0 } },
  { schemaVersion: 1, sessionId: "s", seq: 2, time: 2, type: "step/end", data: { step: 0, finish: "tool_calls", durationMs: 5, usage: { input: 100, output: 20 } } },
  { schemaVersion: 1, sessionId: "s", seq: 3, time: 3, type: "step/start", data: { step: 1 } },
  { schemaVersion: 1, sessionId: "s", seq: 4, time: 4, type: "step/end", data: { step: 1, finish: "stop", durationMs: 5, usage: { input: 50, output: 10 } } },
];

const MESSAGES: StoredMessage[] = [
  { seq: 1, role: "user", agent: "mate", ts: 1, text: "把核心设定改一下" },
  {
    seq: 2,
    role: "assistant",
    agent: "mate",
    ts: 2,
    finish: "tool_calls",
    parts: [
      { type: "text", text: "我先看一下设定。" },
      { type: "tool", id: "c1", name: "write", state: "completed" },
      { type: "tool", id: "c2", name: "propose-plan", state: "completed", halt: true },
    ],
  },
];

const CHANGES: ChangeRecord[] = [
  {
    type: "change",
    turnSeq: 1,
    messageSeq: 2,
    callId: "c2",
    path: "design/core.md",
    kind: "modified",
    additions: 2,
    deletions: 1,
    ts: 2,
    user: "把核心设定改一下",
  },
];

function snapshot(files: Record<string, string>): TurnSnapshot {
  return { files, messages: MESSAGES, events: EVENTS, changes: CHANGES };
}

const CASE: EvalCase = {
  id: "workflow-fixture",
  family: "workflow",
  base: true,
  brief: "x",
  checks: [
    { kind: "file-exists", path: "design/core.md" },
    { kind: "file-absent", path: "chapters/chapter_ch2_v1.md" },
    { kind: "file-contains", path: "design/core.md", text: "旧书店" },
    { kind: "file-matches", path: "design/core.md", pattern: "^# 核心设定" },
    { kind: "file-unchanged", path: "design/core.md", against: "fixture" },
    { kind: "tool-called", name: "propose-plan" },
    { kind: "tool-not-called", name: "edit" },
    { kind: "tool-order", names: ["write", "propose-plan"] },
    { kind: "turn-halted", afterTool: "propose-plan" },
    { kind: "change-recorded", path: "design/core.md", changeKind: "modified" },
    { kind: "max-steps", n: 2 },
    { kind: "max-tokens", n: 180 },
    { kind: "event-exists", type: "step/start" },
    { kind: "event-count-at-most", type: "step/start", n: 2 },
  ],
  budget: { maxTurns: 1, maxSteps: 10, maxTokens: 1000 },
};

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "talemate-eval-checks-"));
  await mkdir(join(fixtureRoot, "design"), { recursive: true });
  await writeFile(join(fixtureRoot, "design/core.md"), "# 核心设定\n\n旧书店。\n", "utf-8");
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
});

describe("判据执行", () => {
  test("全部命中时每条都 pass，并带证据", async () => {
    const snapshots = [
      snapshot({ "design/core.md": "# 核心设定\n\n旧书店。\n" }),
      snapshot({
        "design/core.md": "# 核心设定\n\n旧书店。\n",
        "chapters/chapter_ch1_v1.md": "# 第一章\n\n沈越走进来。\n",
      }),
    ];
    const results = await runChecks(CASE, snapshots, fixtureRoot);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
    expect(results.find((r) => r.id.startsWith("tool-order"))?.detail).toContain("write→propose-plan");
  });

  test("afterTurn 看的是那一刻的快照，不拿最后一轮冒充", async () => {
    const snapshots = [
      snapshot({ "design/core.md": "# 核心设定\n\n旧书店。\n" }),
      snapshot({
        "design/core.md": "# 核心设定\n\n旧书店。\n",
        "chapters/chapter_ch1_v1.md": "# 第一章\n\n沈越走进来。\n",
      }),
    ];
    const atTurn: EvalCase = {
      ...CASE,
      checks: [
        { kind: "file-exists", path: "chapters/chapter_ch1_v1.md" },
        { kind: "file-exists", path: "chapters/chapter_ch1_v1.md", afterTurn: 0 },
      ],
    };
    const results = await runChecks(atTurn, snapshots, fixtureRoot);
    // 第一轮还没有这一章，最后一轮才有：afterTurn 必须看那一刻，不拿最后一轮冒充
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]?.detail).toContain("不存在");
  });

  test("失败时给出期望与实际，不只是一条红叉", async () => {
    const broken: EvalCase = {
      ...CASE,
      checks: [
        { kind: "file-contains", path: "design/core.md", text: "不存在的句子" },
        { kind: "file-unchanged", path: "design/core.md", against: "fixture" },
        { kind: "tool-called", name: "edit" },
        { kind: "max-tokens", n: 10 },
      ],
    };
    const snapshots = [snapshot({ "design/core.md": "# 核心设定\n\n改过了。\n" })];
    const results = await runChecks(broken, snapshots, fixtureRoot);
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(results[0]?.detail).toContain("不存在的句子");
    expect(results[1]?.detail).toContain("与 fixture 不同");
    expect(results[2]?.detail).toContain("没有调用 edit");
    expect(results[3]?.detail).toContain("180 token");
  });

  test("file-equals 比完整字节，不是 contains", async () => {
    const snap = snapshot({ "design/core.md": "# 核心设定\n\n旧书店。\n" });
    const out = await runChecks(
      {
        ...CASE,
        checks: [
          { kind: "file-equals", path: "design/core.md", text: "# 核心设定\n\n旧书店。\n" },
          { kind: "file-equals", path: "design/core.md", text: "# 核心设定\n\n旧书店。" },
        ],
      },
      [snap],
      fixtureRoot,
    );
    expect(out.map((r) => r.ok)).toEqual([true, false]);
  });

  test("file-not-contains 与 assistant-text-contains", async () => {
    const snap = snapshot({ "design/core.md": "# 核心设定\n\n旧书店。\n" });
    const out = await runChecks(
      {
        ...CASE,
        checks: [
          { kind: "file-not-contains", path: "design/core.md", text: "不存在的句子" },
          { kind: "file-not-contains", path: "design/core.md", text: "旧书店" },
          { kind: "assistant-text-contains", text: "我先看一下" },
          { kind: "assistant-text-contains", text: "没有这句" },
        ],
      },
      [snap],
      fixtureRoot,
    );
    expect(out.map((r) => r.ok)).toEqual([true, false, true, false]);
  });

  test("afterTurn 超出实际轮数时判失败，不静默取最后一轮", async () => {
    const snapshots = [snapshot({ "design/core.md": "# 核心设定\n\n旧书店。\n" })];
    const out = await runChecks(
      { ...CASE, checks: [{ kind: "file-exists", path: "design/core.md", afterTurn: 3 }] },
      snapshots,
      fixtureRoot,
    );
    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.detail).toContain("超出实际轮数");
  });

  test("perception-plan 读最近一条 plan 的指标，不只看事件存在", async () => {
    const plan = (metrics: { p0Coverage: number; stale: number }): AnyTraceEvent => ({
      schemaVersion: 1,
      sessionId: "s",
      seq: 9,
      time: 9,
      type: "perception/plan",
      data: {
        step: 0,
        purpose: "prose",
        hash: "p",
        builtAt: 1,
        budget: { ceiling: 100, used: 10 },
        decisions: [],
        missing: [],
        metrics: {
          p0Coverage: metrics.p0Coverage,
          dropped: 0,
          compressionRatio: 1,
          stale: metrics.stale,
          duplicate: 0,
          missing: 0,
          deferred: 0,
        },
      },
    });
    const clean: TurnSnapshot = { files: {}, messages: MESSAGES, events: [...EVENTS, plan({ p0Coverage: 1, stale: 0 })], changes: [] };
    const stale: TurnSnapshot = { files: {}, messages: MESSAGES, events: [...EVENTS, plan({ p0Coverage: 0.5, stale: 1 })], changes: [] };
    const checks: EvalCase = {
      ...CASE,
      checks: [{ kind: "perception-plan", minP0Coverage: 1, maxStale: 0 }],
    };
    const ok = await runChecks(checks, [clean], fixtureRoot);
    expect(ok[0]?.ok).toBe(true);
    const bad = await runChecks(checks, [stale], fixtureRoot);
    expect(bad[0]?.ok).toBe(false);
    expect(bad[0]?.detail).toContain("P0 覆盖 0.50");
    expect(bad[0]?.detail).toContain("stale 1");
  });
});
