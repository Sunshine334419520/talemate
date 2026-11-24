/**
 * find：`glob` 与 `grep` 的共享实现——范围解析、候选集过滤、上限与渲染。
 *
 * 两个工具只声明"找什么、范围、上限"，执行都在这里；候选集来自语料层的
 * `enumerateDocs(projectId)`，也就是**项目根表里 `search && read` 的目录**。工具层不认识根名，
 * 加一个根（`notes/`）不需要改这里，更不需要改工具。
 *
 * 判据：
 * - 路径一律项目相对；范围必须落在可搜索的根里，不许绝对路径/`..`；
 * - `glob` 不读内容，`grep` 才读；
 * - 上限固定（glob 100 个文件 / grep 100 条命中、单文件 20 条、单行 500 字），不提供分页参数；
 * - 空结果是正常结果；参数/正则错误抛 `FindError`（工具层转成给模型的自愈文案）。
 */
import { projectCorpusRoots } from "../core/config";
import { searchableCorpusRoots } from "../core/roots";
import { docStat, enumerateDocs, readDoc } from "../storage/corpus";
import { matchGlob } from "./glob";

export const GLOB_LIMIT = 100;
export const GREP_LIMIT = 100;
export const GREP_PER_FILE = 20;
export const GREP_LINE_MAX = 500;
export const GREP_CONTEXT_MAX = 3;

/** 模型能自己修的错误：缺参数、范围不对、正则写坏。工具层捕获它并 `return`。 */
export class FindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindError";
  }
}

interface Scope {
  /** 语料前缀（带尾斜杠；整本书为 ""） */
  prefix: string;
  /** grep 专用：范围是一个具体文件 */
  file?: string;
}

function rootsLine(projectId: string): string {
  return searchableCorpusRoots(projectCorpusRoots(projectId))
    .map((r) => r.dir)
    .join(" / ");
}

/**
 * 把 `path` 解析成可搜索范围：目录（含空串 = 整本书）或一个文件。
 * 不在可搜索根里的路径直接抛，让模型改 path，而不是静默搜出空结果。
 */
async function resolveScope(projectId: string, path: string | undefined, allowFile: boolean): Promise<Scope> {
  const clean = (path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean === "") return { prefix: "" };

  const roots = searchableCorpusRoots(projectCorpusRoots(projectId));
  const hit = roots.find((r) => clean === r.dir || clean.startsWith(`${r.dir}/`));
  if (hit === undefined) {
    throw new FindError(`范围「${clean}」不在可搜索的目录里。可用：${rootsLine(projectId)}（或省略 path 搜整本书）。`);
  }
  const kind = await docStat(projectId, clean);
  if (kind === undefined) throw new FindError(`没有这个目录或文件：${clean}。`);
  if (kind === "file") {
    if (!allowFile) throw new FindError(`path「${clean}」是文件；glob 只收目录。`);
    return { prefix: "", file: clean };
  }
  return { prefix: `${clean}/` };
}

function sortPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b, "zh", { numeric: true }));
}

/** 相对 scope 的路径 → 项目相对路径。 */
function projectPath(scope: Scope, rel: string): string {
  return scope.file ?? `${scope.prefix}${rel}`;
}

// 候选集内的相对路径（用于匹配 pattern/include）
async function candidates(projectId: string, scope: Scope): Promise<string[]> {
  if (scope.file !== undefined) return [scope.file];
  const prefix = scope.prefix;
  return (await enumerateDocs(projectId, prefix)).map((p) => p.slice(prefix.length));
}

export interface GlobResult {
  text: string;
  paths: string[];
  truncated: boolean;
}

/** `glob`：按模式找文件路径，不读内容。 */
export async function globDocs(projectId: string, pattern: string, path?: string): Promise<GlobResult> {
  const cleanPattern = pattern.trim();
  if (cleanPattern === "") throw new FindError("glob 缺少 pattern——给一个模式，如 design/**/*.md。");
  const scope = await resolveScope(projectId, path, false);
  const rels = (await candidates(projectId, scope)).filter((rel) => matchGlob(rel, cleanPattern));
  const all = sortPaths(rels.map((rel) => projectPath(scope, rel)));
  const truncated = all.length > GLOB_LIMIT;
  const shown = truncated ? all.slice(0, GLOB_LIMIT) : all;
  if (shown.length === 0) {
    return { text: `没有匹配的文件。模式：${cleanPattern}`, paths: [], truncated: false };
  }
  const lines = [...shown];
  if (truncated) {
    lines.push("", `（结果已截断：只显示前 ${GLOB_LIMIT} 个文件；缩小 path 或 pattern 再试。）`);
  }
  return { text: lines.join("\n"), paths: shown, truncated };
}

