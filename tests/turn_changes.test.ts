/**
 * 按轮收集落盘记录。这里的边界错了，摘要卡就会把上一轮的改动算到这一轮，或者漏掉最后一轮。
 */
import { describe, expect, test } from "bun:test";
import type { StoredMessage, WriteChange } from "../src/core/types";
import { changesOfParts, messageTurns } from "../src/session/turn_changes";

const change = (path: string, kind: WriteChange["kind"]): WriteChange => ({
  path,
  kind,
  diff: kind === "created" ? "" : "- old\n+ new",
  additions: 1,
  deletions: 1,
});

const user = (seq: number, text: string): StoredMessage => ({ seq, role: "user", ts: seq, text });
const assistant = (seq: number, changes: WriteChange[]): StoredMessage => ({
  seq,
  role: "assistant",
  ts: seq,
  parts: changes.map((c, i) => ({ type: "tool", id: `t${seq}-${i}`, name: "edit", state: "completed", change: c })),
});

describe("按轮收集改动", () => {
  test("只取 tool part 上的记录", () => {
    const parts = [
      { type: "text" as const, text: "写完了" },
      { type: "tool" as const, id: "a", name: "read", state: "completed" as const },
      { type: "tool" as const, id: "b", name: "edit", state: "completed" as const, change: change("chapters/ch1.md", "modified") },
    ];
    expect(changesOfParts(parts)).toHaveLength(1);
    expect(changesOfParts(parts)[0]?.path).toBe("chapters/ch1.md");
  });

  test("用户消息开新轮，助手改动归当前轮", () => {
    const messages = [
      user(1, "改第一章"),
      assistant(2, [change("chapters/ch1.md", "modified")]),
      assistant(3, [change("characters/陈六.md", "created")]),
      user(4, "再改第二章"),
      assistant(5, [change("chapters/ch2.md", "modified")]),
    ];
    const turns = messageTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(turns[0]?.changes.map((c) => c.path)).toEqual(["chapters/ch1.md", "characters/陈六.md"]);
    expect(turns[1]?.messages.map((m) => m.seq)).toEqual([4, 5]);
    expect(turns[1]?.changes).toHaveLength(1);
  });

  test("开头没有用户消息时也有一轮落点", () => {
    const turns = messageTurns([assistant(1, [change("design/core.md", "modified")])]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.changes).toHaveLength(1);
  });

  test("没有落盘记录的一轮保留消息、改动为空", () => {
    const turns = messageTurns([user(1, "聊聊"), assistant(2, [])]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.changes).toEqual([]);
  });
});
