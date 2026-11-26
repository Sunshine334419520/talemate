/**
 * 语料层：项目里 `.md` 文档的唯一取数入口——枚举 / 读 / 扫词。
 *
 * 判据只能有一份："什么算一份文档"若分给 `storage/project.ts`（收所有 `.md`）与
 * `framework/search.ts`（多一道 `NAME_RE` 过滤）各判一次，迟早不一致；所以全归这里。
 *
 * **候选集不写死**：它是项目根表（`projectCorpusRoots`）里 `search && read` 的那些目录，枚举时逐个 walk。
 * 加一个根 = 改 `talemate.json` 的 `roots`（或默认表），本文件与工具层都不需要改。
 *
 * 路径口径：项目相对（`design/brief.md` / `chapters/chapter_ch1_v1.md`），与 `FileOp.path`、
 * 与权限 pattern 同一套，全仓只此一种。
 *
 * 边界：零领域知识——不认识层、角色卡、小节，"目录里那一行该写什么"是策略，在
 * `framework/summaries.ts` 的注册表里。只读，没有任何写口：改文件一律走 `framework/write_ops.ts`。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectCorpusRoots, corpusRootAbs, type CorpusRoot } from "../core/config";
import { searchableCorpusRoots } from "../core/roots";
import { findInContent } from "../framework/markdown";
import { safeReadPath } from "./util";

export interface DocHit {
  /** 项目相对路径 */
  path: string;
  heading?: string;
  line: number;
  text: string;
}

function absRoot(projectId: string, spec: CorpusRoot): string {
  return corpusRootAbs(projectId, spec.id);
}

/**
 * 项目相对路径 → `{spec, sub}`。没有命中任何根、或剩余部分穿出根（`..`、绝对路径、空段）→ `undefined`。
 *
 * 多个根的 dir 互为前缀时取**最长的 dir**（如 `notes` 与 `notes/extra` 同时登记，后者更具体）。
 *
 * 用 `safeReadPath` 而不是 `safeRelPath`：后者的字符类管的是"工具许建什么名字"，拿它来管
 * "读得回什么"会让枚举与读回不一致——枚举走真实目录什么都看得见，读回却被字符类挡掉。读侧只该挡穿越。
 */
function splitRoot(projectId: string, rel: string, roots: readonly CorpusRoot[]): { spec: CorpusRoot; sub: string } | undefined {
  const clean = rel.replace(/\\/g, "/");
  let best: { spec: CorpusRoot; sub: string } | undefined;
  for (const spec of roots) {
    if (clean !== spec.dir && !clean.startsWith(`${spec.dir}/`)) continue;
    const sub = clean === spec.dir ? "" : clean.slice(spec.dir.length + 1);
    const safe = sub === "" ? "" : safeReadPath(sub);
    if (safe === undefined) continue;
    if (best === undefined || spec.dir.length > best.spec.dir.length) best = { spec, sub: safe };
  }
  return best;
}

/**
 * 递归收 `.md`，返回项目相对路径（已排序）。
 *
 * 不按文件名过滤：写入口已经用 `util.safeRelPath` 把每一段限在同一个字符类里，工具能创建的文件
 * 本来就都过得去；字符类唯一拦得住的是手放进去的文件——而那正是最该被搜到的一类。
 *
 * `prefix` 是项目相对前缀（`"design/"`）；不传 = 整个项目。
 */
export async function enumerateDocs(projectId: string, prefix?: string): Promise<string[]> {
  const out: string[] = [];
  for (const spec of searchableCorpusRoots(projectCorpusRoots(projectId))) {
    await walkDocs(absRoot(projectId, spec), spec.dir, out);
  }
  out.sort();
  return prefix === undefined ? out : out.filter((p) => p.startsWith(prefix));
}

async function walkDocs(dir: string, prefix: string, acc: string[]): Promise<void> {
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true }).then((ds) =>
      ds.map((d) => ({ name: d.name, isDir: d.isDirectory() })),
    );
  } catch {
    return; // 目录不存在（懒建还没产出）→ 空
  }
  for (const e of entries) {
    const rel = `${prefix}/${e.name}`;
    if (e.isDir) await walkDocs(join(dir, e.name), rel, acc);
    else if (e.name.endsWith(".md")) acc.push(rel);
  }
}

/** 项目相对路径 → 绝对路径（文件）。没有命中任何根、或路径穿出根 → `undefined`。 */
export function docAbs(projectId: string, rel: string): string | undefined {
  const target = splitRoot(projectId, rel, projectCorpusRoots(projectId));
  if (target === undefined || target.sub === "") return undefined;
  return join(absRoot(projectId, target.spec), target.sub);
}

/** 项目相对路径 → 绝对路径（目录也可：根本身、或根之下的子目录）。给 `docStat` 与范围校验用。 */
export function dirAbs(projectId: string, rel: string): string | undefined {
  const clean = rel.replace(/\\/g, "/");
  if (clean === "") return undefined;
  const target = splitRoot(projectId, clean, projectCorpusRoots(projectId));
  if (target === undefined) return undefined;
  return target.sub === "" ? absRoot(projectId, target.spec) : join(absRoot(projectId, target.spec), target.sub);
}

/** 读一份文档；不存在或路径不合法 → `undefined`。 */
export async function readDoc(projectId: string, rel: string): Promise<string | undefined> {
  const abs = docAbs(projectId, rel);
  if (abs === undefined) return undefined;
  try {
    return await readFile(abs, "utf-8");
  } catch {
    return undefined;
  }
}

/** 项目相对路径是文件、目录还是不存在（只认根表里的路径）。给 glob/grep 的范围校验用。 */
export async function docStat(projectId: string, rel: string): Promise<"file" | "dir" | undefined> {
  const abs = dirAbs(projectId, rel);
  if (abs === undefined) return undefined;
  try {
    const info = await stat(abs);
    return info.isDirectory() ? "dir" : info.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** 跨文档扫词，返回扁平命中表（每文件内按行序）。`prefix` 同 `enumerateDocs`。 */
export async function scanDocs(projectId: string, term: string, prefix?: string): Promise<DocHit[]> {
  const q = term.trim();
  if (!q) return [];
  const hits: DocHit[] = [];
  for (const rel of await enumerateDocs(projectId, prefix)) {
    const abs = docAbs(projectId, rel);
    if (abs === undefined) continue;
    let content: string;
    try {
      content = await readFile(abs, "utf-8");
    } catch {
      continue;
    }
    for (const h of findInContent(content, q)) {
      hits.push({ path: rel, heading: h.heading, line: h.line, text: h.text });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}