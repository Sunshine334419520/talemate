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
  session.pending.set(path, { name: path, content: "# 新版本\n", approved: false, at: Date.now() });
  session.setMode("draft");
}

describe("结构化拍板", () => {
  test("接受：approved=true，留在 pending 等 apply-design，退出草稿", () => {
    propose();
    session.decideProposal("accept");
    expect(session.pending.get("design/core.md")?.approved).toBe(true);
    expect(session.currentMode).toBeUndefined();
  });

  test("接受文档提案：harness 直接落盘，不依赖模型", async () => {
    session.pending.clear();
    const path = "design/wiki/accept-test.md";
    const content = "# 世界\n\n## 空间与舞台\n一座岛。\n\n## 规则与秩序\n离开就死。\n";
    session.pending.set(path, { name: path, content, approved: false, at: Date.now() });
    session.setMode("draft");

    const result = await session.acceptProposal();
    expect(result.kind).toBe("design");
    expect((await readDoc(projectId, path))?.trimEnd()).toBe(content.trimEnd());
    expect(session.pending.has(path)).toBe(false);
    expect(session.currentMode).toBeUndefined();
  });

  test("拒绝：删除提案，退出草稿", () => {
    propose();
    session.decideProposal("reject");
    expect(session.pending.has("design/core.md")).toBe(false);
    expect(session.currentMode).toBeUndefined();
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
