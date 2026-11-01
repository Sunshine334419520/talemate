/**
 * case 的契约校验：只读 JSON，不调模型、不跑 runner。
 *
 * `bun run eval:check` 与测试共用这一份；判据是"case 能不能被 runner 无歧义地读懂"，
 * 不是"case 好不好"。结构问题一次列全，不遇到第一条就停。
 *
 * 边界：只管 case 目录的形状；fixtures 的内容对不对由 case 作者与 runner 负责。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CHECK_KINDS, FAMILIES } from "./types";
import type { CheckKind, EvalCase } from "./types";

export interface Issue {
  where: string;
  message: string;
}

const CHECK_KIND_SET: ReadonlySet<string> = new Set(CHECK_KINDS);
const FAMILY_SET: ReadonlySet<string> = new Set(FAMILIES);

/** 每种判据必须带的字段；值本身还要单独校验。 */
const CHECK_FIELDS: Record<CheckKind, readonly string[]> = {
  "file-exists": ["path"],
  "file-absent": ["path"],
  "file-unchanged": ["path", "against"],
  "file-contains": ["path", "text"],
  "file-matches": ["path", "pattern"],
  "tool-called": ["name"],
  "tool-not-called": ["name"],
  "tool-order": ["names"],
  "turn-halted": ["afterTool"],
  "change-recorded": ["path"],
  "max-steps": ["n"],
  "max-tokens": ["n"],
  "event-exists": ["type"],
  "event-count-at-most": ["type", "n"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateCheck(value: unknown, at: string): Issue[] {
  const issues: Issue[] = [];
  if (!isRecord(value)) return [{ where: at, message: "判据必须是一个对象" }];

  const kind = value.kind;
  if (typeof kind !== "string" || !CHECK_KIND_SET.has(kind)) {
    return [{ where: at, message: `未知判据 kind：${JSON.stringify(kind)}` }];
  }

  const fields = CHECK_FIELDS[kind as CheckKind];
  const missing = fields.filter((field) => value[field] === undefined);
  if (missing.length > 0) {
    issues.push({ where: at, message: `${kind} 缺少字段：${missing.join("、")}` });
  }

  if (value.afterTurn !== undefined && (typeof value.afterTurn !== "number" || !Number.isInteger(value.afterTurn) || value.afterTurn < 0)) {
    issues.push({ where: at, message: "afterTurn 必须是非负整数" });
  }

  if (fields.includes("path") && !isText(value.path)) issues.push({ where: at, message: "path 必须是非空字符串" });
  if (fields.includes("text") && !isText(value.text)) issues.push({ where: at, message: "text 必须是非空字符串" });
  if (fields.includes("pattern") && !isText(value.pattern)) issues.push({ where: at, message: "pattern 必须是非空字符串" });
  if (fields.includes("name") && !isText(value.name)) issues.push({ where: at, message: "name 必须是非空字符串" });
  if (fields.includes("type") && !isText(value.type)) issues.push({ where: at, message: "type 必须是非空字符串" });
  if (fields.includes("afterTool") && !isText(value.afterTool)) issues.push({ where: at, message: "afterTool 必须是非空字符串" });

  if (fields.includes("n") && !isPositiveInt(value.n)) issues.push({ where: at, message: "n 必须是正整数" });

  if (kind === "file-unchanged" && value.against !== "fixture" && value.against !== "before") {
    issues.push({ where: at, message: 'against 只能是 "fixture" 或 "before"' });
  }

  if (kind === "change-recorded" && value.changeKind !== undefined) {
    const recorded = value.changeKind;
    if (recorded !== "created" && recorded !== "modified" && recorded !== "deleted") {
      issues.push({ where: at, message: "change-recorded 的 changeKind 只能是 created / modified / deleted" });
    }
  }

  if (kind === "tool-order") {
    const names = value.names;
    if (!Array.isArray(names) || names.length === 0 || names.some((name) => !isText(name))) {
      issues.push({ where: at, message: "names 必须是非空的字符串数组" });
    }
  }

  return issues;
}

/** 纯校验：一个 case 对象。不读文件系统。 */
export function validateCase(value: unknown): Issue[] {
  if (!isRecord(value)) return [{ where: "case", message: "case 必须是一个 JSON 对象" }];

  const issues: Issue[] = [];
  const id = value.id;
  const family = value.family;

  if (!isText(id) || !/^[a-z][a-z0-9-]*$/.test(id)) {
    issues.push({ where: "id", message: "id 必须是小写英文、数字与连字符，且以字母开头" });
  }
  if (typeof family !== "string" || !FAMILY_SET.has(family)) {
    issues.push({ where: "family", message: `family 必须是：${FAMILIES.join(" / ")}` });
  } else if (isText(id) && !id.startsWith(`${family}-`)) {
    issues.push({ where: "id", message: `id 必须以 "${family}-" 开头` });
  }

  if (typeof value.base !== "boolean") issues.push({ where: "base", message: "base 必须是布尔值" });
  if (!isText(value.brief)) issues.push({ where: "brief", message: "brief 必须是非空字符串" });

  if (value.followUps !== undefined) {
    const followUps = value.followUps;
    if (!Array.isArray(followUps) || followUps.some((t) => typeof t !== "string")) {
      issues.push({ where: "followUps", message: "followUps 必须是字符串数组" });
    }
  }

  if (value.fixtures !== undefined && typeof value.fixtures !== "boolean") {
    issues.push({ where: "fixtures", message: "fixtures 必须是布尔值" });
  }
  if (value.prosePlanChapter !== undefined && !isPositiveInt(value.prosePlanChapter)) {
    issues.push({ where: "prosePlanChapter", message: "prosePlanChapter 必须是正整数" });
  }
  if (value.prosePlanContent !== undefined && !isText(value.prosePlanContent)) {
    issues.push({ where: "prosePlanContent", message: "prosePlanContent 必须是非空字符串" });
  }
  if (value.mode !== undefined && value.mode !== "draft" && value.mode !== "accept-edits" && value.mode !== "prose") {
    issues.push({ where: "mode", message: "mode 只能是 draft / accept-edits / prose" });
  }
  if (value.answerer !== undefined && typeof value.answerer !== "boolean") {
    issues.push({ where: "answerer", message: "answerer 必须是布尔值" });
  }
  if (value.model !== undefined) {
    if (!isRecord(value.model)) {
      issues.push({ where: "model", message: "model 必须是对象" });
    } else {
      const reasoning = value.model.reasoning;
      if (reasoning !== undefined && reasoning !== "off" && reasoning !== "low" && reasoning !== "high" && reasoning !== "max") {
        issues.push({ where: "model.reasoning", message: "reasoning 只能是 off / low / high / max" });
      }
      if (value.model.temperature !== undefined && typeof value.model.temperature !== "number") {
        issues.push({ where: "model.temperature", message: "temperature 必须是数字" });
      }
      if (value.model.maxTokens !== undefined && !isPositiveInt(value.model.maxTokens)) {
        issues.push({ where: "model.maxTokens", message: "maxTokens 必须是正整数" });
      }
    }
  }

  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    issues.push({ where: "checks", message: "checks 必须是非空数组" });
  } else {
    value.checks.forEach((check, index) => {
      issues.push(...validateCheck(check, `checks[${index}]`));
    });
  }

  const budget = value.budget;
  if (!isRecord(budget)) {
    issues.push({ where: "budget", message: "budget 必须是对象" });
  } else {
    for (const key of ["maxTurns", "maxSteps", "maxTokens"] as const) {
      if (!isPositiveInt(budget[key])) {
        issues.push({ where: `budget.${key}`, message: `${key} 必须是正整数` });
      }
    }
    const turns = 1 + (Array.isArray(value.followUps) ? value.followUps.length : 0);
    const maxTurns = budget.maxTurns;
    if (isPositiveInt(maxTurns) && maxTurns < turns) {
      issues.push({ where: "budget.maxTurns", message: `case 有 ${turns} 轮，maxTurns 不能小于它` });
    }
  }

  if (value.rubric !== undefined && !isText(value.rubric)) {
    issues.push({ where: "rubric", message: "rubric 必须是非空字符串" });
  }
  if (value.anchors !== undefined) {
    const anchors = value.anchors;
    if (!isRecord(anchors) || !isText(anchors.low) || !isText(anchors.mid) || !isText(anchors.high)) {
      issues.push({ where: "anchors", message: "anchors 必须带 low / mid / high 三段非空文本" });
    }
  }
  if (value.holdout !== undefined && typeof value.holdout !== "boolean") {
    issues.push({ where: "holdout", message: "holdout 必须是布尔值" });
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((t) => typeof t !== "string"))) {
    issues.push({ where: "tags", message: "tags 必须是字符串数组" });
  }

  return issues;
}

