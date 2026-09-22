/**
 * design_ops：**所有写盘工具的唯一实现**。
 *
 *   工具（各管自己的语义、入参契约、成功文案）
 *     ↓   解析目标 → 校验 → confirm(完整内容) → 变换 → 写 → 回结果
 *   design_ops（本文件——这一层只有一份）
 *     ↓   变换
 *   framework/markdown.ts（replaceSection / appendBlock / removeSection / getSection / listHeadings）
 *     ↓   存储原语
 *   storage/project.ts（readDesign / writeDesign / removeDesign / saveChapter）
 *
 * 边界（别把这层做胖）：
 * - **错误文案由调用方给**（`notFound` / `refScope`）：它们是给模型的**路由线索**
 *   （"可用小节：…" / "没有找到角色「X」"），统一化会抹掉模型自我纠正的依据。
 * - **成功文案由调用方拼**：各工具的句子本来就不同（"已追加到" vs "已改写 … › …"）。
 * - confirm 只有**两种**正文标签：`将写入的内容` / `将删除的内容`。
 */
import type { PermissionVerdict, ToolContext } from "../core/types";
import { appendBlock, getSection, listHeadings, removeSection, replaceSection } from "./markdown";

export type DesignOp =
  /** 整篇写/覆盖。confirm:false 用于"内容已经过提案回合、用户已过目"的入口（apply-design）。 */
  | { kind: "write"; name: string; content: string; action?: string; meta?: string; confirm?: boolean }
  /** 按小节标题换掉一格，其余原样。confirm:false 用于"内容已经过提案回合、用户已过目"的入口（apply-design）。 */
  | { kind: "edit"; name: string; section: string; content: string; notFound?: string; confirm?: boolean }
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
 * 落盘前的**权限请求**：一切写 design/ 的动作都走这一个口。
 *
 * 权限判定与"该问就问"都在 `ctx.ask` 里（规则表决定 allow / ask / deny；答复 `always` 会记进
 * 会话）。这里只负责把它渲染成人能判断的样子——`action` 是标题，其余是**材料**（将落盘的完整内容）。
 *
 * 返回三档由调用方各自组文案：`allow` 继续，`reject` 用户拒了，`deny` 规则不许。
 */
export async function askWrite(
  ctx: ToolContext,
  op: {
    /** 这次动哪个文件（design/ 相对路径） */
    pattern: string;
    /** 用户选「以后都允许」时记下哪条规则 */
    always?: string;
    action: string;
    meta: string;
    label: "将写入的内容" | "将删除的内容";
    body: string;
    /**
     * 要不要弹给用户。`false` 只有一处用：`apply-design`——用户已经在提案里看过这份内容了。
     * **但它仍然要过一遍规则表**：`deny` 是"不许"，不因为已经问过一次就失效。
     */
    prompt?: boolean;
  },
): Promise<PermissionVerdict> {
  if (op.prompt === false) return ctx.check("edit", op.pattern) === "deny" ? "deny" : "allow";
  return ctx.ask({
    permission: "edit",
    pattern: op.pattern,
    always: op.always ?? op.pattern,
    summary: op.action,
    detail: [op.meta, "", `──── ${op.label} ────`, op.body].join("\n"),
  });
}

/**
 * 没写成时的文案。`reject` 和 `deny` 都要说清**为什么**——它们是给模型的路由线索：
 * 前者等人点头，后者得先离开模式。
 */
export function writeBlocked(kind: "reject" | "deny", what: string): string {
  return kind === "deny"
    ? `${what}：当前模式不允许改文件。要改就先离开计划模式（exit-plan）再动手。`
    : `用户已拒绝${what}`;
}

/** 执行一次写盘。校验不过 / 用户拒绝 → { ok:false, output }（回给模型，不抛）。 */
export async function applyDesignOp(ctx: ToolContext, op: DesignOp): Promise<DesignOpResult> {
  switch (op.kind) {
    case "write": {
      const old = await ctx.readDesign(op.name);
      const isNew = old === undefined;
      // `apply-design` 走 `confirm: false`：用户已经在提案里看过内容，所以**不弹窗**。
      // 但"这个文件不许改"是另一回事——仍然要过规则表，`prompt: false` 只跳过弹窗那一步。
      const verdict = await askWrite(ctx, {
        pattern: op.name,
        prompt: op.confirm !== false,
        action: op.action ?? `${isNew ? "新建" : "覆盖"} design/${op.name}`,
        meta:
          op.meta ??
          (isNew
            ? `新建文件，${op.content.length} 字。`
            : `整篇重写：旧 ${old.length} 字 → 新 ${op.content.length} 字。`),
        label: "将写入的内容",
        body: op.content,
      });
      if (verdict !== "allow") return { ok: false, output: writeBlocked(verdict, `写入 design/${op.name}`) };
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
      const verdict = await askWrite(ctx, {
        pattern: op.name,
        prompt: op.confirm !== false,
        action: `改写 design/${op.name} › ${op.section}`,
        meta: `旧 ${(s.body ?? "").length} 字 → 新 ${op.content.length} 字；其余小节不变。`,
        label: "将写入的内容",
        body: op.content,
      });
      if (verdict !== "allow") {
        return { ok: false, output: writeBlocked(verdict, `改写 design/${op.name} › ${op.section}`) };
      }
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
            output: `「${dup.title}」已存在于 ${op.name}——若想修改它请用 propose-design（带 section），而不是再追加一份。`,
          };
        }
      }
      // 追加也是改文件，同样走权限（以前它不问——那是"非破坏性"的旧口径，在权限体系里不成立：
      // 判据是"这个动作改不改文件"，不是"破坏得厉不厉害"）。
      const verdict = await askWrite(ctx, {
        pattern: op.name,
        action: `追加到 design/${op.name}`,
        meta: `新增 ${op.block.length} 字；已有小节不动。`,
        label: "将写入的内容",
        body: op.block,
      });
      if (verdict !== "allow") return { ok: false, output: writeBlocked(verdict, `追加到 design/${op.name}`) };
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
      const verdict = await askWrite(ctx, {
        pattern: op.name,
        action: `删除 design/${op.name} › ${op.section}`,
        meta: refs,
        label: "将删除的内容",
        body: s.block ?? "",
      });
      if (verdict !== "allow") {
        return { ok: false, output: writeBlocked(verdict, `删除 design/${op.name} › ${op.section}`) };
      }
      const file = await ctx.writeDesign(op.name, removeSection(current, op.section));
      return { ok: true, file, name: op.name };
    }

    case "drop": {
      const current = await ctx.readDesign(op.name);
      if (current === undefined) return { ok: false, output: op.notFound ?? (await designNotFound(ctx, op.name)) };
      const term = op.term?.trim() || op.name;
      const refs = refNote(term, await ctx.searchDesigns(term), op.refScope ?? "含自身，请判断需否级联");
      const verdict = await askWrite(ctx, {
        pattern: op.name,
        action: op.action ?? `删除 design/${op.name}`,
        meta: refs,
        label: "将删除的内容",
        body: current,
      });
      if (verdict !== "allow") return { ok: false, output: writeBlocked(verdict, `删除 design/${op.name}`) };
      await ctx.removeDesign(op.name);
      return { ok: true, file: op.name, name: op.name };
    }
  }
}
