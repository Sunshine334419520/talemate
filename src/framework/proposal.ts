/**
 * 提案渲染：把模型提交的草稿变成用户能逐格审阅、用"第 N 格"回话的展示文本。
 *
 * 不变量：**这里不认识任何一层**——签名里没有层，标签与格名全部来自数据
 * （DESIGN_SPECS 的小节，或正文自己的标题）。为某一层写渲染分支就是设计错了。
 *
 * 分工：逐格清单与收尾契约由这里出；模型的前言（这一版为什么这么定）在调用之前说。
 * 离散的创作抉择走 ask-user，不走这里。
 */
import type { DesignSpec } from "./design_spec";
import { DESIGN_SPECS } from "./design_spec";
import { LAYERS } from "./layers";
import { getSection, listHeadings } from "./markdown";
import { isFiller } from "./report";

const INDENT = "   ";

/** 正文按行缩进（与 confirm 摘要同一套 3 空格约定）。不截断——用户必须看到要落的全部字节。 */
function indentLines(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .map((l) => `${INDENT}${l}`);
}

export interface ProposalItem {
  heading: string;
  body: string;
}

/**
 * 这一篇有没有结构规范。规范按**文件**登记（core.md / wiki/world.md / outline/outline.md）——
 * 精确匹配，不做目录/前缀推断：`characters` 的 file 是目录 `characters/`，永远匹配不上，
 * 于是角色卡、`wiki/<题>.md` 专题页、`plan_ch<N>.md` 细纲自动落到 itemsOf 的兜底分支。
 */
export function specFor(name: string): DesignSpec | undefined {
  return Object.values(DESIGN_SPECS).find((s) => s.file === name);
}

/**
 * 正文自己的格：取**最浅一层**的标题。
 * 不钉死 `##`——角色卡是 `# 角色：X` + 5 个 `###` 字段，钉死 `##` 会一格都取不到。
 */
function ownItems(content: string): ProposalItem[] {
  const heads = listHeadings(content, 2);
  if (!heads.length) return [];
  const top = Math.min(...heads.map((h) => h.level));
  return heads
    .filter((h) => h.level === top)
    .map((h) => ({ heading: h.title, body: getSection(content, h.title, 2).body ?? "" }));
}

/**
 * 取"这一篇该按哪几格看"。**一个函数、两个数据源，没有第三条路**：
 *   有规范 → 规范的小节（顺序稳定，与模型看到的 design-spec 编号一致）
 *   没规范 → 正文自己的标题（`ownItems`）
 *
 * 规范之外的小节**也一并列出**（排在规范格之后）：凡是要落盘的字节，用户必须看得到——
 * 否则"多写了一个不在规范里的小节"会隐形落盘，正好是这次要治的病。
 */
export function itemsOf(name: string, content: string): ProposalItem[] {
  const spec = specFor(name);
  const own = ownItems(content);
  if (!spec) return own;
  const items = spec.sections.map((s) => ({ heading: s.heading, body: getSection(content, s.heading).body ?? "" }));
  const known = new Set(items.map((i) => i.heading));
  return [...items, ...own.filter((o) => !known.has(o.heading))];
}

/**
 * 这份草稿能不能逐格审阅。不能 = 用户会看到一页「待定」却照样落盘——最难发现的那类坑：
 *   - 正文里一个标题都没有（渲染出 0 格）
 *   - 有规范，但内容没按规范的小节组织（几格全显示"待定"，而正文其实是整段散文，会原样落盘）
 */
export function reviewable(name: string, content: string): boolean {
  if (!ownItems(content).length) return false;
  const spec = specFor(name);
  if (!spec) return true;
  return spec.sections.some((s) => !isBlankBody(getSection(content, s.heading).body ?? ""));
}

/** 展示用标签：有规范 → 层名；没有 → 文档自己的 H1 标题。**都不出现文件路径。** */
export function labelOf(name: string, content: string): string {
  const spec = specFor(name);
  if (spec) return LAYERS.find((l) => l.id === spec.id)?.title ?? spec.title;
  return listHeadings(content, 1)[0]?.title || "草稿";
}

/** 这一格是不是还没填（空 / 只有（待定…）占位 / 只有引用块引导语）。 */
export function isBlankBody(body: string): boolean {
  return !body.split("\n").some((l) => !isFiller(l));
}

export interface ProposalView {
  /** 目标文档（design/ 下相对路径）——只用于取名/取格，**不进展示文本** */
  name: string;
  /** 将落盘的正文：整篇提案=全文；单格提案=该小节正文（不含标题行） */
  content: string;
  /** 单格提案的小节标题；整篇提案缺省 */
  section?: string;
  /** 单格提案：该格当前正文（用于"旧 N 字 → 新 M 字"） */
  oldBody?: string;
  /** 上一次提案的正文（同文档）；有则标出本版改动过的格，并提示替换了上一版 */
  previous?: string;
}

/**
 * 渲染一份提案（纯函数，无 IO）。输出即用户看到的全部——
 * 头部一行定位、逐格编号、待定格点出来问一句、收尾一行写清楚"怎么回话"。
 */
export function renderProposal(v: ProposalView): string {
  const label = labelOf(v.name, v.content);
  const title = v.section ? `${label} › ${v.section}` : label;
  const out: string[] = [`──── 提案 · ${title} ────`];

  if (v.section) {
    const oldLen = (v.oldBody ?? "").trim().length;
    out.push(`改写这一格（旧 ${oldLen} 字 → 新 ${v.content.trim().length} 字），其余格不动`);
    if (v.previous !== undefined) out.push("这是新的一版，已替换上一版提案。");
    out.push("");
    out.push(...indentLines(v.content));
    out.push("");
    out.push("回复「没问题」就写入；要改直接说。");
    return out.join("\n");
  }

  const items = itemsOf(v.name, v.content);
  const prevItems = v.previous !== undefined ? itemsOf(v.name, v.previous) : undefined;
  const prevBody = (heading: string): string | undefined =>
    prevItems?.find((p) => p.heading === heading)?.body;

  const blanks = items.map((it, i) => (isBlankBody(it.body) ? i + 1 : 0)).filter(Boolean);
  const head = [`整篇草稿 · ${items.length} 格`, blanks.length ? `${blanks.length} 格待定` : undefined]
    .filter(Boolean)
    .join(" · ");
  out.push(head);
  if (v.previous !== undefined) out.push("已替换上一版提案（标★的是本版改动过的格）。");
  out.push("");

  items.forEach((it, i) => {
    const changed = prevBody(it.heading) !== undefined && prevBody(it.heading) !== it.body;
    out.push(`${i + 1}. ${it.heading}${changed ? "　★本版改动" : ""}`);
    if (isBlankBody(it.body)) {
      out.push(`${INDENT}（待定）`);
    } else {
      out.push(...indentLines(it.body));
    }
  });

  if (blanks.length) {
    out.push("");
    out.push(`第 ${blanks.join("、")} 格还没定 —— 先留白，还是现在给我一句？`);
  }
  out.push("");
  out.push(`回复「没问题」就写入${label}；要改直接说第几格。`);
  return out.join("\n");
}
