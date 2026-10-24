/**
 * 轨迹模型的守卫：对话视图折叠过程，轨迹不折。这里钉住"每类 part 都摊开、耗时算对、
 * 过滤只影响看不看"——轨迹是排查用的，少一类行就等于少一条线索。
 */
import { describe, test, expect } from "bun:test";
import type { StoredMessage } from "../src/core/types";
import { filterTraceRows, traceRows } from "../desktop/src/shared/trace";

const history: StoredMessage[] = [
  { seq: 1, role: "user", agent: "mate", ts: 1000, text: "帮我查一下" },
  {
    seq: 2,
    role: "assistant",
    agent: "mate",
    ts: 2000,
    model: "deepseek-flash",
    finish: "tool_calls",
    parts: [
      { type: "reasoning", text: "先派考据" },
      { type: "text", text: "我查一下。" },
      {
        type: "tool",
        id: "c1",
        name: "task",
        state: "completed",
        input: '{"agent":"researcher","prompt":"查栾氏"}',
        output: '<task agent="researcher" state="completed" session="sub-1">ok</task>',
        time: { ran: 100, completed: 250 },
      },
      { type: "tool", id: "c2", name: "webfetch", state: "error", error: "HTTP 403", time: { ran: 300, completed: 400 } },
    ],
  },
  { seq: 3, role: "compaction", ts: 3000, summary: "前情", recent: "最近" },
];

describe("轨迹 · 摊平", () => {
  test("用户 / 思考 / 正文 / 工具 / 压缩都各占一行，顺序不变", () => {
    expect(traceRows(history).map((r) => r.kind)).toEqual([
      "user",
      "reasoning",
      "text",
      "tool",
      "tool",
      "compaction",
    ]);
  });

  test("工具行保留状态、耗时、错误，以及子会话 id 能从输出里认出来", () => {
    const tools = traceRows(history).filter((r) => r.kind === "tool");
    expect(tools[0]).toMatchObject({ toolName: "task", state: "completed", ms: 150 });
    expect(tools[0].output).toContain('session="sub-1"');
    expect(tools[1]).toMatchObject({ toolName: "webfetch", state: "error", error: "HTTP 403" });
  });

  test("过滤只影响看不看，不影响行本身", () => {
    const rows = traceRows(history);
    expect(filterTraceRows(rows, "tools").map((r) => r.toolName)).toEqual(["task", "webfetch"]);
    expect(filterTraceRows(rows, "thinking").map((r) => r.kind)).toEqual(["reasoning", "compaction"]);
    expect(filterTraceRows(rows, "errors").map((r) => r.toolName)).toEqual(["webfetch"]);
    expect(filterTraceRows(rows, "all")).toHaveLength(rows.length);
  });
});
