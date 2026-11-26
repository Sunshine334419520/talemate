/**
 * 感知 v1（shadow）的守卫：分诊的层级/动作/预算与缺失账、候选池的现取与去重、
 * 以及"shadow 不改变 system"这条架构保证。
 *
 * 全部离线；不调模型。event 的 schema 样例在 `telemetry_schema.test.ts`，eval 判据在
 * `eval_checks.test.ts` 各有一条。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextCandidate, ModelConfig } from "../src/core/types";
import { PLAN_KEY } from "../src/core/types";
import { collectProseCandidates } from "../src/context/perception_candidates";
import {
  perceptionMetrics,
  perceptionObservation,
  perceptionPlanHash,
  perceptionProfileFor,
  perceptionTraceOf,
  renderPerceptionBlock,
  triageCandidates,
} from "../src/context/perception";
import { createProject, writeDoc } from "../src/storage/project";
import { eventLogFor, resetEventLogs } from "../src/telemetry/log";
import { buildRequestDetail } from "../src/telemetry/request_detail";
import { openSession } from "../src/session/session";

let home: string;
let prevHome: string | undefined;
let projectId: string;
let serial = 0;

const MODEL: ModelConfig = { provider: "mock", model: "mock", maxTokens: 1000, reasoning: "off" };

function candidate(id: string, line: ContextCandidate["line"], text: string, extra: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id,
    line,
    text,
    chars: text.length,
    authority: "authoritative",
    freshness: "fresh",
    source: { kind: "doc", path: `${id}.md` },
    cost: "cheap",
    ...extra,
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-perception-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = home;
  projectId = (await createProject({ title: "感知测试" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe("分诊 · v1 prose Profile", () => {
  const candidates: ContextCandidate[] = [
    candidate("task.plan", "task", "规划内容", { alreadyInContext: true, source: { kind: "derived", rev: "p1" } }),
    candidate("task.instruction", "task", "写这一章", { alreadyInContext: true }),
    candidate("character.state.沈越", "character", "角色此刻", { source: { kind: "state", rev: "s1" } }),
    candidate("character.card.沈越", "character", "角色卡", { source: { kind: "doc", rev: "c1" } }),
    candidate("narrative.progress", "narrative", "最近进度"),
    candidate("voice.brief", "voice", "声音简报", { alreadyInContext: true }),
    candidate("author.decision.0", "author", "决定原话"),
    candidate("narrative.chapter.old", "narrative", "", { expandable: { tool: "read", path: "chapters/old.md" } }),
    candidate("character.knowledge", "character", "", { gap: "state/knowledge.md 未建立" }),
  ];

  test("P0/P1/P2/P3 各就各位；已在上下文/缺失/过期不进正文", () => {
    const plan = triageCandidates(candidates, "prose", 1000, 3);
    const byId = new Map(plan.decisions.map((d) => [d.candidate.id, d]));

    expect(byId.get("task.plan")).toMatchObject({ tier: "P0", placement: "system.tail", action: "drop", reason: "already-in-context" });
    expect(byId.get("character.state.沈越")).toMatchObject({ tier: "P0", placement: "system.tail", action: "include" });
    expect(byId.get("character.card.沈越")).toMatchObject({ tier: "P1", placement: "system.head", action: "include" });
    expect(byId.get("narrative.progress")).toMatchObject({ tier: "P1", placement: "system.head", action: "include" });
    expect(byId.get("voice.brief")).toMatchObject({ tier: "P1", action: "drop", reason: "already-in-context" });
    expect(byId.get("author.decision.0")).toMatchObject({ tier: "P2", placement: "system.middle", action: "include", reason: "p2-included" });
    expect(byId.get("narrative.chapter.old")).toMatchObject({ tier: "P3", placement: "tool.index", action: "defer" });
    expect(byId.get("character.knowledge")).toMatchObject({ action: "drop", reason: "missing: state/knowledge.md 未建立" });

    expect(plan.missing).toEqual(["state/knowledge.md 未建立"]);
    const metrics = perceptionMetrics(plan);
    expect(metrics.p0Coverage).toBe(1);
    expect(metrics.missing).toBe(1);
    expect(metrics.duplicate).toBe(3);
    expect(metrics.deferred).toBe(1);
  });

  test("stale 与超预算的 P1 都被降级；P0 不被预算拦", () => {
    const plan = triageCandidates(
      [
        candidate("task.plan", "task", "很长".repeat(20), { alreadyInContext: true }),
        candidate("character.state.沈越", "character", "很长".repeat(20)),
        candidate("character.card.沈越", "character", "很长".repeat(20)),
        candidate("narrative.progress", "narrative", "旧", { freshness: "stale" }),
      ],
      "prose",
      10,
    );
    const byId = new Map(plan.decisions.map((d) => [d.candidate.id, d]));
    expect(byId.get("character.state.沈越")?.action).toBe("include");
    expect(byId.get("character.card.沈越")?.action).toBe("defer");
    expect(byId.get("narrative.progress")?.action).toBe("drop");
    expect(perceptionMetrics(plan).stale).toBe(1);
  });

  test("trace 抹掉正文，只留坐标；hash 对来源 rev 敏感", () => {
    const plan = triageCandidates([candidate("character.state.沈越", "character", "秘密正文", { source: { kind: "state", rev: "r1" } })], "prose", 100);
    const trace = perceptionTraceOf(plan, 1);
    const json = JSON.stringify(trace);
    expect(json).not.toContain("秘密正文");
    expect(json).toContain("\"rev\":\"r1\"");
    expect(trace.decisions[0]).toMatchObject({ id: "character.state.沈越", sourceChars: 4, chars: 4 });

    const changed = triageCandidates([candidate("character.state.沈越", "character", "秘密正文", { source: { kind: "state", rev: "r2" } })], "prose", 100);
    expect(perceptionPlanHash(changed)).not.toBe(perceptionPlanHash(plan));
  });

  test("inject 只渲染 include，按 placement 分块，已在上下文的不会重复", () => {
    const plan = triageCandidates(
      [
        candidate("character.state.沈越", "character", "此刻正文", { source: { kind: "state", path: "state/characters/沈越.md", rev: "r1" } }),
        candidate("character.card.沈越", "character", "角色卡正文", { source: { kind: "doc", path: "design/characters/沈越.md", rev: "c1" } }),
        candidate("task.plan", "task", "规划正文", { alreadyInContext: true }),
        candidate("author.decision.0", "author", "决定", { source: { kind: "session" } }),
      ],
      "prose",
      100,
    );
    const head = renderPerceptionBlock(plan, "system.head");
    const middle = renderPerceptionBlock(plan, "system.middle");
    const tail = renderPerceptionBlock(plan, "system.tail");
    expect(head).toContain("角色卡正文");
    expect(head).not.toContain("此刻正文");
    expect(middle).toContain("决定");
    expect(tail).toContain("此刻正文");
    expect(tail).toContain('source="state/characters/沈越.md@r1"');
    expect([head, middle, tail].join("\n")).not.toContain("规划正文");
  });
test("observation hash 只认感知状态；没有 Profile 的 purpose 不返回假 plan", () => {
    const base = {
      purpose: "chat" as const,
      mode: "shadow" as const,
      profile: "none",
      profiled: false,
      reason: "no-profile" as const,
    };
    const a = perceptionObservation(base, 1);
    const b = perceptionObservation(base, 2);
    expect(a.hash).toBe(b.hash);
    expect(perceptionObservation({ ...base, reason: "no-plan" }, 1).hash).not.toBe(a.hash);

    expect(perceptionProfileFor("chat")).toBeUndefined();
    expect(perceptionProfileFor("prose")?.id).toBe("prose.v1");
  });

  test("P2 放不下就 defer，不再截断成 compress", () => {
    const plan = triageCandidates(
      [
        candidate("character.state.沈越", "character", "状态", { source: { kind: "state", rev: "s1" } }),
        candidate("author.decision.0", "author", "很长".repeat(20)),
      ],
      "prose",
      20,
    );
    const byId = new Map(plan.decisions.map((d) => [d.candidate.id, d]));
    expect(byId.get("author.decision.0")?.action).toBe("defer");
    expect(byId.get("author.decision.0")?.reason).toBe("over-budget");
    expect(perceptionMetrics(plan).compressionRatio).toBe(1);
  });
});

describe("候选池 · prose", () => {
  test("从现有载体现取；缺读者/知识/关系/工艺时记 gap，而不是静默少一条", async () => {
    const pid = (await createProject({ title: "候选池" })).id;
    await writeDoc(pid, "design/brief.md", "# 核心\n\n## 一句话简介\n一个人。\n");
    await writeDoc(pid, "design/wiki/world.md", "# 世界\n\n## 空间与舞台\n旧书店。\n");
    await writeDoc(pid, "design/characters/沈越.md", "# 沈越\n\n## 基本档案\n姓名：沈越\n");
    await writeDoc(pid, "state/characters/沈越.md", "# 沈越此刻\n\n## 处境\n缺钱。\n");
    await writeDoc(pid, "state/progress.md", "# 进度\n\n## 第 1 章\n整理旧书。\n");
    await writeDoc(pid, "state/foreshadowing.md", "# 伏笔\n\n## 第一行字\n第 1 章埋下。\n");
    await writeDoc(pid, "chapters/chapter_ch1_v1.md", "# 第 1 章\n\n开场段。\n\n结尾只差一笔。\n");
    await writeDoc(pid, "chapters/chapter_ch2_v1.md", "# 第 2 章\n\n上一章的结尾。\n");
    await writeDoc(pid, "design/outline/vol_1.md", "# 第一卷\n\n## 本卷目标与阻力\n阻力。\n");

    const candidates = await collectProseCandidates({
      projectId: pid,
      chapter: 3,
      planText: "# 第 3 章规划\n\n沈越在旧书店整理旧书。",
      planInContext: true,
      instruction: "写第 3 章",
      decisions: [{ at: 1, proposal: PLAN_KEY, verdict: "accept" }],
    });
    const byId = new Map(candidates.map((c) => [c.id, c]));

    expect(byId.get("task.plan")?.alreadyInContext).toBe(true);
    expect(byId.get("task.instruction")?.alreadyInContext).toBe(true);
    expect(byId.get("character.card.沈越")?.alreadyInContext).toBeUndefined();
    expect(byId.get("character.state.沈越")?.chars).toBeGreaterThan(0);
    expect(byId.get("narrative.prev-ending")?.text).toContain("上一章的结尾");
    expect(byId.get("narrative.progress")?.text).toContain("整理旧书");
    expect(byId.get("narrative.promises")?.text).toContain("第一行字");
    expect(byId.get("author.decision.0")?.line).toBe("author");
    expect(byId.get("narrative.chapter.chapters/chapter_ch1_v1.md")?.expandable?.tool).toBe("read");
    expect(byId.get("narrative.outline.design/outline/vol_1.md")?.expandable?.tool).toBe("read");

    const gaps = candidates.filter((c) => c.gap !== undefined).map((c) => c.gap).join("\n");
    expect(gaps).toContain("state/knowledge.md");
    expect(gaps).toContain("state/relations.md");
    expect(gaps).toContain("state/reader.md");
    expect(gaps).toContain("state/craft.md");
  });
});

describe("shadow · 不改变 system", () => {
  test("同一份规划下，shadow 与 off 的 system prompt 逐字相同；inject 才追加感知块", async () => {
    const pid = (await createProject({ title: "shadow 不注入" })).id;
    await writeDoc(pid, "design/brief.md", "# 核心\n\n## 一句话简介\n一个人。\n");
    await writeDoc(pid, "design/characters/沈越.md", "# 沈越\n\n## 基本档案\n姓名：沈越\n");

    const run = async (mode: "shadow" | "off" | "inject"): Promise<{ system: string; plans: number; observed: number; hash?: string }> => {
      const prev = process.env.TALEMATE_PERCEPTION;
      process.env.TALEMATE_PERCEPTION = mode;
      try {
        const session = await openSession({ projectId: pid, model: MODEL, title: `shadow-${mode}-${++serial}` });
        session.pending.set(PLAN_KEY, {
          name: PLAN_KEY,
          content: "# 第 1 章规划\n\n沈越在旧书店整理旧书。",
          chapter: 1,
          approved: true,
          at: Date.now(),
        });
        await session.post("写第 1 章", { keepApprovedPlan: true });
        const events = await eventLogFor(pid, session.sessionId).read();
        const system = events.find((e) => e.type === "system/prompt");
        const header = events.find((e) => e.type === "request/header");
        const plan = events.find((e) => e.type === "perception/plan");
        return {
          system: system?.type === "system/prompt" ? system.data.text : "",
          plans: events.filter((e) => e.type === "perception/plan").length,
          observed: events.filter((e) => e.type === "perception/observed").length,
          ...(header?.type === "request/header" && header.data.perceptionHash !== undefined
            ? { hash: header.data.perceptionHash }
            : {}),
        };
      } finally {
        if (prev === undefined) delete process.env.TALEMATE_PERCEPTION;
        else process.env.TALEMATE_PERCEPTION = prev;
        resetEventLogs();
      }
    };

    const shadow = await run("shadow");
    const off = await run("off");
    const inject = await run("inject");
    expect(shadow.system).not.toBe("");
    expect(shadow.system).toContain("<assets>");
    expect(shadow.system).toContain("概览 (design/brief.md)");
    expect(shadow.system).toBe(off.system);
    expect(inject.system).not.toBe(off.system);
    expect(inject.system).toContain("<perception purpose=\"prose\" placement=\"system.head\">");
    expect(inject.system).toContain("沈越");
    expect(shadow.plans).toBeGreaterThan(0);
    expect(shadow.observed).toBeGreaterThan(0);
    expect(shadow.hash).toBeDefined();
    expect(off.plans).toBe(0);
    expect(off.observed).toBeGreaterThan(0);
    expect(off.hash).toBeDefined();
  });
});
describe("observed · 无 Profile", () => {
  test("chat 请求也留 observed；header 的 perceptionHash 能指回来", async () => {
    const pid = (await createProject({ title: "observed-chat" })).id;
    const session = await openSession({ projectId: pid, model: MODEL, title: `chat-${++serial}` });
    try {
      await session.post("你好");
      const events = await eventLogFor(pid, session.sessionId).read();
      const observed = events.find((e) => e.type === "perception/observed");
      expect(observed?.type).toBe("perception/observed");
      if (observed?.type !== "perception/observed") return;
      expect(observed.data).toMatchObject({ purpose: "chat", profiled: false, reason: "no-profile" });
      expect(events.some((e) => e.type === "perception/plan")).toBe(false);

      const header = events.find((e) => e.type === "request/header");
      expect(header?.type).toBe("request/header");
      if (header?.type !== "request/header") return;
      expect(observed.seq).toBeLessThan(header.seq);
      expect(header.data.perceptionHash).toBe(observed.data.hash);

      const detail = buildRequestDetail(events, header.seq);
      expect(detail?.perceptionObservation?.purpose).toBe("chat");
      expect(detail?.perceptionObservation?.reason).toBe("no-profile");
      expect(detail?.perception).toBeUndefined();
    } finally {
      resetEventLogs();
    }
  });
});
