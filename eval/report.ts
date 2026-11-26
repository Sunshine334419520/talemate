/**
 * 一页报告：把 RunResult[] 折成"能不能下结论"的文本。
 *
 * 只做聚合，不重新跑 case、不改判据。固定格式见 docs/eval-system.md §12.2；
 * 报告进 git，trace 留在 traces/ 由 runId 关联。
 */
import { decideComparison, type Decision } from "./decide";
import { bucketCounts, mcnemarExact, reliability, wilsonInterval } from "./stats";
import { FAILURE_BUCKETS, type Family, type PerceptionRunStats, type RunResult } from "./types";

/**
 * 报告默认文件名：按运行日归档，不按 `--today`。
 *
 * `--today` 冻结的是 system prompt 里的日期；拿它给报告命名会让每次 gate 都覆盖同一份
 * 已提交的基线。重名时追加序号，历史不被静默替换。
 */
export function defaultReportName(runDate: Date, variantId: string, taken: Iterable<string>): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${runDate.getFullYear()}-${pad(runDate.getMonth() + 1)}-${pad(runDate.getDate())}`;
  const used = new Set(taken);
  let name = `${stamp}-${variantId}.md`;
  let n = 2;
  while (used.has(name)) {
    name = `${stamp}-${variantId}-${n}.md`;
    n++;
  }
  return name;
}

function sameOutcome(runs: readonly RunResult[]): boolean {
  const first = runs[0];
  if (first === undefined) return true;
  return runs.every(
    (run) =>
      run.verdict === first.verdict &&
      run.checks.length === first.checks.length &&
      run.checks.every((check, index) => {
        const other = first.checks[index];
        return other !== undefined && other.id === check.id && other.ok === check.ok;
      }),
  );
}

function firstRun(runs: readonly RunResult[]): RunResult | undefined {
  return runs.find((run) => run.repeat === 0) ?? runs[0];
}

function allPass(runs: readonly RunResult[]): boolean {
  return runs.length > 0 && runs.every((run) => run.verdict === "pass");
}

function tokensOf(run: RunResult | undefined): number {
  return run === undefined ? 0 : run.usage.input + run.usage.output;
}

function rubricCell(baseline: readonly RunResult[], variant: readonly RunResult[]): string {
  const before = firstRun(baseline)?.rubricScore;
  const after = firstRun(variant)?.rubricScore;
  if (before === undefined && after === undefined) return "—";
  const render = (value: number | undefined): string => (value === undefined ? "—" : value.toFixed(1));
  return `${render(before)}→${render(after)}`;
}

function percentDelta(baseline: number, variant: number): string {
  if (baseline === 0) return "—";
  const value = ((variant - baseline) / baseline) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}%`;
}

function failedFirst(runs: readonly RunResult[]): RunResult | undefined {
  const run = firstRun(runs);
  return run !== undefined && run.verdict !== "pass" ? run : undefined;
}

function perceptionOf(run: RunResult | undefined): PerceptionRunStats | undefined {
  return run?.perception !== undefined && run.perception.plans > 0 ? run.perception : undefined;
}

function pct(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(2);
}

function num(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}

function budget(p: PerceptionRunStats | undefined): string {
  return p?.budgetUsed === undefined || p.budgetCeiling === undefined ? "—" : `${p.budgetUsed}/${p.budgetCeiling}`;
}

function perceptionCell(
  baseline: PerceptionRunStats | undefined,
  variant: PerceptionRunStats | undefined,
  read: (p: PerceptionRunStats | undefined) => string,
): string {
  return `${read(baseline)}→${read(variant)}`;
}

const DECISION_LABEL: Record<Decision["verdict"], string> = {
  adopt: "采用",
  reject: "不采用",
  insufficient: "证据不足",
};

const RULE_STATUS: Record<Decision["rules"][number]["status"], string> = {
  pass: "✅ 通过",
  fail: "❌ 不通过",
  unverified: "⚠ 未验证",
};

