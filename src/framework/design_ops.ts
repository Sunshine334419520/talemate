/**
 * design_ops：**所有写盘工具的唯一实现**。
 *
 * 分层（2026-09-11 收敛）：
 *   工具（8 个入口，各管自己的语义、入参契约、成功文案）
 *     ↓   读写流程：解析目标 → 校验 → confirm(完整内容) → 变换 → 写 → 回结果
 *   design_ops（本文件——这一层只有一份）
 *     ↓   变换
 *   framework/markdown.ts（replaceSection / appendBlock / removeSection / getSection / listHeadings）
 *     ↓   存储原语
 *   storage/project.ts（readDesign / writeDesign / removeDesign / saveChapter）
 *
 * 为什么要有这层：入口多不是问题（8 个工具对应 8 种真实语义），但**实现必须只有一份**。
 * 此前 8 个工具各自手抄了同一套六步、四套 confirm 文案格式、各自的校验——收敛到这里。
 *
 * 边界（别把这层做胖）：
 * - **错误文案由调用方给**（`notFound` / `refScope`）：它们不是重复，是给模型的**路由线索**
 *   （"可用 add-character 新建" / "可用小节：…"），统一化会抹掉模型自我纠正的依据。
 * - **成功文案由调用方拼**：各工具的句子本来就不同（"已追加到" vs "已改写 … › …"）。
 * - confirm 只有**两种**正文标签：`将写入的内容` / `将删除的内容`。
 */
import type { ToolContext } from "../core/types";
import { appendBlock, getSection, listHeadings, removeSection, replaceSection } from "./markdown";

export type DesignOp =
  /** 整篇写/覆盖。confirm:false 用于"新建、无破坏性"的入口（如 add-character）。 */
  | { kind: "write"; name: string; content: string; action?: string; meta?: string; confirm?: boolean }
  /** 按小节标题换掉一格，其余原样。 */
  | { kind: "edit"; name: string; section: string; content: string; notFound?: string }
  /** 末尾追加一块（块内标题与文档已有标题重名则拒绝）。 */
  | { kind: "append"; name: string; block: string; notFound?: string }
  /** 删掉一个小节。 */
  | { kind: "cut"; name: string; section: string; term?: string; notFound?: string; refScope?: string }
  /** 删掉整个文件。 */
  | { kind: "drop"; name: string; term?: string; action?: string; notFound?: string; refScope?: string };

export type DesignOpResult =
  | { ok: true; file: string; name: string; isNew?: boolean; oldLen?: number; newLen?: number }
  | { ok: false; output: string };

/** 文档不存在的默认文案（调用方可给 notFound 覆盖）。 */
export async function designNotFound(ctx: ToolContext, name: string): Promise<string> {
  return `没有找到文档 ${name}。可用：\n${await ctx.listDesigns()}`;
}

/** 引用检查文案（cut / drop 共用）：无命中就一句话，有命中就摊开让用户判断级联。 */
function refNote(term: string, refs: string, scope: string): string {
  const clean = refs.startsWith("没有命中") || refs.startsWith(`「${term}」在文档里没有命中`);
  return clean ? `引用检查「${term}」：无命中。` : `引用检查「${term}」（${scope}）：\n${refs}`;
}

/**
 * 落盘确认的**唯一**渲染：动作名 + 变更摘要 + 将落盘的完整内容。
 * 导出给不走 applyDesignOp 的写盘入口用（如 save-chapter 写 chapters/、另一个存储原语）。
 */
export async function confirmBody(
  ctx: ToolContext,
  action: string,
  meta: string,
  label: "将写入的内容" | "将删除的内容",
  body: string,
): Promise<boolean> {
  return ctx.confirm(action, [meta, "", `──── ${label} ────`, body].join("\n"));
}

