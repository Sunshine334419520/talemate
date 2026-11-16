/**
 * 决策规则：把 baseline/variant 的 RunResult 逐条对照 docs/eval-system.md §12.3。
 *
 * 规则写死在这里，跑之前就定好；报告只把 pass/fail/unverified 打出来，
 * 不根据结果临时挑一条好看的规则。unverified 不是 pass——缺证据时结论是"证据不足"。
 */
import type { Family, RunResult } from "./types";

export interface DecisionRule {
  id: string;
  rule: string;
  status: "pass" | "fail" | "unverified";
  detail: string;
}

export interface Decision {
  verdict: "adopt" | "reject" | "insufficient";
  rules: DecisionRule[];
}

interface CasePair {
  caseId: string;
  baseline: RunResult[];
  variant: RunResult[];
}

function firstRepeat(runs: readonly RunResult[]): RunResult | undefined {
  return runs.find((run) => run.repeat === 0) ?? runs[0];
}

/** 一组重复全部 pass 才算这一侧通过；空组不算 */
function allPass(runs: readonly RunResult[]): boolean {
  return runs.length > 0 && runs.every((run) => run.verdict === "pass");
}

function sumUsage(runs: readonly RunResult[]): { tokens: number; steps: number } {
  let tokens = 0;
  let steps = 0;
  for (const run of runs) {
    tokens += run.usage.input + run.usage.output;
    steps += run.steps;
  }
  return { tokens, steps };
}

function percentDelta(baseline: number, variant: number): number {
  if (baseline === 0) return 0;
  return (variant - baseline) / baseline;
}

