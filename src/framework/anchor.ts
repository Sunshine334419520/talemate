/**
 * 常驻设定注入 + 文档索引。
 *
 * 常驻设定：design/core.md（小说介绍）+ design/wiki/world.md（世界层总纲）是每轮注入 mate 的固定基线——
 * 现读全文、**不带状态包装**。core/world 专题页（design/wiki/<题>.md）不常驻，按需读。
 * 状态类信息（写作进度/伏笔/待定）不是静态基线，归状态块与未来的状态层；
 * characters/outline 仍按需读，索引由 `list` 给出。
 *
 * 索引这一侧只做**通用**的事：分组、缩进、铺小节标题。**"某种文档在目录里长什么样"是策略**，
 * 在 `framework/summaries.ts` 的注册表里——从前那串 if 就长在本文件，于是取数的一侧知道了一份领域。
 *
 * 路径一律**项目相对**（`design/core.md`）——与工具收的路径、`FileOp.path`、权限 pattern 同一个口径。
 */
import { enumerateDocs, readDoc } from "../storage/corpus";
import { listHeadings } from "./markdown";
import { summarize } from "./summaries";

/**
 * 常驻注入 mate 的文档：小说介绍 + 世界层总纲。
 *
 * **就是两条路径**，不再经过"层 id → 规范表里的 file"那一跳——常驻集本来就只有两个文件，
 * 那层间接没有任何东西需要它。
 */
export const RESIDENT_DOCS = ["design/core.md", "design/wiki/world.md"] as const;

/**
 * 2026-09-18 删掉的派生总表（卡的副本，会脱节）。老项目里可能还留着。
 *
 * 这是**遗留兼容**，不是策略，所以它留在这一侧而不是进 `summaries` 的注册表：它不是"另一种文档形状"，
 * 而是一份不该被当成文档的文件——`nameFromPath` 已经不认它（`_index`），但不拦的话它会被
 * `design/characters/*.md` 那条摘要器规则当成"一份不分格的文档"混进名单里。
 */
const LEGACY_SKIP = new Set(["design/characters/_index.md"]);

/** 目录里小节的缩进：有组名时多一层。 */
const INDENT = (n: number): string => "  ".repeat(n + 1);

/**
 * 生成某一段语料的目录（给 CLI 的 `/status` 与 `list` 复用）。
 *
 * `prefix` 是要索引的那一段（默认整个 `design/`）；组名与缩进都按**前缀之下**的相对路径算——
 * 项目相对路径的第一段永远是根，拿它分组会把所有文档塞进同一个组。
 */
export async function buildIndex(projectId: string, prefix = "design/"): Promise<string> {
  const files = await enumerateDocs(projectId, prefix);
  // 根行：给了前缀就写那个前缀；不给（列整个项目）写一句话——空字符串会留下一行空白。
  const lines: string[] = [prefix === "" ? "（整个项目）" : prefix];
  if (!files.length) {
    lines.push("  （空，按需 design-spec 成稿）");
    return lines.join("\n");
  }
  // 分组键 = 前缀之下第一段目录（wiki / characters / outline；""=根）
  const groups = new Map<string, string[]>();
  const relOf = new Map<string, string>();
  for (const f of files) {
    const rel = f.slice(prefix.length);
    relOf.set(f, rel);
    const gi = rel.indexOf("/");
    const g = gi >= 0 ? rel.slice(0, gi) : "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  // 已知目录按固定次序（根在最前），**其余一律附在后面**——从前这里只列那四个名字，
  // 于是枚举得到、却一个字的目录都不显示：`design/state/` 这类新目录会被静默丢掉。
  // 列整个项目时（`prefix = ""`）分组就是 design / chapters，正是靠这一条才显示得出来。
  const KNOWN = ["", "wiki", "characters", "outline"];
  const rest = [...groups.keys()].filter((g) => !KNOWN.includes(g)).sort();
  const order = [...KNOWN.filter((g) => groups.has(g)), ...rest];
  for (const g of order) {
    if (g) lines.push(`  ${g}/`);
    for (const f of groups.get(g)!) {
      if (LEGACY_SKIP.has(f)) continue;
      const content = await readDoc(projectId, f);
      const fileIndent = INDENT(g ? 1 : 0);
      const headIndent = INDENT(g ? 2 : 1);
      // 组名已经单独占了一行，行内不再重复这个前缀——情节层是三层路径（outline/vol_1/s1.md），
      // 重复一次就吃掉半行。
      const rel = relOf.get(f) ?? f;
      const label = g ? rel.slice(g.length + 1) : rel;

      // ① 这个形状自己有一行（角色卡：一人一行，不铺必有格）→ 就用它，不再铺小节
      const one = summarize({ path: f, label, content });
      if (one !== undefined) {
        lines.push(`${fileIndent}${one}`);
        continue;
      }
      // ② 没有一行可言 → 铺它的小节标题。读不到内容就写「缺」，别静默跳过
      if (content === undefined) {
        lines.push(`${fileIndent}${label}（缺）`);
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

/** core + world 总纲常驻设定全文。mate 每轮注入；文件不存在（懒建未产出）则跳过该块。 */
export async function buildResidentDesigns(projectId: string): Promise<string> {
  const blocks: string[] = [];
  for (const path of RESIDENT_DOCS) {
    const content = await readDoc(projectId, path);
    if (content === undefined) continue;
    blocks.push(`【常驻设定 · ${path}】（每轮注入，写作不得违背）\n${content}`);
  }
  return blocks.join("\n\n");
}
