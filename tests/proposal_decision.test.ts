/**
 * 结构化拍板：接受 / 拒绝不再经过一句用户消息。这里只测同步的状态变更（不跑模型）：
 * 接受保留提案并置 approved，拒绝删除，两者都退出草稿；没有待拍板时明确报错。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../src/storage/project";
import { createSession } from "../src/storage/session-store";
import { PLAN_KEY } from "../src/core/types";
import { readDoc } from "../src/storage/corpus";
import { openSession, type Session } from "../src/session/session";

let home: string;
let prevHome: string | undefined;
let projectId: string;
const SESSION = "proposal-session";
let session: Session;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-proposal-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = home;
  projectId = (await createProject({ title: "拍板测试" })).id;
  await createSession(projectId, { id: SESSION, projectId, title: "拍板", agent: "mate" });
  session = await openSession({ projectId, sessionId: SESSION });
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

function propose(path = "design/core.md"): void {
  session.pending.clear();
  session.setMode("accept-edits");
  session.pending.set(path, { name: path, content: "# 新版本\n", approved: false, at: Date.now() });
  session.setMode("draft");
}

describe("结构化拍板", () => {
  test("接受：approved=true，留在 pending 等 apply-design，退出草稿并恢复 accept-edits", () => {
    propose();
    session.decideProposal("accept");
    expect(session.pending.get("design/core.md")?.approved).toBe(true);
    expect(session.currentMode?.id).toBe("accept-edits");
  });

  test("接受文档提案：harness 直接落盘，不依赖模型", async () => {
    session.pending.clear();
    const path = "design/wiki/accept-test.md";
    const content = "# 世界\n\n## 空间与舞台\n一座岛。\n\n## 规则与秩序\n离开就死。\n";
    session.setMode("accept-edits");
    session.pending.set(path, { name: path, content, approved: false, at: Date.now() });
    session.setMode("draft");

    const result = await session.acceptProposal();
    expect(result.kind).toBe("design");
    expect((await readDoc(projectId, path))?.trimEnd()).toBe(content.trimEnd());
    expect(session.pending.has(path)).toBe(false);
    expect(session.currentMode?.id).toBe("accept-edits");
  });

  test("接受规划提案：返回章节号、保留 approved，交给执行回合", async () => {
    session.pending.clear();
    session.setMode("accept-edits");
    session.pending.set(PLAN_KEY, {
      name: PLAN_KEY,
      content: "# 第 1 章规划\n",
      chapter: 1,
      approved: false,
      at: Date.now(),
    });
    session.setMode("draft");

    const result = await session.acceptProposal();
    expect(result).toEqual({ kind: "plan", chapter: 1 });
    expect(session.pending.get(PLAN_KEY)?.approved).toBe(true);
    expect(session.planExecutionChapter).toBe(1);
    expect(session.currentMode?.id).toBe("accept-edits");
  });

  test("prose mode 不把权限开关打回 ask，而是沿用进入前那层", () => {
    session.setMode("accept-edits");
    session.setMode("prose");
    expect(session.permissionMode).toBe("accept-edits");
    session.setMode("accept-edits");
    session.setMode("prose");
    session.setMode(undefined);
    expect(session.permissionMode).toBe("ask");
  });

  test("prose mode 切换 role system；exit 后恢复 mate", async () => {
    const s = session as unknown as { buildSystem(agent: unknown): Promise<string> };
    session.setMode("prose");
    const prose = await s.buildSystem(session.agent);
    expect(prose).toContain("You are writing this novel's prose");
    expect(prose).not.toContain("You are talemate's writing partner.");
    session.setMode("accept-edits");
    const mate = await s.buildSystem(session.agent);
    expect(mate).toContain("You are talemate's writing partner.");
  });

  test("规划者返回后，除 propose-plan/ask-user 外的工具被拦住", () => {
    const s = session as unknown as {
      plannerAwaitingProposal: boolean;
      notePlannerResult(call: { id: string; name: string; input?: unknown }, part: unknown): void;
      planGatePart(call: { id: string; name: string; input?: unknown }): { state?: string; error?: string } | undefined;
    };
    s.plannerAwaitingProposal = false;
    s.notePlannerResult(
      { id: "t", name: "task", input: { agent: "planner" } },
      { type: "tool", id: "t", name: "task", state: "completed", output: '<task agent="planner" state="completed">x</task>' },
    );
    expect(s.plannerAwaitingProposal).toBe(true);

    const blocked = s.planGatePart({ id: "e", name: "edit", input: {} });
    expect(blocked?.state).toBe("error");
    expect(blocked?.error).toContain("propose-plan");
    expect(s.planGatePart({ id: "p", name: "propose-plan", input: {} })).toBeUndefined();
    expect(s.planGatePart({ id: "a", name: "ask-user", input: {} })).toBeUndefined();

    s.notePlannerResult(
      { id: "p", name: "propose-plan" },
      { type: "tool", id: "p", name: "propose-plan", state: "completed", output: "ok" },
    );
    expect(s.plannerAwaitingProposal).toBe(false);
  });

  test("拒绝：删除提案，退出草稿并恢复 accept-edits", () => {
    propose();
    session.decideProposal("reject");
    expect(session.pending.has("design/core.md")).toBe(false);
    expect(session.currentMode?.id).toBe("accept-edits");
  });

  test("没有待拍板时明确报错，不静默成功", () => {
    session.pending.clear();
    expect(() => session.decideProposal("accept")).toThrow("没有待拍板");
  });

  test("提意见为空直接拒绝调用，不跑模型", async () => {
    propose();
    await expect(session.refineProposal("   ")).rejects.toThrow("不能为空");
    expect(session.pending.get("design/core.md")?.approved).toBe(false);
  });
});