function formatPercent(delta: number): string {
  const value = delta * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function names(runs: readonly CasePair[]): string {
  return runs.map((pair) => pair.caseId).join("、");
}

/**
 * 五条规则，任一条 fail 即"不采用"；没有 fail 但有 unverified 即"证据不足"。
 * 目标 family 缺省、holdout 未跑、其他 family 没参与本轮，都记 unverified——
 * 这正是采纳之前必须补齐的东西。
 */
export function decideComparison(
  results: readonly RunResult[],
  options?: { targetFamily?: Family; minRepeats?: number },
): Decision {
  const byCase = new Map<string, CasePair>();
  for (const result of results) {
    const pair = byCase.get(result.caseId) ?? { caseId: result.caseId, baseline: [], variant: [] };
    if (result.variantId === "baseline") pair.baseline.push(result);
    else pair.variant.push(result);
    byCase.set(result.caseId, pair);
  }
  const pairs = [...byCase.values()].filter((pair) => pair.baseline.length > 0 && pair.variant.length > 0);
  const meta = (pair: CasePair): RunResult | undefined => firstRepeat(pair.baseline) ?? firstRepeat(pair.variant);
  const target = options?.targetFamily;
  const minRepeats = options?.minRepeats ?? 3;
  const rules: DecisionRule[] = [];

  const basePairs = pairs.filter((pair) => meta(pair)?.base === true);
  if (basePairs.length === 0) {
    rules.push({ id: "base", rule: "base case 100% 通过（pass^k）", status: "unverified", detail: "本轮没有 base case" });
  } else if (
    basePairs.some((pair) => pair.baseline.length < minRepeats || pair.variant.length < minRepeats)
  ) {
    rules.push({
      id: "base",
      rule: "base case 100% 通过（pass^k）",
      status: "unverified",
      detail: `重复次数不足 ${minRepeats}，pass^k 不成立`,
    });
  } else {
    const failed = basePairs.filter((pair) => !allPass(pair.variant));
    rules.push({
      id: "base",
      rule: "base case 100% 通过（pass^k）",
      status: failed.length === 0 ? "pass" : "fail",
      detail: failed.length === 0 ? `${basePairs.length} 个 base case 全过` : `variant 未通过：${names(failed)}`,
    });
  }

  if (target === undefined) {
    rules.push({
      id: "target",
      rule: "目标 family 达阈值",
      status: "unverified",
      detail: "没有指定 --target-family",
    });
  } else {
    const targetPairs = pairs.filter((pair) => meta(pair)?.family === target);
    if (targetPairs.length === 0) {
      rules.push({
        id: "target",
        rule: `目标 family「${target}」达阈值`,
        status: "unverified",
        detail: "本轮没有这个 family 的 case",
      });
    } else {
      const failed = targetPairs.filter((pair) => !allPass(pair.variant));
      rules.push({
        id: "target",
        rule: `目标 family「${target}」达阈值（确定性口径：全过）`,
        status: failed.length === 0 ? "pass" : "fail",
        detail:
          failed.length === 0
            ? `${targetPairs.length} 个 case 全过（rubric 阈值尚未接进报告，这里用判据代理）`
            : `variant 未通过：${names(failed)}`,
      });
    }
  }

  const costs = pairs.map((pair) => ({
    caseId: pair.caseId,
    baseline: sumUsage(pair.baseline.filter((run) => run.repeat === 0)),
    variant: sumUsage(pair.variant.filter((run) => run.repeat === 0)),
  }));
  const baselineTotal = costs.reduce(
    (total, cost) => ({ tokens: total.tokens + cost.baseline.tokens, steps: total.steps + cost.baseline.steps }),
    { tokens: 0, steps: 0 },
  );
  const variantTotal = costs.reduce(
    (total, cost) => ({ tokens: total.tokens + cost.variant.tokens, steps: total.steps + cost.variant.steps }),
    { tokens: 0, steps: 0 },
  );
  if (baselineTotal.tokens === 0 && baselineTotal.steps === 0) {
    rules.push({ id: "cost", rule: "成本 ≤ baseline +15%", status: "unverified", detail: "baseline 没有 token/步数记录" });
  } else {
    const tokenDelta = percentDelta(baselineTotal.tokens, variantTotal.tokens);
    const stepDelta = percentDelta(baselineTotal.steps, variantTotal.steps);
    const worst = Math.max(tokenDelta, stepDelta);
    rules.push({
      id: "cost",
      rule: "成本 ≤ baseline +15%（token 或步数，取更敏感者）",
      status: worst <= 0.15 ? "pass" : "fail",
      detail: `token ${formatPercent(tokenDelta)}（${baselineTotal.tokens}→${variantTotal.tokens}），步数 ${formatPercent(
        stepDelta,
      )}（${baselineTotal.steps}→${variantTotal.steps}）`,
    });
  }

  if (target === undefined) {
    rules.push({
      id: "no-regression",
      rule: "其他 family 无回退",
      status: "unverified",
      detail: "没有目标 family 就划不出「其他」",
    });
  } else {
    const others = pairs.filter((pair) => meta(pair)?.family !== target);
    if (others.length === 0) {
      rules.push({
        id: "no-regression",
        rule: "其他 family 无回退",
        status: "unverified",
        detail: "本轮没有跑其他 family",
      });
    } else {
      const regressions = others.filter((pair) => allPass(pair.baseline) && !allPass(pair.variant));
      rules.push({
        id: "no-regression",
        rule: "其他 family 无回退",
        status: regressions.length === 0 ? "pass" : "fail",
        detail: regressions.length === 0 ? `${others.length} 个其他 family case 无回退` : `回退：${names(regressions)}`,
      });
    }
  }

  const holdoutPairs = pairs.filter((pair) => meta(pair)?.holdout === true);
  if (holdoutPairs.length === 0) {
    rules.push({
      id: "holdout",
      rule: "holdout 无反向证据",
      status: "unverified",
      detail: "本轮没有 holdout case",
    });
  } else {
    const reverse = holdoutPairs.filter((pair) => allPass(pair.baseline) && !allPass(pair.variant));
    rules.push({
      id: "holdout",
      rule: "holdout 无反向证据",
      status: reverse.length === 0 ? "pass" : "fail",
      detail: reverse.length === 0 ? `${holdoutPairs.length} 个 holdout case 无反向证据` : `反向证据：${names(reverse)}`,
    });
  }

  const failed = rules.some((rule) => rule.status === "fail");
  const unverified = rules.some((rule) => rule.status === "unverified");
  return { verdict: failed ? "reject" : unverified ? "insufficient" : "adopt", rules };
}