/**
 * 常驻设定注入 + 文档索引。路径一律项目相对（`design/core.md`），与工具收的路径、`FileOp.path`、
 * 权限 pattern 同一个口径。
 *
 * 常驻集只有 design/core.md 与 design/wiki/world.md：每轮现读全文注入 mate、不带状态包装；
 * wiki 专题页与 characters/outline 按需读，写作进度/伏笔/待定这类状态信息归状态层不归这里。
 *
 * 索引这一侧只做分组、缩进、铺小节标题这类通用的事——"某种文档在目录里长什么样"是策略，
 * 住在 `framework/summaries.ts` 的注册表里。
 */
import { DOC_ROOTS, enumerateDocs, readDoc } from "../storage/corpus";
import { listHeadings } from "./markdown";
import { summarize } from "./summaries";

export const RESIDENT_DOCS = ["design/core.md", "design/wiki/world.md"] as const;

/**
 * 已删掉的派生总表（角色卡副本，会脱节），老项目里可能还留着。
 *
 * 这是遗留兼容不是策略，所以留在这里而不进 `summaries` 注册表：它本不该被当成文档，但
 * `design/characters/*.md` 那条摘要器规则会把它当成"一份不分格的文档"混进名单。
 */
const LEGACY_SKIP = new Set(["design/characters/_index.md"]);

/** 目录里小节的缩进：有组名时多一层。 */
const INDENT = (n: number): string => "  ".repeat(n + 1);

/**
 * 文档树的一个节点。`path` 可以没有：像"角色""正文"这种分组节点本身不是文档（只是那一段的
 * 名字）；而"世界观"这类既分组又有一份总纲的节点两个都有，界面点名字开文档、点箭头展开。
 */
export interface DocNode {
  name: string;
  path?: string;
  children?: DocNode[];
}

/**
 * 左栏那棵树的六段，次序固定——就是 `mate` 对用户说话用的那六个词（见 `mate.system.txt`）。
 * 目录名（`design/` `chapters/` `state/`）一个都不出现：它们是实现，不是这本书的样子。
 */
const SECTIONS = ["核心设定", "世界观", "角色", "大纲", "正文", "现状"] as const;

/** 认不出的东西归这一段：加了一类文档忘了配名字，也得看得见，不能丢。 */
const OTHER = "其他";

const base = (path: string): string => path.split("/").pop()?.replace(/\.md$/, "") ?? path;

/**
 * 一份文档对外叫什么、归在哪一段。这是显示名的唯一一处，CLI 那边要对齐也引它——同一份文档在
 * 两个界面里有两个名字，是这类映射最典型的烂法。
 *
 * 它只认作品那三个根下的已知形状；`.talemate/` 下的东西到不了这里（`enumerateDocs` 不认它）。
 */
function displayOf(path: string): { section: string; parts: string[] } {
  if (path === "design/core.md") return { section: "核心设定", parts: [] };
  if (path === "design/wiki/world.md") return { section: "世界观", parts: [] };
  if (path.startsWith("design/wiki/")) return { section: "世界观", parts: [base(path)] };
  if (path.startsWith("design/characters/")) return { section: "角色", parts: [base(path)] };
  if (path.startsWith("design/outline/")) {
    const seq = /^design\/outline\/vol_(\d+)\/s(\d+)\.md$/.exec(path);
    if (seq) return { section: "大纲", parts: [`第 ${seq[1]} 卷`, `序列 ${seq[2]}`] };
    const vol = /^design\/outline\/vol_(\d+)\.md$/.exec(path);
    if (vol) return { section: "大纲", parts: [`第 ${vol[1]} 卷`] };
    return { section: "大纲", parts: [base(path)] };
  }
  if (path.startsWith("chapters/")) {
    const ch = /^chapters\/chapter_ch(\d+)_v(\d+)\.md$/.exec(path);
    if (ch) {
      // 稿号只在多于一稿时才报——第一稿是常态，每一条都挂个「第 1 稿」是噪音
      const label = Number(ch[2]) > 1 ? `第 ${ch[1]} 章（第 ${ch[2]} 稿）` : `第 ${ch[1]} 章`;
      return { section: "正文", parts: [label] };
    }
    return { section: "正文", parts: [base(path)] };
  }
  if (path.startsWith("state/characters/")) return { section: "现状", parts: [base(path)] };
  if (path === "state/foreshadowing.md") return { section: "现状", parts: ["伏笔账"] };
  if (path === "state/progress.md") return { section: "现状", parts: ["章节流水"] };
  return { section: OTHER, parts: [path] };
}