export function renderBaselineReport(results: readonly RunResult[], clock: string): string {
  const byCase = new Map<string, RunResult[]>();
  for (const result of results) {
    const list = byCase.get(result.caseId);
    if (list === undefined) byCase.set(result.caseId, [result]);
    else list.push(result);
  }

  const cases = [...byCase.entries()];
  const passed = cases.filter(([, runs]) => allPass(runs));
  const stable = cases.filter(([, runs]) => sameOutcome(runs));
  const first = results[0];
  const k = results.length === 0 ? 0 : Math.max(...results.map((run) => run.repeat)) + 1;
  const passedRuns = results.filter((run) => run.verdict === "pass").length;
  const singleRate = results.length === 0 ? 0 : passedRuns / results.length;
  const rateInterval = wilsonInterval(passedRuns, results.length);
  const rateText =
    rateInterval === undefined
      ? `${(singleRate * 100).toFixed(1)}%`
      : `${(singleRate * 100).toFixed(1)}%（95% CI ${(rateInterval.low * 100).toFixed(1)}%–${(rateInterval.high * 100).toFixed(1)}%）`;

  const lines: string[] = [
    "# baseline",
    "",
    `> 时钟：\`${clock}\` · case：${cases.length} · 重复：${k} · 变体：baseline`,
    "",
    "## 结论",
    "",
    passed.length === cases.length
      ? `baseline ${passed.length}/${cases.length} 全部通过；单次通过率 ${rateText}；replay ${stable.length}/${cases.length} 组重复一致。`
      : `baseline ${passed.length}/${cases.length} 通过；单次通过率 ${rateText}；失败的 case 先修 case 或产品，不要用它做对比。`,
    ...(stable.length === cases.length ? [] : ["", `⚠ ${cases.length - stable.length} 组重复结果不一致，replay 或 case 还不稳定。`]),
    "",
    "## 主表",
    "",
    "| case | family | base | 重复 | pass@k | pass^k | 失败判据 | 步数 | token | 墙钟 | runId |",
    "|---|---|---|---:|---|---|---|---:|---:|---:|---|",
  ];

  for (const [caseId, runs] of cases) {
    const reliabilityOfCase = reliability(
      runs.map((run) => run.verdict),
      k,
    );
    const failed = runs.flatMap((run) => run.checks.filter((check) => !check.ok).map((check) => check.id));
    const uniqueFailed = [...new Set(failed)];
    const run = firstRun(runs);
    lines.push(
      `| ${caseId} | ${run?.family ?? "?"} | ${run?.base === true ? "✅" : "—"} | ${runs.length} | ${
        reliabilityOfCase.passAtK ? "✅" : "❌"
      } | ${reliabilityOfCase.passHatK ? "✅" : "❌"} | ${uniqueFailed.join("<br>") || "—"} | ${run?.steps ?? 0} | ${
        tokensOf(run)
      } | ${run?.wallMs ?? 0}ms | ${runs.map((r) => r.runId).join("<br>")} |`,
    );
  }

  const failures = results.filter((result) => result.verdict !== "pass");
  const perceived = cases.filter(([, runs]) => perceptionOf(firstRun(runs)) !== undefined);
  if (perceived.length > 0) {
    lines.push(
      "",
      "## 感知",
      "",
      "| case | plans | P0 覆盖 | 延迟 | 丢弃 | 过期 | 重复 | 缺失 | 预算 |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const [caseId, runs] of perceived) {
      const p = perceptionOf(firstRun(runs));
      if (p === undefined) continue;
      lines.push(
        `| ${caseId} | ${p.plans} | ${pct(p.p0Coverage)} | ${num(p.deferred)} | ${num(p.dropped)} | ${num(p.stale)} | ${num(p.duplicate)} | ${num(p.missing)} | ${budget(p)} |`,
      );
    }
  }

  if (failures.length > 0) {
    lines.push("", "## 失败", "");
    for (const result of failures) {
      lines.push(`### ${result.runId} · ${result.verdict}${result.failureBucket === undefined ? "" : ` · ${result.failureBucket}`}`, "");
      for (const check of result.checks.filter((c) => !c.ok)) {
        lines.push(`- \`${check.id}\`：${check.detail ?? ""}`);
      }
    }
  }

  lines.push(
    "",
    "## 成本",
    "",
    `- token 合计（每组第一次重复）：${cases.reduce((n, [, runs]) => n + tokensOf(firstRun(runs)), 0)}`,
    `- 步数合计（每组第一次重复）：${cases.reduce((n, [, runs]) => n + (firstRun(runs)?.steps ?? 0), 0)}`,
    `- 失败桶：${failures.length === 0 ? "无" : [...new Set(failures.map((f) => f.failureBucket ?? "other"))].join("、")}`,
    "- 人民币：未接价目表（costYuan 固定为 0）；决策按 token/步数",
    ...(() => {
      const scores = results.map((result) => result.rubricScore).filter((score): score is number => score !== undefined);
      if (scores.length === 0) return [];
      const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      return [`- rubric 均分：${mean.toFixed(1)}/5（${scores.length} 份打分）`];
    })(),
    "- 现场：`traces/<runId>/`（events.jsonl / changes.jsonl / files/）",
    `- 待人工评分（rubric）：${[...new Set(results.map((r) => r.rubric).filter((r): r is string => r !== undefined))].join("、") || "无"}`,
    "",
    "## Manifest",
    "",
    "每组 manifest 见 `traces/<runId>/result.json`；下面是第一组：",
    "",
    "```json",
    JSON.stringify(first?.manifest ?? {}, null, 2),
    "```",
    "",
  );

  return lines.join("\n");
}