/** 读一份 case.json 并校验（含目录/id、fixtures、rubric 的存在性）。 */
export async function validateCaseDir(
  evalRoot: string,
  dirName: string,
): Promise<{ issues: Issue[]; case?: EvalCase }> {
  const dir = join(evalRoot, "cases", dirName);
  const issues: Issue[] = [];
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(dir, "case.json"), "utf-8"));
  } catch (err) {
    return { issues: [{ where: dirName, message: `读不到 case.json：${err instanceof Error ? err.message : String(err)}` }] };
  }

  issues.push(...validateCase(value).map((i) => ({ ...i, where: `${dirName}/${i.where}` })));
  if (!isRecord(value)) return { issues };

  if (isText(value.id) && value.id !== dirName) {
    issues.push({ where: dirName, message: `目录名与 id 不一致（id=${value.id}）` });
  }

  if (value.fixtures === true) {
    const fixtureDir = join(dir, "fixtures");
    let entries: string[] = [];
    try {
      entries = await readdir(fixtureDir);
    } catch {
      issues.push({ where: dirName, message: "fixtures=true 但没有 fixtures/ 目录" });
    }
    if (entries.length === 0) issues.push({ where: dirName, message: "fixtures/ 是空的" });
  }

  if (isText(value.rubric)) {
    try {
      const info = await stat(join(evalRoot, "rubric", `${value.rubric}.md`));
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      issues.push({ where: dirName, message: `rubric/${value.rubric}.md 不存在` });
    }
  }

  return { issues, case: value as unknown as EvalCase };
}

/** 扫 eval/cases 下所有目录；返回 case 数、base/holdout 数与全部问题。 */
export async function validateAll(
  evalRoot: string,
): Promise<{ cases: number; base: number; holdout: number; issues: Issue[] }> {
  const casesDir = join(evalRoot, "cases");
  let dirs: string[];
  try {
    dirs = (await readdir(casesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { cases: 0, base: 0, holdout: 0, issues: [{ where: casesDir, message: "cases/ 目录不存在" }] };
  }

  const issues: Issue[] = [];
  const seen = new Set<string>();
  let base = 0;
  let holdout = 0;
  for (const dir of dirs) {
    const result = await validateCaseDir(evalRoot, dir);
    issues.push(...result.issues);
    if (result.case === undefined) continue;
    if (seen.has(result.case.id)) {
      issues.push({ where: dir, message: `case id 重复：${result.case.id}` });
    }
    seen.add(result.case.id);
    if (result.case.base) base++;
    if (result.case.holdout) holdout++;
  }
  if (dirs.length === 0) issues.push({ where: casesDir, message: "没有任何 case" });

  return { cases: dirs.length, base, holdout, issues };
}
