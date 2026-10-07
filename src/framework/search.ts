/**
 * 扫词命中的渲染：把 `corpus.scanDocs` 的扁平命中表变成给模型看的文本（按文件分组 + 小节标注）。
 * 取数在 `storage/corpus.ts`，本文件只剩渲染。
 */
import type { DocHit } from "../storage/corpus";

/** 把命中渲染成给模型看的文本（分组 + 小节）。路径按项目相对原样给出——工具收的就是这个口径。 */
export function renderHits(hits: DocHit[], query: string): string {
  if (!hits.length) return `「${query}」在文档里没有命中。`;
  const byFile = new Map<string, DocHit[]>();
  for (const h of hits) {
    const list = byFile.get(h.path) ?? [];
    list.push(h);
    byFile.set(h.path, list);
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
