/**
 * 常驻设定注入 + 文档索引。
 *
 * 常驻设定：core.md（小说介绍）+ wiki/world.md（世界层总纲）是每轮注入 editor 的固定基线——
 * 现读全文、**不带状态包装**。core/world 专题页（wiki/<题>.md）不常驻，按需 read-design。
 * 状态类信息（写作进度/伏笔/待定）不是静态基线，归 list-chapters 等工具与未来的状态块；
 * characters/outline 仍按需 read-design，索引由 list-designs 给出。
 */
import { readDesign, listDesigns } from "../storage/project";
import { cardIdentity, nameFromPath, pendingRequiredLabels, tailSections } from "./characters";
import { isFiller, listHeadings } from "./markdown";
import { LAYERS, RESIDENT_LAYERS } from "./layers";
import { DESIGN_SPECS } from "./design_spec";
import { specFor } from "./proposal";

/** 「另有」最多列几个自由小节标题——超出截断，免得一行吃掉整个名单。 */
const TAIL_LIMIT = 5;

/**
 * 角色卡在名单里的一行，三段现算：
 *   `身份（必有齐）` / `身份（待补：底线 · 绝不做）`，有自由长尾时再缀「另有：回响、能力 · 机制」。
 *
 * 「另有」是 2026-09-19 加的。从前每张卡都铺同样的 12 个固定小节，列出来是纯噪音，
 * 所以那时的规矩是"不铺小节标题"。现在长尾**每张卡都不同**——它才是信号：
 * 不把卡读进上下文，也能看出"这张卡上除了必有格还有什么"。
 * 目录要廉价，正文才昂贵；这一行是目录那一半。
 */
function characterLine(content: string): string {
  const identity = cardIdentity(content) ?? "（待定）";
  const missing = pendingRequiredLabels(content);
  const status = missing.length ? `待补：${missing.join("、")}` : "必有齐";
  const tail = tailSections(content);
  const extra = tail.length
    ? `；另有：${tail.slice(0, TAIL_LIMIT).join("、")}${tail.length > TAIL_LIMIT ? "…" : ""}`
    : "";
  return `${identity}（${status}${extra}）`;
}

/**
 * 整篇散文文档的"一句话"：全文第一句有效内容（跳过标题行、空行、占位、引用）。
 * 序列纲这类文档没有小节可铺，首句才是它在目录里的信号。
 */
function proseLead(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !isFiller(l));
  if (line === undefined) return "空";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

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
      // 组名已经单独占了一行，行内不再重复这个前缀——情节层是三层路径（outline/vol_1/s1.md），
      // 重复一次就吃掉半行。
      const label = g && f.startsWith(`${g}/`) ? f.slice(g.length + 1) : f;
      // 角色卡一人一行（必有齐没齐 + 自由长尾有哪些），不铺必有格的标题——排章时要看的是
      // "这个人能不能写了、他卡上有什么"。名单**现算**（读卡），不存派生文件：副本会脱节，
      // 曾经那个 _index.md 就漏过。
      const cardName = nameFromPath(f);
      if (cardName) {
        lines.push(`${fileIndent}- ${cardName} · ${content === undefined ? "（缺）" : characterLine(content)}`);
        continue;
      }
      if (f === "characters/_index.md") continue; // 2026-09-18 删掉的派生总表；老项目里可能还留着，不再呈现
      if (content === undefined) {
        lines.push(`${fileIndent}${label}（缺）`);
        continue;
      }
      // 规范说"这份文档不分格"（sections 为空，如序列纲）→ 目录也只给一行：它的**首句**才是信号，
      // 小节标题不是。与角色卡一人一行同一个道理——目录要廉价，正文才昂贵。
      const spec = specFor(f);
      if (spec !== undefined && spec.sections.length === 0) {
        lines.push(`${fileIndent}${label}（${proseLead(content)}）`);
        continue;
      }
      const heads = listHeadings(content, 2);
      if (!heads.length) {
        lines.push(`${fileIndent}${label}（空/无小节）`);
        continue;
      }
      lines.push(`${fileIndent}${label}:`);
      for (const h of heads) lines.push(`${headIndent}- ${h.title}`);
    }
  }
  return lines.join("\n");
}

/** core + world 总纲常驻设定全文。editor 每轮注入；文件不存在（懒建未产出）则跳过该块。 */
export async function buildResidentDesigns(projectId: string): Promise<string> {
  const blocks: string[] = [];
  // 常驻表标的是**层**，路径从 DESIGN_SPECS 现取——层改了路径，常驻注入自动跟着改。
  for (const id of RESIDENT_LAYERS) {
    const name = DESIGN_SPECS[id].file;
    const content = await readDesign(projectId, name);
    if (content === undefined) continue;
    blocks.push(`【常驻设定 · design/${name}】（每轮注入，写作不得违背）\n${content}`);
  }
  return blocks.join("\n\n");
}

export { LAYERS, RESIDENT_LAYERS };
