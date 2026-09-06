/**
 * 常驻设定注入 + 设计段判定 + 文档索引。
 *
 * 常驻设定（06 §8，2026-09-06）：core.md（小说介绍）+ world.md（世界层）是每轮注入 editor
 * 的固定基线——现读全文、**不带状态包装**。原 `<nvl-state>` 块已删除：它名义上是"状态锚点"，
 * 实际却搬运整份文档 + 进度 + 索引（名实不符）。状态类信息（写作进度/伏笔/待定）不是静态基线，
 * 归 list-chapters 等工具与未来的状态块；characters/outline 仍按需 read-doc，索引由 list-docs 给出。
 */
import { readDoc, listDocs } from "../storage/project";
import { listHeadings } from "./markdown";
import { DOC_KINDS } from "./dockind";

/** 每个文档的一级小节（list-docs 工具返回；用于一眼看出有哪些材料与填充度）。 */
export async function buildDocIndex(projectId: string): Promise<string> {
  const docs = await listDocs(projectId);
  const lines: string[] = ["docs/"];
  for (const f of docs) {
    const content = await readDoc(projectId, f);
    if (content === undefined) {
      lines.push(`  ${f}（缺）`);
      continue;
    }
    const heads = listHeadings(content, 2);
    if (!heads.length) {
      lines.push(`  ${f}（空/无小节）`);
      continue;
    }
    lines.push(`  ${f}:`);
    for (const h of heads) lines.push(`    - ${h.title}`);
  }
  if (!docs.length) lines.push("  （空）");
  return lines.join("\n");
}

/**
 * core + world 常驻设定全文。editor 每轮注入；文件不存在（懒建未产出）则跳过该块。
 * 只放设定全文——标题/题材在 env 块，进度/索引交给 list-chapters / list-docs 工具。
 */
export async function buildResidentDocs(projectId: string): Promise<string> {
  const blocks: string[] = [];
  for (const name of ["core.md", "world.md"] as const) {
    const content = await readDoc(projectId, name);
    if (content === undefined) continue;
    blocks.push(`【常驻设定 · docs/${name}】（每轮注入，写作不得违背）\n${content}`);
  }
  return blocks.join("\n\n");
}

/** 设计段判定：outline.md 还是空骨架/仅占位 → 认为处于"框架设计"阶段（editor 注入设计协议）。 */
export async function designActive(projectId: string): Promise<boolean> {
  const outline = await readDoc(projectId, "outline.md");
  if (outline === undefined) return true;
  return isOnlySkeleton(outline);
}

/** 极简骨架判定：去掉 heading / 注释 / 待定占位 / 引用引导后没剩内容。 */
function isOnlySkeleton(content: string): boolean {
  const meaningful = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#") && !l.startsWith("<!--") && !l.startsWith("-->") && !l.startsWith(">"))
    .join(" ")
    .replace(/（待定[^）]*）/g, "")
    .trim();
  return meaningful.length === 0;
}

export { DOC_KINDS };
