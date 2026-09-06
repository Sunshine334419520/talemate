/**
 * searchDocs：跨 docs/(+chapters/) 扫词，返回 "文件 → 小节 + 行 snippet" 命中。
 * 供 editor 改/删前查影响面（remove-doc-section 用它做强制引用检查）。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths, talemateHome } from "../core/config";
import { findInContent } from "./markdown";
import { DOC_FILES } from "./dockind";

const NAME_RE = /^[\w一-鿿.\-]+$/;

export interface Hit {
  file: string;
  heading?: string;
  line: number;
  text: string;
}

/** 在单个 .md 文件里扫词；返回命中的行（含所在小节）。读不到 → []。 */
async function scanFile(file: string, dir: string, query: string): Promise<Hit[]> {
  let content: string;
  try {
    content = await readFile(join(dir, file), "utf-8");
  } catch {
    return [];
  }
  return findInContent(content, query).map((h) => ({ file, heading: h.heading, line: h.line, text: h.text }));
}

/** 列出某个子目录（docs 或 chapters）下所有 .md 文件名。 */
async function listMd(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * 跨文档搜 query。scope: "docs" | "all"（docs + chapters，默认 docs）。
 * 返回扁平命中表；每个文件内按行序。
 */
export async function searchDocs(
  projectId: string,
  query: string,
  scope: "docs" | "all" = "docs",
): Promise<Hit[]> {
  const q = query.trim();
  if (!q) return [];
  const pp = projectPaths(talemateHome(), projectId);
  const out: Hit[] = [];

  const docs = await listMd(pp.docs);
  const docFiles = docs.length ? docs : DOC_FILES;
  for (const f of docFiles) {
    // 安全文件名（防目录穿越）
    if (!NAME_RE.test(f)) continue;
    out.push(...(await scanFile(f, pp.docs, q)));
  }
  if (scope === "all") {
    const chapters = await listMd(pp.chapters);
    for (const f of chapters) {
      if (!NAME_RE.test(f)) continue;
      out.push(...(await scanFile(f, pp.chapters, q)));
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** 把命中渲染成给模型看的文本（分组 + 小节）。 */
export function renderHits(hits: Hit[], query: string): string {
  if (!hits.length) return `「${query}」在文档里没有命中。`;
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  const lines: string[] = [`「${query}」命中 ${hits.length} 处：`];
  for (const [file, list] of byFile) {
    lines.push(`${file}`);
    for (const h of list) {
      lines.push(`  ${h.line}${h.heading ? ` (${h.heading})` : ""}: ${h.text}`);
    }
  }
  return lines.join("\n");
}
