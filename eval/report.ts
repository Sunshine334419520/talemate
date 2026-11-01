/**
 * 一页报告：把 RunResult[] 折成"能不能下结论"的文本。
 *
 * 只做聚合，不重新跑 case、不改判据。固定格式见 docs/eval-system.md §12.2；
 * 报告进 git，trace 留在 traces/ 由 runId 关联。
 */
import type { RunResult } from "./types";

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

export function renderBaselineReport(results: readonly RunResult[], clock: string): string {
  const byCase = new Map<string, RunResult[]>();
  for (const result of results) {
    const list = byCase.get(result.caseId);
    if (list === undefined) byCase.set(result.caseId, [result]);
    else list.push(result);
  }

  const cases = [...byCase.entries()];
  const passed = cases.filter(([, runs]) => runs.every((run) => run.verdict === "pass"));
  const stable = cases.filter(([, runs]) => sameOutcome(runs));
  const first = results[0];

  const lines: string[] = [
    "# baseline",
    "",
    `> 时钟：\`${clock}\` · case：${cases.length} · 重复：${results.length === 0 ? 0 : Math.max(...results.map((r) => r.repeat)) + 1} · 变体：baseline`,
    "",
    "## 结论",
    "",
    passed.length === cases.length
      ? `baseline ${passed.length}/${cases.length} 全部通过；replay ${stable.length}/${cases.length} 组重复一致。`
      : `baseline ${passed.length}/${cases.length} 通过；失败的 case 先修 case 或产品，不要用它做对比。`,
    ...(stable.length === cases.length ? [] : ["", `⚠ ${cases.length - stable.length} 组重复结果不一致，replay 或 case 还不稳定。`]),
    "",
    "## 主表",
    "",
    "| case | family | base | 重复 | pass^k | 失败判据 | 步数 | token | 墙钟 | runId |",
    "|---|---|---|---:|---|---|---:|---:|---:|---|",
  ];

  for (const [caseId, runs] of cases) {
    const allPass = runs.every((run) => run.verdict === "pass");
    const failed = runs.flatMap((run) => run.checks.filter((check) => !check.ok).map((check) => check.id));
    const uniqueFailed = [...new Set(failed)];
    const run = runs[0];
    lines.push(
      `| ${caseId} | ${run?.family ?? "?"} | ${run?.base === true ? "✅" : "—"} | ${runs.length} | ${allPass ? "✅" : "❌"} | ${
        uniqueFailed.join("<br>") || "—"
      } | ${run?.steps ?? 0} | ${(run?.usage.input ?? 0) + (run?.usage.output ?? 0)} | ${run?.wallMs ?? 0}ms | ${runs
        .map((r) => r.runId)
        .join("<br>")} |`,
    );
  }

  const failures = results.filter((result) => result.verdict !== "pass");
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
    `- token 合计（每组第一次重复）：${cases.reduce((n, [, runs]) => n + (runs[0]?.usage.input ?? 0) + (runs[0]?.usage.output ?? 0), 0)}`,
    `- 失败桶：${failures.length === 0 ? "无" : [...new Set(failures.map((f) => f.failureBucket ?? "other"))].join("、")}`,
    "- 人民币：M1 未计价（costYuan 固定为 0）",
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

/** baseline vs variant：同一批 case 的判据结果对照。只做聚合，不重新跑。 */
export function renderComparisonReport(
  results: readonly RunResult[],
  clock: string,
  variantId: string,
  note: string,
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
  const changed = cases.filter(([, pair]) => {
    const b = pair.baseline.every((r) => r.verdict === "pass");
    const v = pair.variant.every((r) => r.verdict === "pass");
    return b !== v;
  });

  const lines: string[] = [
    `# ${variantId} vs baseline`,
    "",
    `> 时钟：\`${clock}\` · case：${cases.length} · 变体：${variantId} · ${note}`,
    "",
    "## 结论",
    "",
    changed.length === 0
      ? "两组结果没有差异（判据维度）。"
      : `${changed.length} 个 case 的结果变了：${changed.map(([id]) => id).join("、")}。`,
    "",
    "## 主表",
    "",
    "| case | family | baseline | variant | 判据变化 | token Δ |",
    "|---|---|---|---|---|---:|",
  ];

  for (const [caseId, pair] of cases) {
    const bPass = pair.baseline.length > 0 && pair.baseline.every((r) => r.verdict === "pass");
    const vPass = pair.variant.length > 0 && pair.variant.every((r) => r.verdict === "pass");
    const bFailed = new Set(pair.baseline.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => c.id)));
    const vFailed = new Set(pair.variant.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => c.id)));
    const delta = [
      ...[...vFailed].filter((id) => !bFailed.has(id)).map((id) => `+${id}`),
      ...[...bFailed].filter((id) => !vFailed.has(id)).map((id) => `-${id}`),
    ].join("<br>") || "—";
    const bTokens = pair.baseline[0] === undefined ? 0 : pair.baseline[0].usage.input + pair.baseline[0].usage.output;
    const vTokens = pair.variant[0] === undefined ? 0 : pair.variant[0].usage.input + pair.variant[0].usage.output;
    const deltaTokens = bTokens === 0 ? "—" : `${Math.round(((vTokens - bTokens) / bTokens) * 100)}%`;
    lines.push(
      `| ${caseId} | ${pair.baseline[0]?.family ?? pair.variant[0]?.family ?? "?"} | ${
        pair.baseline.length === 0 ? "—" : bPass ? "✅" : "❌"
      } | ${pair.variant.length === 0 ? "—" : vPass ? "✅" : "❌"} | ${delta} | ${deltaTokens} |`,
    );
  }

  const failures = variantRuns.filter((result) => result.verdict !== "pass");
  if (failures.length > 0) {
    lines.push("", "## variant 的失败", "");
    for (const result of failures) {
      lines.push(`### ${result.runId} · ${result.verdict}${result.failureBucket === undefined ? "" : ` · ${result.failureBucket}`}`, "");
      for (const check of result.checks.filter((c) => !c.ok)) lines.push(`- \`${check.id}\`：${check.detail ?? ""}`);
    }
  }

  lines.push(
    "",
    "## 成本",
    "",
    `- baseline 首轮 token：${cases.reduce((n, [, p]) => n + (p.baseline[0]?.usage.input ?? 0) + (p.baseline[0]?.usage.output ?? 0), 0)}`,
    `- ${variantId} 首轮 token：${cases.reduce((n, [, p]) => n + (p.variant[0]?.usage.input ?? 0) + (p.variant[0]?.usage.output ?? 0), 0)}`,
    `- 失败桶：${failures.length === 0 ? "无" : [...new Set(failures.map((f) => f.failureBucket ?? "other"))].join("、")}`,
    "",
    "## Manifest",
    "",
    "```json",
    JSON.stringify(first?.manifest ?? {}, null, 2),
    "```",
    "",
  );
  return lines.join("\n");
}
