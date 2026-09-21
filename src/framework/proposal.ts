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
import { DESIGN_SPECS, DOC_SPECS } from "./design_spec";
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
 * 这一篇有没有结构规范。**两个匹配键，先精确、后模式**：
 *
 *   层的规范（`DESIGN_SPECS`）按**文件名精确**匹配（core.md / wiki/world.md），不做目录/前缀
 *   推断——`characters` 与 `outline` 的 file 是目录（以 "/" 结尾），永远匹配不上，于是角色卡、
 *   `wiki/<题>.md` 专题页、`plan_ch<N>.md` 细纲自动落到 `itemsOf` 的兜底分支。
 *   文档的规范（`DOC_SPECS`）按**路径模式**匹配（卷纲 / 序列纲）——同一个层下有几种文档时，
 *   只有模式分得开它们。
 */
export function specFor(name: string): DesignSpec | undefined {
  return Object.values(DESIGN_SPECS).find((s) => s.file === name) ?? DOC_SPECS.find((d) => d.match.test(name));
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

/** 整篇没有 level ≥ 2 标题时，那一格的格名。 */
const WHOLE_DOC_HEADING = "全文";

/**
 * 一份草稿里**没有落进任何格**的字节——它们照样写进文件，所以照样得摆给用户看。
 *
 * 典型是文档标题行和 `##` 之前的导语。但不能简单写成"首个 `##` 之前那一段"：markdown 的区块
 * 语义是"到下一个 level ≤ 它的 heading 之前"（见 `markdown.ts`），所以正文中间冒出一个 `#`
 * 时，被漏掉的是它自己以及它之后到下一个 `##` 之间的内容——根本不在开头。按"被覆盖的行取补集"
 * 算，两种情况一起覆盖住。
 */
function uncoveredText(content: string): string {
  const lines = content.split("\n");
  const covered = lines.map(() => false);
  for (const h of listHeadings(content, 2)) {
    for (let i = h.line; i < h.end; i++) covered[i] = true;
  }
  return lines
    .filter((_, i) => !covered[i])
    .join("\n")
    .trim();
}

/** 审阅视图：格 + 不在格里的字节。**两者合起来 == 会落盘的全部内容**。 */
interface Review {
  items: ProposalItem[];
  /** 不在任何格里的部分；整篇没有格时为空——那时整篇就是那一格 */
  loose: string;
}

/**
 * 取这一篇的审阅视图。
 *
 * **有格**：按 `itemsOf` 分格，另把不在格里的字节单独捞出来（`uncoveredText`）。从前渲染只认
 * `items[].body`，这些字节被整个跳过——于是"用户看过的字节 == 落盘的字节"在三个主层上是假的：
 * 模型成稿时随手加的 `# 标题` 和导语会隐形落盘。
 *
 * **无格**：整篇兜底成"全文"那一格。序列纲这类文档整篇散文就是正当形状，硬逼它分格是削足适履；
 * 有了兜底，拒绝它的理由（"会渲染成 0 格"）也就没了。两种文档走得到这里：**无规范登记的**
 * （`wiki/<题>.md`）与**规范说"不分格"的**（`sections` 为空的序列纲、角色卡）——后者的
 * `itemsOf` 落到 `ownItems`，整篇散文时同样为空。
 */
function reviewOf(name: string, content: string): Review {
  const items = itemsOf(name, content);
  if (items.length) return { items, loose: uncoveredText(content) };
  return { items: [{ heading: WHOLE_DOC_HEADING, body: content.trim() }], loose: "" };
}

/**
 * 这份草稿能不能审阅。不能 = 用户看到一页空白（或一页全「待定」）却照样落盘——最难发现的那类坑。
 *
 * 判据是"**字节摆得到用户眼前吗**"，不是"分不分格"：
 *   - 有规范登记的层：内容得按规范的小节组织（否则几格全「待定」，整段散文却原样落盘）
 *   - 无规范登记的文档：整篇散文也放行——它会被 `reviewItems` 兜底成"整篇一格"，照样看得见
 */
export function reviewable(name: string, content: string): boolean {
  const spec = specFor(name);
  // 规范**规定了小节**才走这条：至少得有一格真的填了。几格全显示「待定」、而正文原样落盘是最难
  // 发现的那类坑，这种**不放行**。
  // `sections` 为空（角色卡、序列纲）意思是"这份文档不分格"，落到下面那条判据去——少了
  // `spec.sections.length` 这一半，`[].some()` 恒为 false，会把它们一律拒掉。
  if (spec && spec.sections.length) {
    return spec.sections.some((s) => !isBlankBody(getSection(content, s.heading).body ?? ""));
  }
  // 有 level ≥ 2 标题就逐格，整篇没有标题就整篇一格（见 reviewOf）——两种都看得到字节。
  // 唯独整篇都是空行/占位不算：那不是"看得到"，是什么都没得看。
  return ownItems(content).length > 0 || !isBlankBody(content);
}

/**
 * 展示用标签：**层的**规范 → 层名（"核心层"）；**文档的**规范与开放文档 → 文档自己的 H1。
 * 卷纲/序列纲都有自己的 H1（`# 卷 2 · 内城`），比"卷纲"这三个字有信息量。**都不出现文件路径。**
 */
export function labelOf(name: string, content: string): string {
  const spec = specFor(name);
  if (spec?.kind === "layer") return LAYERS.find((l) => l.id === spec.layer)?.title ?? spec.title;
  return listHeadings(content, 1)[0]?.title || spec?.title || "草稿";
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

  const review = reviewOf(v.name, v.content);
  const prevReview = v.previous !== undefined ? reviewOf(v.name, v.previous) : undefined;
  const items = review.items;
  const prevBody = (heading: string): string | undefined =>
    prevReview?.items.find((p) => p.heading === heading)?.body;
  const looseChanged = prevReview !== undefined && prevReview.loose !== review.loose;

  const blanks = items.map((it, i) => (isBlankBody(it.body) ? i + 1 : 0)).filter(Boolean);
  const head = [
    `整篇草稿 · ${items.length} 格`,
    blanks.length ? `${blanks.length} 格待定` : undefined,
    review.loose ? "另有不在小节里的部分" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  out.push(head);
  if (v.previous !== undefined) out.push("已替换上一版提案（标★的是本版改动过的格）。");
  out.push("");
  // 不在格里的字节先摆：它们在文档里的位置也在格之前
  if (review.loose) {
    out.push(`不在任何小节里${looseChanged ? "　★本版改动" : ""}（没有格子，但同样会原样写入）：`);
    out.push(...indentLines(review.loose));
    out.push("");
  }

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

/**
 * 渲染一份**节拍计划**（`propose-plan` 用）。
 *
 * 与 `renderProposal` 的区别：节拍**不落盘**，所以没有逐格编号、没有"第 N 格"、没有待定格——
 * 它批准的是**动作**（去写正文），不是一份文档。用户要么说"没问题"，要么说要改哪儿。
 */
export function renderPlan(chapter: string | undefined, content: string): string {
  const label = chapter?.trim();
  return [
    `──── ${label ? `${label} · ` : ""}节拍 ────`,
    "",
    ...indentLines(content),
    "",
    "回复「没问题」就按这个写正文；要改直接说。",
  ].join("\n");
}
