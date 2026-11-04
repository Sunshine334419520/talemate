/**
 * 跨会话索引的守卫：它会读很多日志，所以只做读侧投影——不删文件、不读 messages、不触发模型。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "../src/core/types";
import { createProject } from "../src/storage/project";
import { createSession } from "../src/storage/session-store";
import { eventLogFor, resetEventLogs } from "../src/telemetry/log";
import { archiveTraces, buildTraceIndex } from "../src/session/trace_index";

let home: string;
let prevHome: string | undefined;
let p1: string;
let p2: string;

const MODEL: ModelConfig = { provider: "mock", model: "mock", maxTokens: 1000, reasoning: "off" };

async function session(projectId: string, id: string, title: string, depth = 0) {
  await createSession(projectId, {
    id,
    projectId,
    title,
    agent: "mate",
    model: MODEL,
    ...(depth === 0 ? {} : { depth, parentSessionId: "parent" }),
  });
  return eventLogFor(projectId, id);
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-trace-index-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = home;
  resetEventLogs();
  p1 = (await createProject({ title: "甲书" })).id;
  p2 = (await createProject({ title: "乙书" })).id;

  const ok = await session(p1, "ok", "顺利的一轮");
  await ok.append("session/start", { agent: "mate", model: "mock", provider: "mock", title: "顺利的一轮" }, 1000);
  await ok.append("turn/start", { agent: "mate", resumed: false }, 1010);
  await ok.append("step/start", { step: 0 }, 1020);
  await ok.append("step/end", { step: 0, finish: "stop", durationMs: 5, usage: { input: 100, output: 20 } }, 1030);
  await ok.append("turn/end", { status: "completed", durationMs: 20 }, 1040);

  const bad = await session(p1, "bad", "失败的一轮");
  await bad.append("session/start", { agent: "mate", model: "mock", provider: "mock", title: "失败的一轮" }, 2000);
  await bad.append("turn/start", { agent: "mate", resumed: false }, 2010);
  await bad.append("step/start", { step: 0 }, 2020);
  await bad.append(
    "assistant/attempt",
    { step: 0, outcome: "error", durationMs: 7, streamedChars: 0, error: { name: "X", message: "模型失败" } },
    2030,
  );
  await bad.append(
    "tool/result",
    { callId: "c1", name: "read", state: "error", outputChars: 0, durationMs: 1, error: "读失败" },
    2040,
  );
  await bad.append("turn/end", { status: "error", durationMs: 8, error: { name: "X", message: "模型失败" } }, 2050);

  const sub = await session(p1, "sub", "task:planner", 1);
  await sub.append("session/start", { agent: "planner", model: "mock", provider: "mock", title: "task:planner" }, 3000);

  const other = await session(p2, "other", "乙书会话");
  await other.append("session/start", { agent: "mate", model: "mock", provider: "mock", title: "乙书会话" }, 4000);
  await other.append("turn/start", { agent: "mate", resumed: false }, 4010);
  await other.append("turn/end", { status: "completed", durationMs: 1 }, 4020);
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe("跨会话索引", () => {
  test("默认排除子会话，按 lastAt 倒序，统计与 token 正确", async () => {
    const index = await buildTraceIndex();
    expect(index.total).toBe(3);
    expect(index.entries.map((e) => e.sessionId)).toEqual(["other", "bad", "ok"]);
    const ok = index.entries.find((e) => e.sessionId === "ok")!;
    expect(ok).toMatchObject({ turns: 1, steps: 1, inputTokens: 100, outputTokens: 20, status: "completed" });
    expect(ok.projectTitle).toBe("甲书");
    expect(ok.eventsPath).toContain("ok");
    expect(index.retention.oldestAt).toBe(1000);
    expect(index.retention.newestAt).toBe(4020);
  });

  test("按项目 / 查询 / 时间 / limit 过滤，失败桶只来自被包含的会话", async () => {
    const onlyP1 = await buildTraceIndex({ projectId: p1 });
    expect(onlyP1.entries.map((e) => e.sessionId)).toEqual(["bad", "ok"]);

    const failed = await buildTraceIndex({ query: "失败" });
    expect(failed.entries.map((e) => e.sessionId)).toEqual(["bad"]);
    expect(failed.failures.map((f) => f.kind).sort()).toEqual(["request", "tool", "turn"]);
    expect(failed.failures.find((f) => f.kind === "request")?.message).toBe("模型失败");

    const recent = await buildTraceIndex({ since: 2000 });
    expect(recent.entries.map((e) => e.sessionId)).toEqual(["other", "bad"]);

    const first = await buildTraceIndex({ limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.total).toBe(3);
  });

  test("includeSubagents 才把 task 子会话放进列表", async () => {
    const all = await buildTraceIndex({ includeSubagents: true });
    expect(all.entries.map((e) => e.sessionId)).toContain("sub");
    expect(all.total).toBe(4);
  });

  test("索引缓存命中，事件追加后只重扫变化的那一个", async () => {
    const first = await buildTraceIndex();
    expect((first.cache?.hit ?? 0) + (first.cache?.miss ?? 0)).toBe(4);
    const cached = await readFile(join(home, "trace-index.json"), "utf-8");
    expect(cached).toContain('"sessions"');

    const second = await buildTraceIndex();
    expect(second.cache).toEqual({ hit: 4, miss: 0 });

    await eventLogFor(p1, "ok").append("turn/start", { agent: "mate", resumed: false }, 5000);
    await eventLogFor(p1, "ok").append("turn/end", { status: "completed", durationMs: 1 }, 5010);
    const third = await buildTraceIndex();
    expect(third.cache).toEqual({ hit: 3, miss: 1 });
    expect(third.entries.find((e) => e.sessionId === "ok")?.lastAt).toBe(5010);
  });

  test("归档只移动超过阈值的整份会话目录，不删事件", async () => {
    const now = 30 * 86_400_000 + 3000;
    const dry = await archiveTraces({ olderThanDays: 30, now, dryRun: true });
    expect(dry.archived.map((a) => a.sessionId).sort()).toEqual(["bad"]);
    expect(dry.skipped).toEqual([]);

    const excluded = await archiveTraces({
      olderThanDays: 30,
      now,
      dryRun: true,
      excludeSessionIds: ["bad"],
    });
    expect(excluded.archived).toEqual([]);

    const real = await archiveTraces({ olderThanDays: 30, now });
    expect(real.archived.map((a) => a.sessionId).sort()).toEqual(["bad"]);
    const archiveDir = join(home, "archive", p1);
    expect((await stat(archiveDir)).isDirectory()).toBe(true);
    const after = await buildTraceIndex();
    expect(after.entries.map((e) => e.sessionId)).not.toContain("bad");
    const oldDirMissing = await stat(join(home, "novels", p1, ".talemate", "sessions", "bad"))
      .then(() => false, () => true);
    expect(oldDirMissing).toBe(true);
  });
});
