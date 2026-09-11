/**
 * searchDesigns：跨 design/(+chapters/) 扫词，返回 "文件 → 小节 + 行 snippet" 命中。
 * 供 editor 改/删前查影响面（remove-design-section / remove-character 用它做强制引用检查）。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths, talemateHome } from "../core/config";
import { findInContent } from "./markdown";

const NAME_RE = /^[\w一-鿿.\-]+$/;

export interface Hit {
  file: string; // 相对路径（design/ 下如 wiki/地理.md；chapters/ 下平铺）
  heading?: string;
  line: number;
  text: string;
}

/** 读单个 .md 并扫词；读不到 → []。 */
async function scanFile(abs: string, rel: string, query: string): Promise<Hit[]> {
  let content: string;
  try {
    content = await readFile(abs, "utf-8");
  } catch {
    return [];
  }
  return findInContent(content, query).map((h) => ({ file: rel, heading: h.heading, line: h.line, text: h.text }));
}

/** 递归列一个目录下所有 .md，返回 {abs, rel}（rel = 相对该目录）。 */
async function walk(rootDir: string): Promise<{ abs: string; rel: string }[]> {
  const out: { abs: string; rel: string }[] = [];
  async function rec(dir: string, prefix: string): Promise<void> {
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true }).then((ds) =>
        ds.map((d) => ({ name: d.name, isDir: d.isDirectory() })),
      );
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDir) await rec(join(dir, e.name), rel);
      else if (e.name.endsWith(".md") && NAME_RE.test(e.name)) out.push({ abs: join(dir, e.name), rel });
    }
  }
  await rec(rootDir, "");
  return out;
}

/**
 * 跨文档搜 query。scope: "design" | "all"（design/ + chapters/，默认 design/）。
 * 返回扁平命中表；每个文件内按行序。
 */
export async function searchDesigns(
  projectId: string,
  query: string,
  scope: "design" | "all" = "design",
): Promise<Hit[]> {
  const q = query.trim();
  if (!q) return [];
  const pp = projectPaths(talemateHome(), projectId);
  const out: Hit[] = [];

  for (const f of await walk(pp.design)) out.push(...(await scanFile(f.abs, f.rel, q)));
  if (scope === "all") {
    for (const f of await walk(pp.chapters)) out.push(...(await scanFile(f.abs, f.rel, q)));
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