/** 执行一次写盘。校验不过 / 用户拒绝 → { ok:false, output }（回给模型，不抛）。 */
export async function applyDesignOp(ctx: ToolContext, op: DesignOp): Promise<DesignOpResult> {
  switch (op.kind) {
    case "write": {
      const old = await ctx.readDesign(op.name);
      const isNew = old === undefined;
      if (op.confirm !== false) {
        const ok = await confirmBody(
          ctx,
          op.action ?? `${isNew ? "新建" : "覆盖"} design/${op.name}`,
          op.meta ??
            (isNew
              ? `新建文件，${op.content.length} 字。`
              : `整篇重写：旧 ${old.length} 字 → 新 ${op.content.length} 字。`),
          "将写入的内容",
          op.content,
        );
        if (!ok) return { ok: false, output: `用户已拒绝写入 design/${op.name}` };
      }
      const file = await ctx.writeDesign(op.name, op.content);
      return { ok: true, file, name: op.name, isNew, oldLen: old?.length, newLen: op.content.length };
    }

    case "edit": {
      const current = await ctx.readDesign(op.name);
      if (current === undefined) return { ok: false, output: op.notFound ?? (await designNotFound(ctx, op.name)) };
      const s = getSection(current, op.section);
      if (!s.found) {
        return {
          ok: false,
          output: `文档 ${op.name} 没有小节「${op.section}」。可用小节：\n${(s.available ?? []).join("\n")}`,
        };
      }
      const ok = await confirmBody(
        ctx,
        `改写 design/${op.name} › ${op.section}`,
        `旧 ${(s.body ?? "").length} 字 → 新 ${op.content.length} 字；其余小节不变。`,
        "将写入的内容",
        op.content,
      );
      if (!ok) return { ok: false, output: `用户已拒绝改写 design/${op.name} › ${op.section}` };
      const file = await ctx.writeDesign(op.name, replaceSection(current, op.section, op.content));
      return { ok: true, file, name: op.name };
    }

    case "append": {
      const current = await ctx.readDesign(op.name);
      if (current === undefined) return { ok: false, output: op.notFound ?? (await designNotFound(ctx, op.name)) };
      const heads = listHeadings(op.block, 2);
      if (heads.length) {
        const existing = new Set(listHeadings(current, 2).map((h) => h.title));
        const dup = heads.find((h) => existing.has(h.title));
        if (dup) {
          return {
            ok: false,
            output: `「${dup.title}」已存在于 ${op.name}——若想修改它请用 edit-design，而不是再追加一份。`,
          };
        }
      }
      const file = await ctx.writeDesign(op.name, appendBlock(current, op.block));
      return { ok: true, file, name: op.name };
    }

    case "cut": {
      const current = await ctx.readDesign(op.name);
      if (current === undefined) return { ok: false, output: op.notFound ?? (await designNotFound(ctx, op.name)) };
      const s = getSection(current, op.section);
      if (!s.found) {
        return {
          ok: false,
          output: `文档 ${op.name} 没有小节「${op.section}」。可用小节：\n${(s.available ?? []).join("\n")}`,
        };
      }
      const term = op.term?.trim() || op.section;
      const refs = refNote(term, await ctx.searchDesigns(term), op.refScope ?? "含本文档内同小节行，请判断是否需级联");
      const ok = await confirmBody(
        ctx,
        `删除 design/${op.name} › ${op.section}`,
        refs,
        "将删除的内容",
        s.block ?? "",
      );
      if (!ok) return { ok: false, output: `用户已拒绝删除 design/${op.name} › ${op.section}` };
      const file = await ctx.writeDesign(op.name, removeSection(current, op.section));
      return { ok: true, file, name: op.name };
    }

    case "drop": {
      const current = await ctx.readDesign(op.name);
      if (current === undefined) return { ok: false, output: op.notFound ?? (await designNotFound(ctx, op.name)) };
      const term = op.term?.trim() || op.name;
      const refs = refNote(term, await ctx.searchDesigns(term), op.refScope ?? "含自身，请判断需否级联");
      const ok = await confirmBody(ctx, op.action ?? `删除 design/${op.name}`, refs, "将删除的内容", current);
      if (!ok) return { ok: false, output: `用户已拒绝删除 design/${op.name}` };
      await ctx.removeDesign(op.name);
      return { ok: true, file: op.name, name: op.name };
    }
  }
}
