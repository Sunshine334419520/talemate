/**
 * 子会话与会话列表的判据守卫：`task` 派生的子会话要落盘（轨迹/调试要看），但不能混进用户会话列表。
 * 两条判据都是结构字段；`task:` 标题前缀只兜底还没写过 depth 的旧数据。
 */
import { describe, test, expect } from "bun:test";
import { isSubagentSession } from "../src/storage/session-store";
import { renderTaskResult } from "../src/tool/core_tools";

describe("会话列表 · 子会话过滤", () => {
  test("depth > 0 / 有父会话 / 旧数据的 task: 标题都算子会话", () => {
    const cases = [
      { depth: 1, title: "task:考据" },
      { parentSessionId: "parent-1", title: "task:规划者" },
      { title: "task:考据" },
    ];
    expect(cases.filter((m) => !isSubagentSession(m))).toEqual([]);
  });

  test("普通用户会话不算子会话", () => {
    const cases = [{ title: "我想写一部重生小说" }, { depth: 0, title: "新会话" }, undefined];
    expect(cases.filter((m) => isSubagentSession(m))).toEqual([]);
  });
});

describe("task 结果回填", () => {
  test("非空结果原样回填，带完成态与子会话 id", () => {
    const out = renderTaskResult("researcher", "结论：栾氏灭于前 550 年。\n", "sub-1");
    expect(out).toContain('state="completed"');
    expect(out).toContain('session="sub-1"');
    expect(out).toContain("栾氏灭于前 550 年");
  });

  test("空结果必须显式标成 empty，不能回填一个空 task_result", () => {
    const out = renderTaskResult("researcher", "   \n", "sub-2");
    expect(out).toContain('state="empty"');
    expect(out).toContain("没有返回任何结论");
    expect(out).not.toContain("<task_result>\n\n</task_result>");
  });
});
