/**
 * 报告命名的守卫：报告按运行日归档，不按冻结时钟；重名不覆盖。
 *
 * 这条测试盯着一个真实事故：`--today` 同时被拿去拼文件名，跑一次 gate 就把
 * 已提交的基线报告改写成当次结果，历史静默丢失。
 */
import { describe, expect, test } from "bun:test";
import { defaultReportName } from "../eval/report";

describe("报告命名 · 按运行日", () => {
  test("用运行日，不用冻结时钟的日期", () => {
    expect(defaultReportName(new Date(2026, 10, 15), "baseline", [])).toBe("2026-11-15-baseline.md");
  });

  test("重名时追加序号，不覆盖已有报告", () => {
    expect(defaultReportName(new Date(2026, 10, 15), "baseline", ["2026-11-15-baseline.md"])).toBe(
      "2026-11-15-baseline-2.md",
    );
    expect(
      defaultReportName(new Date(2026, 10, 15), "baseline", ["2026-11-15-baseline.md", "2026-11-15-baseline-2.md"]),
    ).toBe("2026-11-15-baseline-3.md");
  });

  test("变体名各用各的", () => {
    expect(defaultReportName(new Date(2026, 0, 3), "no-edit-tool", [])).toBe("2026-01-03-no-edit-tool.md");
  });
});
