/**
 * 改动索引：每会话一份 changes.jsonl，只追加，回退用墓碑。
 *
 * 这里钉三件事：写入/读取；墓碑的重放语义（只遮住它之前的分支，之后追加的行照收）；
 * 从消息重建索引与按指针取 diff——索引是投影，删了能重算。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangePoint, WriteChange } from "../src/core/types";
import { createProject } from "../src/storage/project";
import { appendMessage, createSession } from "../src/storage/session-store";
import {
  appendChanges,
  appendChangeRewind,
  readChanges,
  writeChanges,
} from "../src/storage/change_index";
import { rebuildSessionChanges, readChangeDiff, userLine } from "../src/session/change_history";
import { listTurnChanges } from "../desktop/src/main/changes";
import { openSession } from "../src/session/session";
import { truncateMessagesBefore } from "../src/storage/session-store";
import { resetEventLogs } from "../src/telemetry/log";

let home: string;
let prevHome: string | undefined;
let projectId: string;
let serial = 0;

function nextSessionId(): string {
  serial++;
  return `changes-${serial}`;
}

function point(turnSeq: number, path: string): ChangePoint {
  return {
    turnSeq,
    messageSeq: turnSeq + 1,
    callId: `call-${turnSeq}-${path}`,
    path,
    kind: "modified",
    additions: 1,
    deletions: 0,
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-changes-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = home;
  projectId = (await createProject({ title: "改动索引测试" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  resetEventLogs();
});

describe("改动索引 · 追加与墓碑", () => {
  test("一行一条改动，按写入顺序读回", async () => {
    const sessionId = nextSessionId();
    await appendChanges(projectId, sessionId, [point(1, "design/core.md")], {
      ts: 100,
      user: "写第一章",
    });
    await appendChanges(projectId, sessionId, [point(3, "chapters/chapter_ch1_v1.md")], {
      ts: 300,
      user: "写第一章",
    });

    const rows = await readChanges(projectId, sessionId);
    expect(rows.map((r) => [r.turnSeq, r.path, r.user])).toEqual([
      [1, "design/core.md", "写第一章"],
      [3, "chapters/chapter_ch1_v1.md", "写第一章"],
    ]);
  });

  test("回退墓碑只遮住它之前的行；之后追加的新分支照收", async () => {
    const sessionId = nextSessionId();
    await appendChanges(projectId, sessionId, [point(3, "chapters/a.md")], { ts: 3, user: "三" });
    await appendChangeRewind(projectId, sessionId, 3);
    // 回退后 seq 被复用：新的 turnSeq 3 是另一条分支
    await appendChanges(projectId, sessionId, [point(3, "chapters/b.md")], { ts: 4, user: "新三" });

    const rows = await readChanges(projectId, sessionId);
    expect(rows.map((r) => r.path)).toEqual(["chapters/b.md"]);
  });
});

describe("改动索引 · 从消息重建", () => {
  test("重建出轮次/指针/用户原话；按指针取回 diff", async () => {
    const sessionId = nextSessionId();
    const user = await appendMessage(projectId, sessionId, {
      role: "user",
      agent: "mate",
      text: "写第一章\n顺便把设定也补上",
    });
    const change: WriteChange = {
      path: "chapters/chapter_ch1_v1.md",
      kind: "created",
      diff: "",
      additions: 120,
      deletions: 0,
    };
    const assistant = await appendMessage(projectId, sessionId, {
      role: "assistant",
      agent: "mate",
      finish: "tool_calls",
      parts: [
        {
          type: "tool",
          id: "call-write-1",
          name: "write",
          state: "completed",
          input: '{"path":"chapters/chapter_ch1_v1.md"}',
          output: "已写入",
          change,
        },
      ],
    });

    expect(await rebuildSessionChanges(projectId, sessionId)).toBe(1);
    const rows = await readChanges(projectId, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turnSeq: user.seq,
      messageSeq: assistant.seq,
      callId: "call-write-1",
      path: "chapters/chapter_ch1_v1.md",
      kind: "created",
      additions: 120,
      user: userLine("写第一章\n顺便把设定也补上"),
    });

    // diff 不在索引里：按 messageSeq + callId 回消息里取
    expect(await readChangeDiff(projectId, sessionId, assistant.seq, "call-write-1")).toBe("");
    expect(await readChangeDiff(projectId, sessionId, assistant.seq, "missing")).toBeUndefined();
  });

  test("回退同时裁掉索引：truncateMessagesBefore 追加墓碑", async () => {
    const sessionId = nextSessionId();
    await appendChanges(projectId, sessionId, [point(3, "chapters/a.md")], { ts: 3, user: "三" });
    expect(await readChanges(projectId, sessionId)).toHaveLength(1);

    await truncateMessagesBefore(projectId, sessionId, 3);
    expect(await readChanges(projectId, sessionId)).toEqual([]);
  });

  test("writeChanges 覆盖写会清掉墓碑（重建后的文件是一份干净快照）", async () => {
    const sessionId = nextSessionId();
    await appendChanges(projectId, sessionId, [point(2, "design/core.md")], { ts: 2, user: "二" });
    await appendChangeRewind(projectId, sessionId, 2);
    expect(await readChanges(projectId, sessionId)).toEqual([]);

    await writeChanges(projectId, sessionId, [
      {
        type: "change",
        ...point(5, "state/progress.md"),
        ts: 5,
        user: "五",
      },
    ]);
    expect((await readChanges(projectId, sessionId)).map((r) => r.path)).toEqual(["state/progress.md"]);
  });
});

describe("索引自愈", () => {
  test("打开会话时索引落后于事件 → 自动重写", async () => {
    const sessionId = nextSessionId();
    await createSession(projectId, { id: sessionId, projectId, title: "自愈", agent: "mate" });
    await appendMessage(projectId, sessionId, { role: "user", agent: "mate", text: "写一章" });
    await appendMessage(projectId, sessionId, {
      role: "assistant",
      agent: "mate",
      finish: "tool_calls",
      parts: [
        {
          type: "tool",
          id: "call-heal",
          name: "write",
          state: "completed",
          input: "{}",
          output: "ok",
          change: { path: "chapters/chapter_ch1_v1.md", kind: "created", diff: "", additions: 10, deletions: 0 },
        },
      ],
    });
    // 绕过了 Session 的提交路径：索引还没写
    expect(await readChanges(projectId, sessionId)).toEqual([]);

    await openSession({ projectId, sessionId });
    const rows = await readChanges(projectId, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "chapters/chapter_ch1_v1.md", user: "写一章" });
  });
});

describe("本书视图 · 只读索引", () => {
  test("按轮分组；本次会话只返回自己，本书合并所有会话", async () => {
    const sessionA = nextSessionId();
    const sessionB = nextSessionId();
    for (const [id, title, text] of [
      [sessionA, "会话 A", "写第一章"],
      [sessionB, "会话 B", "改设定"],
    ] as const) {
      await createSession(projectId, { id, projectId, title, agent: "mate" });
      await appendMessage(projectId, id, { role: "user", agent: "mate", text });
      await appendMessage(projectId, id, {
        role: "assistant",
        agent: "mate",
        finish: "tool_calls",
        parts: [
          {
            type: "tool",
            id: `call-${id}`,
            name: "write",
            state: "completed",
            input: "{}",
            output: "ok",
            change: { path: "design/core.md", kind: "modified", diff: "@@", additions: 1, deletions: 1 },
          },
        ],
      });
      await rebuildSessionChanges(projectId, id);
      void title;
    }

    const one = await listTurnChanges(projectId, sessionA);
    expect(one.map((g) => g.sessionId)).toEqual([sessionA]);
    expect(one[0]?.user).toBe("写第一章");
    expect(one[0]?.changes[0]).toMatchObject({ path: "design/core.md", kind: "modified" });

    const book = await listTurnChanges(projectId);
    const mine = book.filter((g) => g.sessionId === sessionA || g.sessionId === sessionB);
    expect(mine.map((g) => g.sessionId).sort()).toEqual([sessionA, sessionB].sort());
  });
});
