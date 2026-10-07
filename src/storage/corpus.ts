/**
 * 语料层：项目里 `.md` 文档的唯一取数入口——枚举 / 读 / 扫词。
 *
 * 判据只能有一份："什么算一份文档"若分给 `storage/project.ts`（收所有 `.md`）与
 * `framework/search.ts`（多一道 `NAME_RE` 过滤）各判一次，迟早不一致；所以全归这里。
 *
 * 路径口径：项目相对（`design/core.md` / `chapters/chapter_ch1_v1.md`），与 `FileOp.path`、
 * 与权限 pattern 同一套，全仓只此一种。
 *
 * 边界：零领域知识——不认识层、角色卡、小节，"目录里那一行该写什么"是策略，在
 * `framework/summaries.ts` 的注册表里。只读，没有任何写口：改文件一律走 `framework/write_ops.ts`。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DOC_ROOTS, rootAbs, type DocRoot } from "../core/config";
import { findInContent } from "../framework/markdown";
import { safeReadPath } from "./util";

/**
 * 三个根（design / chapters / state）。清单不在这里——它住在 `core/config.ts`，与写口 `write_ops`
 * 共用同一份（读得到的必须写得着，反之亦然）。这里只是把它转出来，让"读口的根"有个可引用的名字。
 */
export { DOC_ROOTS };
export type { DocRoot };

export interface DocHit {
  /** 项目相对路径 */
  path: string;
  heading?: string;
  line: number;
  text: string;
}

function absRoot(projectId: string, root: DocRoot): string {
  return rootAbs(projectId, root);
}

/**
 * 项目相对路径 → `{root, sub}`。根不在 `DOC_ROOTS` 里、或剩余部分穿出根（`..`、绝对路径、
 * 空段）→ `undefined`。
 *
 * 用 `safeReadPath` 而不是 `safeRelPath`：后者的字符类管的是"工具许建什么名字"，拿它来管
 * "读得回什么"会让枚举与读回不一致——枚举走真实目录什么都看得见，读回却被字符类挡掉。读侧只该挡穿越。
 *
 * 残留的不对称（已知、待决）：手放的名字读得着、却写不动——`write_ops.resolveTarget` 仍过
 * `safeRelPath`。要不要放开写侧的字符类（好让译名里的 `·` 建得出来）是另一个决定，牵到
 * `invariants` 的路径 glob 与 `nameFromPath`，没搭这次的车。
 */
function splitRoot(rel: string): { root: DocRoot; sub: string } | undefined {
  const clean = rel.replace(/\\/g, "/");
  const root = DOC_ROOTS.find((r) => clean.startsWith(`${r}/`));
  if (!root) return undefined;
  const sub = safeReadPath(clean.slice(root.length + 1));
  return sub ? { root, sub } : undefined;
}

/**
 * 递归收 `.md`，返回项目相对路径（已排序）。
 *
 * 不按文件名过滤：写入口已经用 `util.safeRelPath` 把每一段限在同一个字符类里，工具能创建的文件
 * 本来就都过得去；字符类唯一拦得住的是手放进去的文件——而那正是最该被搜到的一类。
 * 原子写的临时文件以 `.tmp` 结尾（见 `atomic.ts`），`.md` 这一道就把它挡住了，不需要第二道。
 *
 * `prefix` 是项目相对前缀（`"design/"`）；不传 = 整个项目。
 */
export async function enumerateDocs(projectId: string, prefix?: string): Promise<string[]> {
  const out: string[] = [];
  for (const root of DOC_ROOTS) await walkDocs(absRoot(projectId, root), root, out);
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

/**
 * 项目相对路径 → 绝对路径。根不在 `DOC_ROOTS` 之下、或路径穿出根（`..`、绝对路径、空段）
 * → `undefined`。
 *
 * 导出是因为 `storage/project` 的测试夹具（`writeDoc` / `removeDoc`）也要按同一个口径落盘——
 * "项目相对路径怎么变成绝对路径"只该有一处实现，否则夹具与读口迟早各走各的。
 */
export function docAbs(projectId: string, rel: string): string | undefined {
  const t = splitRoot(rel);
  return t ? join(absRoot(projectId, t.root), t.sub) : undefined;
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