/**
 * 平铺的项目相对路径 → 界面左栏那棵树（`buildIndex` 是它在文本上的同族）。
 *
 * 判据只在这里：归哪一段；同段之内目录在前、其余按 `numeric` 比较——`第 2 卷` 要排在
 * `第 10 卷` 前面，字典序正好反过来。
 */
export function docTree(paths: string[]): DocNode[] {
  const children = new Map<string, DocNode[]>();
  const self = new Map<string, string>(); // 那一段自己的总纲文档（核心设定、世界观总纲）

  for (const path of paths) {
    const { section, parts } = displayOf(path);
    if (!children.has(section)) children.set(section, []);
    if (parts.length === 0) {
      self.set(section, path);
      continue;
    }
    let level = children.get(section) as DocNode[];
    parts.forEach((label, i) => {
      const leaf = i === parts.length - 1;
      let node = level.find((n) => n.name === label && (leaf ? n.children === undefined : n.children !== undefined));
      if (node === undefined) {
        node = leaf ? { name: label, path } : { name: label, children: [] };
        level.push(node);
      }
      if (!leaf) level = node.children as DocNode[];
    });
  }

  const rank = (name: string): number => {
    const at = (SECTIONS as readonly string[]).indexOf(name);
    return at >= 0 ? at : SECTIONS.length;
  };
  const sort = (nodes: DocNode[]): void => {
    nodes.sort((a, b) => {
      const aDir = a.children !== undefined;
      const bDir = b.children !== undefined;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh", { numeric: true });
    });
    for (const n of nodes) if (n.children) sort(n.children);
  };

  const names = [...children.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "zh"));
  for (const name of names) sort(children.get(name) as DocNode[]);

  return names.map((name): DocNode => {
    const kids = children.get(name) as DocNode[];
    const own = self.get(name);
    if (kids.length === 0 && own !== undefined) return { name, path: own }; // 只有总纲：那一段就是个叶子
    return { name, path: own, children: kids };
  });
}

/**
 * 生成某一段语料的目录（CLI 的 `/status` 与 `list` 复用）。`prefix` 是要索引的那一段，
 * 组名与缩进按前缀之下的相对路径算——按项目相对路径的第一段分组会把所有文档塞进同一个组。
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
  // 已知目录按固定次序（根在最前），其余一律附在后面——否则枚举得到、却不显示的新目录会被
  // 静默丢掉。列整个项目时分组就是那三个根（顺序同 `DOC_ROOTS`），后四个是 `design/` 之内的
  // 分组，给 `prefix = "design/"` 用。
  const KNOWN = ["design", "chapters", "state", "", "wiki", "characters", "outline"];
  const rest = [...groups.keys()].filter((g) => !KNOWN.includes(g)).sort();
  const order = [...KNOWN.filter((g) => groups.has(g)), ...rest];
  for (const g of order) {
    if (g) lines.push(`  ${g}/`);
    for (const f of groups.get(g)!) {
      if (LEGACY_SKIP.has(f)) continue;
      const content = await readDoc(projectId, f);
      const fileIndent = INDENT(g ? 1 : 0);
      const headIndent = INDENT(g ? 2 : 1);
      // 组名已单独占一行，行内不再重复前缀——否则三层路径（outline/vol_1/s1.md）会吃掉半行。
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

/** core + world 总纲的常驻全文，mate 每轮注入；文件不存在（懒建未产出）则跳过。 */
export async function buildResidentDesigns(projectId: string): Promise<string> {
  const blocks: string[] = [];
  for (const path of RESIDENT_DOCS) {
    const content = await readDoc(projectId, path);
    if (content === undefined) continue;
    blocks.push(`【常驻设定 · ${path}】（每轮注入，写作不得违背）\n${content}`);
  }
  return blocks.join("\n\n");
}
