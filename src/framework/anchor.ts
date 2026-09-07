/**
 * 常驻设定注入 + 设计段判定 + 文档索引。
 *
 * 常驻设定：core.md（小说介绍）+ wiki/world.md（世界层总纲）是每轮注入 editor 的固定基线——
 * 现读全文、**不带状态包装**。core/world 专题页（wiki/<题>.md）不常驻，按需 read-doc。
 * 状态类信息（写作进度/伏笔/待定）不是静态基线，归 list-chapters 等工具与未来的状态块；
 * characters/outline 仍按需 read-doc，索引由 list-docs 给出。
 */
import { readDoc, listDocs } from "../storage/project";
import { listHeadings } from "./markdown";
import { DOC_KINDS, RESIDENT_DOCS } from "./dockind";

/** 每个文档的一级小节（list-docs 工具返回；用于一眼看出有哪些材料与填充度）。按目录分组。 */
export async function buildDocIndex(projectId: string): Promise<string> {
  const docs = await listDocs(projectId);
  const lines: string[] = ["design/"];
  if (!docs.length) {
    lines.push("  （空，按需 doc-spec 成稿）");
    return lines.join("\n");
  }
  // 按顶层目录分组（wiki / characters / outline；""=根）
  const groups = new Map<string, string[]>();
  for (const f of docs) {
    const gi = f.indexOf("/");
    const g = gi >= 0 ? f.slice(0, gi) : "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  const order = ["", "wiki", "characters", "outline"].filter((g) => groups.has(g));
  for (const g of order) {
    if (g) lines.push(`  ${g}/`);
    for (const f of groups.get(g)!) {
      const content = await readDoc(projectId, f);
      const fileIndent = g ? "    " : "  ";
      const headIndent = g ? "      " : "    ";
      if (content === undefined) {
        lines.push(`${fileIndent}${f}（缺）`);
        continue;
      }
      const heads = listHeadings(content, 2);
      if (!heads.length) {
        lines.push(`${fileIndent}${f}（空/无小节）`);
        continue;
      }
      lines.push(`${fileIndent}${f}:`);
      for (const h of heads) lines.push(`${headIndent}- ${h.title}`);
    }
  }
  return lines.join("\n");
}

/** core + world 总纲常驻设定全文。editor 每轮注入；文件不存在（懒建未产出）则跳过该块。 */
export async function buildResidentDocs(projectId: string): Promise<string> {
  const blocks: string[] = [];
  for (const name of RESIDENT_DOCS) {
    const content = await readDoc(projectId, name);
    if (content === undefined) continue;
    blocks.push(`【常驻设定 · design/${name}】（每轮注入，写作不得违背）\n${content}`);
  }
  return blocks.join("\n\n");
}

/** 设计段判定：设计/outline/outline.md 还是空骨架/仅占位 → 认为处于"框架设计"阶段。 */
export async function designActive(projectId: string): Promise<boolean> {
  const outline = await readDoc(projectId, "outline/outline.md");
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

export { DOC_KINDS, RESIDENT_DOCS };
