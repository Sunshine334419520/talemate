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

import type { Family, RunResult } from "../eval/types";
import { renderBaselineReport, renderComparisonReport } from "../eval/report";

function makeRun(
  caseId: string,
  variantId: string,
  verdict: RunResult["verdict"],
  options: {
    family?: Family;
    base?: boolean;
    holdout?: boolean;
    repeat?: number;
    bucket?: RunResult["failureBucket"];
    rubricScore?: number;
  } = {},
): RunResult {
  return {
    runId: `${caseId}-${variantId}-${options.repeat ?? 0}`,
    caseId,
    family: options.family ?? "design",
    base: options.base ?? true,
    holdout: options.holdout ?? false,
    ...(options.rubricScore === undefined ? {} : { rubricScore: options.rubricScore }),
    variantId,
    repeat: options.repeat ?? 0,
    manifest: {
      runId: "x",
      caseHash: "case",
      promptHash: "prompt",
      promptParts: {},
      contextHash: "context",
      toolsHash: "tools",
      model: { provider: "test", model: "test", maxTokens: 100 },
      codeCommit: "test",
      bun: "test",
      clock: "2026-11-01",
    },
    checks: [],
    verdict,
    ...(options.bucket === undefined ? {} : { failureBucket: options.bucket }),
    steps: 5,
    usage: { input: 100, output: 0 },
    costYuan: 0,
    wallMs: 10,
    tracePath: "traces/x",
  };
}

describe("报告 · pass@k 与判断段", () => {
  test("重复里一次过、一次没过：pass@k 成立，pass^k 不成立", () => {
    const report = renderBaselineReport(
      [makeRun("design-core", "baseline", "pass", { repeat: 0 }), makeRun("design-core", "baseline", "fail", { repeat: 1 })],
      "2026-11-01",
    );
    expect(report).toContain("| pass@k | pass^k |");
    expect(report).toContain("单次通过率 50.0%");
  });

  test("报告读 RunResult.perception，不从事件另算一份", () => {
    const baseline = {
      ...makeRun("prose-chapter-basic", "baseline", "pass", { family: "prose", base: true }),
      perception: { plans: 2, p0Coverage: 1, deferred: 3, dropped: 4, stale: 1, duplicate: 2, missing: 1, compressionRatio: 0.5, budgetUsed: 7200, budgetCeiling: 12000 },
    };
    const variant = {
      ...makeRun("prose-chapter-basic", "perception-inject", "pass", { family: "prose", base: true }),
      perception: { plans: 2, p0Coverage: 0.5, deferred: 5, dropped: 6, stale: 1, duplicate: 2, missing: 0, compressionRatio: 1, budgetUsed: 9000, budgetCeiling: 12000 },
    };
    const baselineReport = renderBaselineReport([baseline], "2026-11-01");
    expect(baselineReport).toContain("## 感知");
    expect(baselineReport).toContain("| prose-chapter-basic | 2 | 1.00 | 3 | 4 | 1 | 2 | 1 | 0.50 | 7200/12000 |");

    const comparison = renderComparisonReport([baseline, variant], "2026-11-01", "perception-inject", "note", {
      targetFamily: "prose",
    });
    expect(comparison).toContain("## 感知（baseline → variant）");
    expect(comparison).toContain("1.00→0.50");
    expect(comparison).toContain("7200/12000→9000/12000");
  });

  test("证据齐全时判断段给出采用", () => {
    const baseRuns = [0, 1, 2].flatMap((repeat) => [
      makeRun("design-core", "baseline", "pass", { family: "design", base: true, repeat, rubricScore: 3.4 }),
      makeRun("design-core", "trial", "pass", { family: "design", base: true, repeat, rubricScore: 4.2 }),
    ]);
    const results = [
      ...baseRuns,
      makeRun("prose-chapter", "baseline", "pass", { family: "prose", base: false }),
      makeRun("prose-chapter", "trial", "pass", { family: "prose", base: false }),
      makeRun("design-holdout", "baseline", "pass", { family: "design", base: false, holdout: true }),
      makeRun("design-holdout", "trial", "pass", { family: "design", base: false, holdout: true }),
    ];
    const report = renderComparisonReport(results, "2026-11-01", "trial", "note", { targetFamily: "design" });
    expect(report).toContain("## 判断");
    expect(report).toContain("**采用**");
    expect(report).toContain("| rubric |");
    expect(report).toContain("3.4→4.2");
    expect(report).toContain("## 失败桶迁移");
  });

  test("variant 失败进失败桶迁移表", () => {
    const results = [
      makeRun("design-core", "baseline", "pass", { family: "design", base: true, rubricScore: 4.0 }),
      makeRun("design-core", "trial", "fail", { family: "design", base: true, bucket: "no-tool", rubricScore: 2.0 }),
    ];
    const report = renderComparisonReport(results, "2026-11-01", "trial", "note", { targetFamily: "design" });
    expect(report).toContain("| no-tool | 0 | 1 | +1 |");
    expect(report).toContain("**不采用**");
  });
});