export interface GrepOptions {
  pattern: string;
  path?: string;
  include?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
}

export interface GrepResult {
  text: string;
  matches: number;
  truncated: boolean;
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface FileHits {
  path: string;
  entries: { line: number; text: string; match: boolean }[];
  total: number;
  shown: number;
}

/** `grep`：逐行正则搜索，返回文件 → 行号 + 行文本。 */
export async function grepDocs(projectId: string, opts: GrepOptions): Promise<GrepResult> {
  const pattern = opts.pattern;
  if (pattern.trim() === "") throw new FindError("grep 缺少 pattern——给一个正则（或 literal:true 搜普通文本）。");
  let regex: RegExp;
  try {
    regex = new RegExp(opts.literal === true ? escapeLiteral(pattern) : pattern, opts.ignoreCase === true ? "i" : "");
  } catch (e) {
    throw new FindError(`正则写坏了：${(e as Error).message}——改一下 pattern；要按普通文本搜就加 literal:true。`);
  }

  const context = Math.max(0, Math.min(GREP_CONTEXT_MAX, Math.floor(opts.context ?? 0)));
  const include = (opts.include ?? "").trim();
  const scope = await resolveScope(projectId, opts.path, true);
  let rels = await candidates(projectId, scope);
  if (include !== "" && scope.file === undefined) rels = rels.filter((rel) => matchGlob(rel, include));

  const files: FileHits[] = [];
  let total = 0;
  let shownTotal = 0;
  for (const rel of rels) {
    const path = projectPath(scope, rel);
    const content = await readDoc(projectId, path);
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    const matchLines: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i] as string)) matchLines.push(i);
    }
    if (matchLines.length === 0) continue;
    total += matchLines.length;

    const wanted = new Set<number>();
    const shownMatches = matchLines.slice(0, Math.min(GREP_PER_FILE, GREP_LIMIT - shownTotal));
    for (const index of shownMatches) {
      const start = Math.max(0, index - context);
      const end = Math.min(lines.length - 1, index + context);
      for (let i = start; i <= end; i += 1) wanted.add(i);
    }
    const entries: FileHits["entries"] = [];
    let last = -2;
    for (const index of [...wanted].sort((a, b) => a - b)) {
      if (context > 0 && last >= 0 && index > last + 1) entries.push({ line: 0, text: "--", match: false });
      last = index;
      const isMatch = shownMatches.includes(index);
      const raw = (lines[index] as string).trimEnd();
      const text = raw.length > GREP_LINE_MAX ? `${raw.slice(0, GREP_LINE_MAX)}…` : raw;
      entries.push({ line: index + 1, text, match: isMatch });
    }
    files.push({ path, entries, total: matchLines.length, shown: shownMatches.length });
    shownTotal += shownMatches.length;
    if (shownTotal >= GREP_LIMIT) break;
  }

  if (total === 0) return { text: `「${pattern}」在文档里没有命中。`, matches: 0, truncated: false };

  const truncated = shownTotal < total;
  const lines: string[] = [];
  lines.push(
    truncated
      ? `「${pattern}」命中 ${total} 处，显示前 ${shownTotal} 处：`
      : `「${pattern}」命中 ${total} 处，显示全部：`,
  );
  for (const file of files) {
    lines.push(file.path);
    for (const entry of file.entries) {
      if (entry.text === "--") {
        lines.push("  --");
        continue;
      }
      lines.push(`  ${entry.line}${entry.match ? ":" : "-"} ${entry.text}`);
    }
    if (file.shown < file.total) {
      lines.push(`  （本文件还有 ${file.total - file.shown} 处未显示）`);
    }
  }
  if (truncated) {
    lines.push("", `（还有 ${total - shownTotal} 处未显示；缩小 path 或 include 再试。）`);
  }
  return { text: lines.join("\n"), matches: total, truncated };
}