/** baseline vs variant：同一批 case 的判据结果对照，并按 §12.3 逐条判。只做聚合，不重新跑。 */
export function renderComparisonReport(
  results: readonly RunResult[],
  clock: string,
  variantId: string,
  note: string,
  options?: { targetFamily?: Family },
): string {
  const byCase = new Map<string, { baseline: RunResult[]; variant: RunResult[] }>();
  for (const result of results) {
    const entry = byCase.get(result.caseId) ?? { baseline: [], variant: [] };
    if (result.variantId === "baseline") entry.baseline.push(result);
    else entry.variant.push(result);
    byCase.set(result.caseId, entry);
  }

  const cases = [...byCase.entries()];
  const first = results.find((result) => result.variantId === "baseline");
  const variantRuns = results.filter((result) => result.variantId === variantId);
  const changed = cases.filter(([, pair]) => allPass(pair.baseline) !== allPass(pair.variant));
  const decision = decideComparison(results, options);

  const disagreements = cases.reduce(
    (counts, [, pair]) => {
      const baselinePass = allPass(pair.baseline);
      const variantPass = allPass(pair.variant);
      if (baselinePass && !variantPass) counts.regressed++;
      if (!baselinePass && variantPass) counts.improved++;
      return counts;
    },
    { regressed: 0, improved: 0 },
  );
  const pValue = mcnemarExact(disagreements.regressed, disagreements.improved);
  const statusCounts = { pass: 0, fail: 0, unverified: 0 };
  for (const rule of decision.rules) statusCounts[rule.status] += 1;

  const lines: string[] = [
    `# ${variantId} vs baseline`,
    "",
    `> 时钟：\`${clock}\` · case：${cases.length} · 变体：${variantId} · ${note}`,
    "",
    "## 结论",
    "",
    `**${DECISION_LABEL[decision.verdict]}** — 规则通过 ${statusCounts.pass}、未验证 ${statusCounts.unverified}、不通过 ${statusCounts.fail}。`,
    "",
    changed.length === 0
      ? "判据维度两组没有差异。"
      : `${changed.length} 个 case 的结果变了：${changed.map(([id]) => id).join("、")}。`,
    "",
    "## 主表",
    "",
    "| case | family | baseline | variant | rubric | 判据变化 | token Δ |",
    "|---|---|---|---|---|---|---:|",
  ];

  for (const [caseId, pair] of cases) {
    const bPass = allPass(pair.baseline);
    const vPass = allPass(pair.variant);
    const bFailed = new Set(pair.baseline.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => c.id)));
    const vFailed = new Set(pair.variant.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => c.id)));
    const delta = [
      ...[...vFailed].filter((id) => !bFailed.has(id)).map((id) => `+${id}`),
      ...[...bFailed].filter((id) => !vFailed.has(id)).map((id) => `-${id}`),
    ].join("<br>") || "—";
    const bTokens = tokensOf(firstRun(pair.baseline));
    const vTokens = tokensOf(firstRun(pair.variant));
    lines.push(
      `| ${caseId} | ${pair.baseline[0]?.family ?? pair.variant[0]?.family ?? "?"} | ${
        pair.baseline.length === 0 ? "—" : bPass ? "✅" : "❌"
      } | ${pair.variant.length === 0 ? "—" : vPass ? "✅" : "❌"} | ${rubricCell(pair.baseline, pair.variant)} | ${delta} | ${percentDelta(bTokens, vTokens)} |`,
    );
  }

  const families = [...new Set(cases.map(([, pair]) => pair.baseline[0]?.family ?? pair.variant[0]?.family ?? "?"))];
  lines.push("", "## 分层", "", "| family | baseline 通过 | variant 通过 | 变化 |", "|---|---:|---:|---:|");
  for (const family of families) {
    const inFamily = cases.filter(([, pair]) => (pair.baseline[0]?.family ?? pair.variant[0]?.family) === family);
    const baselinePassed = inFamily.filter(([, pair]) => allPass(pair.baseline)).length;
    const variantPassed = inFamily.filter(([, pair]) => allPass(pair.variant)).length;
    const change = variantPassed - baselinePassed;
    lines.push(`| ${family} | ${baselinePassed}/${inFamily.length} | ${variantPassed}/${inFamily.length} | ${change >= 0 ? "+" : ""}${change} |`);
  }

  lines.push(
    "",
    "## 配对显著性",
    "",
    `- 由过变败 b=${disagreements.regressed}，由败变过 c=${disagreements.improved}；McNemar 精确双侧 p=${pValue.toFixed(4)}。`,
    `- 同一批 case 前后各跑一次时看这个；p 大只说明这一轮没测出差异，不是"没有差异"。`,
  );

  const failures = variantRuns.filter((result) => result.verdict !== "pass");
  if (failures.length > 0) {
    lines.push("", "## variant 的失败", "");
    for (const result of failures) {
      lines.push(`### ${result.runId} · ${result.verdict}${result.failureBucket === undefined ? "" : ` · ${result.failureBucket}`}`, "");
      for (const check of result.checks.filter((c) => !c.ok)) lines.push(`- \`${check.id}\`：${check.detail ?? ""}`);
    }
  }

  const baselineFailures = cases.flatMap(([, pair]) => {
    const run = failedFirst(pair.baseline);
    return run === undefined ? [] : [run];
  });
  const variantFailures = cases.flatMap(([, pair]) => {
    const run = failedFirst(pair.variant);
    return run === undefined ? [] : [run];
  });
  const baselineBuckets = bucketCounts(baselineFailures);
  const variantBuckets = bucketCounts(variantFailures);
  const buckets = FAILURE_BUCKETS.filter((bucket) => baselineBuckets.has(bucket) || variantBuckets.has(bucket));

  lines.push("", "## 失败桶迁移", "");
  if (buckets.length === 0) {
    lines.push("两组首轮都没有失败。");
  } else {
    lines.push("| 桶 | baseline | variant | Δ |", "|---|---:|---:|---:|");
    for (const bucket of buckets) {
      const before = baselineBuckets.get(bucket) ?? 0;
      const after = variantBuckets.get(bucket) ?? 0;
      const change = after - before;
      lines.push(`| ${bucket} | ${before} | ${after} | ${change >= 0 ? "+" : ""}${change} |`);
    }
    lines.push("", "按 case 首轮计；桶数变化要对着失败明细读，不能只看总数。");
  }

  const perceivedPairs = cases.filter(
    ([, pair]) => perceptionOf(firstRun(pair.baseline)) !== undefined || perceptionOf(firstRun(pair.variant)) !== undefined,
  );
  if (perceivedPairs.length > 0) {
    lines.push(
      "",
      "## 感知（baseline → variant）",
      "",
      "| case | plans | P0 覆盖 | 延迟 | 丢弃 | 过期 | 重复 | 缺失 | 预算 |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const [caseId, pair] of perceivedPairs) {
      const b = perceptionOf(firstRun(pair.baseline));
      const v = perceptionOf(firstRun(pair.variant));
      lines.push(
        `| ${caseId} | ${perceptionCell(b, v, (p) => num(p?.plans))} | ${perceptionCell(b, v, (p) => pct(p?.p0Coverage))} | ${perceptionCell(
          b,
          v,
          (p) => num(p?.deferred),
        )} | ${perceptionCell(b, v, (p) => num(p?.dropped))} | ${perceptionCell(b, v, (p) => num(p?.stale))} | ${perceptionCell(
          b,
          v,
          (p) => num(p?.duplicate),
        )} | ${perceptionCell(b, v, (p) => num(p?.missing))} | ${perceptionCell(
          b,
          v,
          budget,
        )} |`,
      );
    }
  }

  const baselineTokens = cases.reduce((n, [, pair]) => n + tokensOf(firstRun(pair.baseline)), 0);
  const variantTokens = cases.reduce((n, [, pair]) => n + tokensOf(firstRun(pair.variant)), 0);
  const baselineSteps = cases.reduce((n, [, pair]) => n + (firstRun(pair.baseline)?.steps ?? 0), 0);
  const variantSteps = cases.reduce((n, [, pair]) => n + (firstRun(pair.variant)?.steps ?? 0), 0);

  lines.push(
    "",
    "## 成本",
    "",
    `- baseline 首轮：token ${baselineTokens} · 步数 ${baselineSteps}`,
    `- ${variantId} 首轮：token ${variantTokens}（${percentDelta(baselineTokens, variantTokens)}）· 步数 ${variantSteps}（${percentDelta(
      baselineSteps,
      variantSteps,
    )}）`,
    `- 失败桶：${failures.length === 0 ? "无" : [...new Set(failures.map((f) => f.failureBucket ?? "other"))].join("、")}`,
    "- 人民币：未接价目表（costYuan 固定为 0）；决策按 token/步数",
    ...(() => {
      const scores = results.map((result) => result.rubricScore).filter((score): score is number => score !== undefined);
      if (scores.length === 0) return [];
      const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      return [`- rubric 均分：${mean.toFixed(1)}/5（${scores.length} 份打分）`];
    })(),
    `- 待人工评分（rubric）：${[...new Set(results.map((r) => r.rubric).filter((r): r is string => r !== undefined))].join("、") || "无"}`,
    "",
    "## 判断",
    "",
    "| # | 规则 | 结果 | 依据 |",
    "|---:|---|---|---|",
  );
  decision.rules.forEach((rule, index) => {
    lines.push(`| ${index + 1} | ${rule.rule} | ${RULE_STATUS[rule.status]} | ${rule.detail} |`);
  });
  lines.push("", "规则见 `docs/eval-system.md` §12.3；未验证也算证据不足，不能当通过。", "", "## Manifest", "", "```json", JSON.stringify(first?.manifest ?? {}, null, 2), "```", "");

  return lines.join("\n");
}