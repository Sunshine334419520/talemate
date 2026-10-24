/**
 * 就地回退的存储与 Session 语义：目标用户消息及其之后被移除、原文回传、原日志先备份。
 *
 * 回退是**重写** messages.jsonl（不是 append-only），所以备份必须真的落在
 * `rewind-backups/` 里；这条测试同时钉住"只能回退到用户消息"。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject } from "../src/storage/project";
import {
  appendMessage,
  backupMessages,
  createSession,
  loadMessages,
  truncateMessagesBefore,
} from "../src/storage/session-store";
import { openSession } from "../src/session/session";
import { projectPaths, sessionPaths } from "../src/core/config";
import { dropFileCheckpointsFrom, loadFileCheckpoints, recordFileCheckpoint } from "../src/storage/file-history";
import { previewFileRewind, restoreFilesForRewind } from "../src/session/rewind_files";

let home: string;
let prevHome: string | undefined;
let projectId: string;
const SESSION = "rewind-session";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-rewind-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = home;
  projectId = (await createProject({ title: "回退测试" })).id;
  await createSession(projectId, {
    id: SESSION,
    projectId,
    title: "回退测试会话",
    agent: "mate",
  });
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  // 清掉上一次留下的消息（测试之间复用同一个会话目录）
  await truncateMessagesBefore(projectId, SESSION, 1);
  await appendMessage(projectId, SESSION, { role: "user", agent: "mate", text: "第一问" });
  await appendMessage(projectId, SESSION, { role: "assistant", agent: "mate", parts: [{ type: "text", text: "第一答" }] });
  await appendMessage(projectId, SESSION, { role: "user", agent: "mate", text: "第二问" });
  await appendMessage(projectId, SESSION, { role: "assistant", agent: "mate", parts: [{ type: "text", text: "第二答" }] });
}

describe("会话回退", () => {
  test("备份留在 rewind-backups/，截断只保留目标之前", async () => {
    await seed();
    const backup = await backupMessages(projectId, SESSION);
    expect(backup).toBeDefined();
    const raw = await readFile(backup as string, "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(4);

    const kept = await truncateMessagesBefore(projectId, SESSION, 3);
    expect(kept).toBe(2);
    expect((await loadMessages(projectId, SESSION)).map((m) => m.seq)).toEqual([1, 2]);

    const dir = join(sessionPaths(home, projectId, SESSION).dir, "rewind-backups");
    expect((await readdir(dir)).length).toBeGreaterThan(0);
  });

  test("Session.rewindTo：回传目标原文，只能指向用户消息", async () => {
    await seed();
    const session = await openSession({ projectId, sessionId: SESSION });

    const result = await session.rewindTo(3);
    expect(result.text).toBe("第二问");
    expect(result.backup).toBeDefined();
    expect((await loadMessages(projectId, SESSION)).map((m) => m.seq)).toEqual([1, 2]);

    // 目标及其之后已经不在文件里
    await expect(session.rewindTo(4)).rejects.toThrow("没有 seq=4");
    // 助手消息不是回退目标——撤到助手回复中间没有可编辑的原话
    await expect(session.rewindTo(2)).rejects.toThrow("用户消息");
  });
});

async function coreFile(content: string | null): Promise<string> {
  const abs = join(projectPaths(home, projectId).root, "design/core.md");
  if (content === null) {
    await rm(abs, { force: true });
    return abs;
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
  return abs;
}

describe("回退 · 文件还原", () => {
  test("检查点按路径取最早一条，还原写回旧内容", async () => {
    await dropFileCheckpointsFrom(projectId, SESSION, 1);
    const abs = await coreFile("new\n");
    await recordFileCheckpoint(projectId, SESSION, { seq: 2, path: "design/core.md", before: "old\n" });
    // 同一轮再写一次：仍只该保留最早的 before
    await recordFileCheckpoint(projectId, SESSION, { seq: 2, path: "design/core.md", before: "newer\n" });

    const preview = await previewFileRewind(projectId, SESSION, 2);
    expect(preview.items).toEqual([{ path: "design/core.md", action: "restore" }]);

    const outcome = await restoreFilesForRewind(projectId, SESSION, 2);
    expect(outcome.restored).toEqual(["design/core.md"]);
    expect(await readFile(abs, "utf-8")).toBe("old\n");
    await dropFileCheckpointsFrom(projectId, SESSION, 2);
  });

  test("写前不存在的文件，回退时删除", async () => {
    await dropFileCheckpointsFrom(projectId, SESSION, 1);
    await recordFileCheckpoint(projectId, SESSION, { seq: 2, path: "design/new.md", before: null });
    const abs = join(projectPaths(home, projectId).root, "design/new.md");
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "created\n", "utf-8");

    const outcome = await restoreFilesForRewind(projectId, SESSION, 2);
    expect(outcome.deleted).toEqual(["design/new.md"]);
    await expect(readFile(abs, "utf-8")).rejects.toThrow();
    await dropFileCheckpointsFrom(projectId, SESSION, 2);
  });

  test("Session 的两种模式：both 还原文件，chat 保留文件，检查点都清掉", async () => {
    await seed();
    await coreFile("old\n");
    await recordFileCheckpoint(projectId, SESSION, { seq: 3, path: "design/core.md", before: "old\n" });
    await coreFile("new\n");
    const session = await openSession({ projectId, sessionId: SESSION });

    const both = await session.rewindTo(3, { restoreFiles: true });
    expect(both.files?.restored).toEqual(["design/core.md"]);
    expect(await readFile(join(projectPaths(home, projectId).root, "design/core.md"), "utf-8")).toBe("old\n");
    expect(await loadFileCheckpoints(projectId, SESSION)).toEqual([]);

    // 再来一次，选仅回退对话：文件保持新内容
    await seed();
    await coreFile("old\n");
    await recordFileCheckpoint(projectId, SESSION, { seq: 3, path: "design/core.md", before: "old\n" });
    await coreFile("new\n");
    const again = await openSession({ projectId, sessionId: SESSION });
    const chat = await again.rewindTo(3, { restoreFiles: false });
    expect(chat.files).toBeUndefined();
    expect(await readFile(join(projectPaths(home, projectId).root, "design/core.md"), "utf-8")).toBe("new\n");
    expect(await loadFileCheckpoints(projectId, SESSION)).toEqual([]);
  });
});
