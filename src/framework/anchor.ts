/**
 * 常驻设定注入 + 文档索引。
 *
 * 常驻设定：core.md（小说介绍）+ wiki/world.md（世界层总纲）是每轮注入 editor 的固定基线——
 * 现读全文、**不带状态包装**。core/world 专题页（wiki/<题>.md）不常驻，按需 read-design。
 * 状态类信息（写作进度/伏笔/待定）不是静态基线，归 list-chapters 等工具与未来的状态块；
 * characters/outline 仍按需 read-design，索引由 list-designs 给出。
 */
import { readDesign, listDesigns } from "../storage/project";
import { listHeadings } from "./markdown";
import { LAYERS, RESIDENT_DESIGNS } from "./layers";

/** 每个文档的一级小节（list-designs 工具返回；用于一眼看出有哪些材料与填充度）。按目录分组。 */
export async function buildDesignIndex(projectId: string): Promise<string> {
  const files = await listDesigns(projectId);
  const lines: string[] = ["design/"];
  if (!files.length) {
    lines.push("  （空，按需 design-spec 成稿）");
    return lines.join("\n");
  }
  // 按顶层目录分组（wiki / characters / outline；""=根）
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const gi = f.indexOf("/");
    const g = gi >= 0 ? f.slice(0, gi) : "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  const order = ["", "wiki", "characters", "outline"].filter((g) => groups.has(g));
  for (const g of order) {
    if (g) lines.push(`  ${g}/`);
    for (const f of groups.get(g)!) {
      const content = await readDesign(projectId, f);
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
export async function buildResidentDesigns(projectId: string): Promise<string> {
  const blocks: string[] = [];
  for (const name of RESIDENT_DESIGNS) {
    const content = await readDesign(projectId, name);
    if (content === undefined) continue;
    blocks.push(`【常驻设定 · design/${name}】（每轮注入，写作不得违背）\n${content}`);
  }
  return blocks.join("\n\n");
}

export { LAYERS, RESIDENT_DESIGNS };
