/**
 * 决策规则的守卫：五条规则按 docs/eval-system.md §12.3 判，缺证据是"证据不足"而不是"采用"。
 */
import { describe, expect, test } from "bun:test";
import { decideComparison } from "../eval/decide";
import type { Family, RunResult } from "../eval/types";

function run(
  caseId: string,
  variantId: string,
  verdict: RunResult["verdict"],
  options: { family?: Family; base?: boolean; holdout?: boolean; tokens?: number; steps?: number; repeat?: number } = {},
): RunResult {
  return {
    runId: `${caseId}-${variantId}`,
    caseId,
    family: options.family ?? "design",
    base: options.base ?? true,
    holdout: options.holdout ?? false,
    variantId,
    repeat: options.repeat ?? 0,
    manifest: {
      runId: `${caseId}-${variantId}`,
      caseHash: "case",
      promptHash: "prompt",
      promptParts: {},
      contextHash: "context",
      toolsHash: "tools",
      model: { provider: "test", model: "test", maxTokens: 1000 },
      codeCommit: "test",
      bun: "test",
      clock: "2026-11-01",
    },
    checks: [],
    verdict,
    steps: options.steps ?? 10,
    usage: { input: options.tokens ?? 100, output: 0 },
    costYuan: 0,
    wallMs: 1000,
    tracePath: "traces/test",
  };
}

function pair(
  caseId: string,
  variant: RunResult["verdict"],
  options: { family?: Family; base?: boolean; holdout?: boolean; tokens?: number; steps?: number } = {},
): RunResult[] {
  const runs: RunResult[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    runs.push(run(caseId, "baseline", "pass", { ...options, repeat }), run(caseId, "trial", variant, { ...options, repeat }));
  }
  return runs;
}

describe("decideComparison · 五条规则", () => {
  test("全套证据齐全时采用", () => {
    const results = [
      ...pair("design-core", "pass", { family: "design", base: true }),
      ...pair("prose-chapter", "pass", { family: "prose", base: false }),
      ...pair("design-holdout", "pass", { family: "design", base: false, holdout: true }),
    ];
    const decision = decideComparison(results, { targetFamily: "design" });
    expect(decision.verdict).toBe("adopt");
    expect(decision.rules.every((rule) => rule.status === "pass")).toBe(true);
  });

  test("其他 family 回退即不采用", () => {
    const results = [
      ...pair("design-core", "pass", { family: "design", base: true }),
      ...pair("prose-chapter", "fail", { family: "prose", base: false }),
      ...pair("design-holdout", "pass", { family: "design", base: false, holdout: true }),
    ];
    const decision = decideComparison(results, { targetFamily: "design" });
    expect(decision.verdict).toBe("reject");
    const rule = decision.rules.find((entry) => entry.id === "no-regression");
    expect(rule?.status).toBe("fail");
  });

  test("base case 在 variant 上失败即不采用", () => {
    const results = [
      ...pair("design-core", "fail", { family: "design", base: true }),
      ...pair("prose-chapter", "pass", { family: "prose", base: false }),
      ...pair("design-holdout", "pass", { family: "design", base: false, holdout: true }),
    ];
    const decision = decideComparison(results, { targetFamily: "design" });
    expect(decision.verdict).toBe("reject");
    expect(decision.rules.find((rule) => rule.id === "base")?.status).toBe("fail");
  });

  test("成本涨过 15% 即不采用", () => {
    const results = [
      ...pair("design-core", "pass", { family: "design", base: true, tokens: 200 }),
      ...pair("prose-chapter", "pass", { family: "prose", base: false }),
      ...pair("design-holdout", "pass", { family: "design", base: false, holdout: true }),
    ];
    // baseline 每 case 100 token，variant 的 design-core 是 200
    const baseline = results.filter((entry) => entry.variantId === "baseline");
    for (const entry of baseline) entry.usage = { input: 100, output: 0 };
    const decision = decideComparison(results, { targetFamily: "design" });
    const rule = decision.rules.find((entry) => entry.id === "cost");
    expect(rule?.status).toBe("fail");
    expect(decision.verdict).toBe("reject");
  });

  test("没有 holdout 是证据不足，不是采用", () => {
    const results = [
      ...pair("design-core", "pass", { family: "design", base: true }),
      ...pair("prose-chapter", "pass", { family: "prose", base: false }),
    ];
    const decision = decideComparison(results, { targetFamily: "design" });
    expect(decision.verdict).toBe("insufficient");
    expect(decision.rules.find((rule) => rule.id === "holdout")?.status).toBe("unverified");
  });

  test("没有目标 family 也判不出来", () => {
    const results = [
      ...pair("design-core", "pass", { family: "design", base: true }),
      ...pair("design-holdout", "pass", { family: "design", base: false, holdout: true }),
    ];
    const decision = decideComparison(results);
    expect(decision.verdict).toBe("insufficient");
    expect(decision.rules.find((rule) => rule.id === "target")?.status).toBe("unverified");
  });
});