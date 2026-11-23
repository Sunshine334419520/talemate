/**
 * 提案渲染：把模型提交的整篇草稿交给用户看——没有逐格编号，审阅单位是全文与 diff。
 *
 * 这里不认识任何一层：标签来自设计指南或文档自己的 H1；为某一层写渲染分支就是设计错了。
 * 局部修改不走这里，走 `edit`（用户看精确 diff）。
 */
import { PLAN_KEY, type FileOp, type PendingProposal, type ProposalDisplay } from "../core/types";
import { guideFor } from "./design_guides";
import { diffLines, renderDiff } from "./diff";
import { listHeadings } from "./markdown";
import { isFiller } from "./report";

const INDENT = "   ";

/**
 * 一份文档提案对应的写盘 op。规划（`PLAN_KEY`）没有目标文件 → `undefined`。
 *
 * `p.name` 就是项目相对路径，与 `FileOp.path`、工具收的路径、权限 pattern 全同一个口径，
 * 所以这里不再补前缀。
 *
 * 落盘那条路只从这里取 op（见 `write_ops.writeFile` 的 `via:"pending"` 分支）：`apply-design`
 * 只收目标不收正文，所以"模型夹带用户没看过的字节"是写不出来、而不是会被检查拦住。
 */
export function proposalOp(p: PendingProposal): FileOp | undefined {
  if (p.name === PLAN_KEY) return undefined;
  return { kind: "write", path: p.name, content: p.content };
}

/**
 * 正文按行缩进（与 confirm 摘要同一套 3 空格约定），不截断——用户必须看到要落的全部字节。
 * `plan.renderPlan` 也用它：缩进约定只该有一处定义。
 */
export function indentLines(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .map((l) => `${INDENT}${l}`);
}

export interface ProposalView {
  /** 目标文档（项目相对路径）——只用于取名/标签，不进展示文本。 */
  name: string;
  /** 将落盘的正文：永远是整篇。 */
  content: string;
  /** 上一次提案的正文；有则展示 diff */
  previous?: string;
}

/**
 * 展示用标签：指南给了短名（核心层/世界层）就用它，否则用文档自己的 H1（`# 卷 2 · 内城`），
 * 再否则用指南的标题/“草稿”。都不出现文件路径。
 */
export function labelOf(name: string, content: string): string {
  const guide = guideFor(name);
  if (guide?.label !== undefined) return guide.label;
  return listHeadings(content, 1)[0]?.title || guide?.title || "草稿";
}

/**
 * 这份草稿能不能交给用户看：判据只有“有字节可看”。不再要求按某个规范分小节——
 * 整篇散文、diff、段落都算；只有空/全占位才拒绝（那才是真的什么都看不到）。
 */
export function reviewable(_name: string, content: string): boolean {
  return content.trim() !== "" && content.split("\n").some((l) => !isFiller(l));
}

function diffText(previous: string, content: string): string {
  return renderDiff(diffLines(previous, content));
}

/**
 * 终端提案视图（纯函数，无 IO）：整篇 + diff，不接受“第 N 格”。
 * 收尾操作不写进正文——界面用按钮，CLI 在提案之后单独打一行提示。
 */
export function renderProposal(v: ProposalView): string {
  const label = labelOf(v.name, v.content);
  const out: string[] = [`──── 提案 · ${label} ────`];
  if (v.previous !== undefined) {
    out.push("与上一版提案的差异（未列出的行保持不变）：");
    out.push(diffText(v.previous, v.content));
    out.push("", "已替换上一版提案。接受后落盘的是新版本；要改请提意见，不必自己记第几行。");
  } else {
    out.push(`整篇草稿 · ${v.content.trim().length} 字`);
    out.push("");
    out.push(v.content.trim());
    out.push("", "接受后按上述字节原样落盘。");
  }
  return out.join("\n");
}

/**
 * 结构化卡片视图：标题 + 副标题 + 整篇/diff 的 markdown。`sections` 恒为空——
 * 卡片不再按格渲染，正文就是那一段。
 */
export function proposalDisplay(v: ProposalView): ProposalDisplay {
  const title = labelOf(v.name, v.content);
  if (v.previous === undefined) {
    return {
      kind: "design",
      title,
      subtitle: `整篇草稿 · ${v.content.trim().length} 字`,
      sections: [],
      body: v.content.trim(),
    };
  }
  return {
    kind: "design",
    title,
    subtitle: "与上一版提案的差异",
    previousNote: "已替换上一版提案；下面是差异，接受后落盘的是新版本。",
    sections: [],
    diff: diffText(v.previous, v.content),
  };
}