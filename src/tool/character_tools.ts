/**
 * character-tools：角色卡领域工具（add/update/remove-character）。
 * 角色规范（卡该有哪些小节、分几层）在 src/framework/characters.ts —— 工具入参即契约，落盘成合规卡。
 * 一角色一卡（design/characters/<名>.md）；**没有派生总表**，名单由 list-designs 现算。
 *
 * 写盘是薄壳：校验 / confirm / 变换 / 落盘都在 framework/design_ops.ts。
 */
import { applyDesignOp } from "../framework/design_ops";
import {
  EDITABLE_FIELDS,
  RESIDENT_FIELDS,
  applyCardEdits,
  buildCardMarkdown,
  cardPath,
  isMissingField,
  rejectHeadings,
  type CharacterFields,
} from "../framework/characters";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

function fieldProps(required: string[]): Record<string, { type: string; description: string }> {
  const out: Record<string, { type: string; description: string }> = {
    name: { type: "string", description: "Character name (creates characters/<name>.md)" },
  };
  // 工具托管的「当前」不进 schema：它是章末回写的产物，不该被模型当普通字段填。
  for (const f of EDITABLE_FIELDS) {
    const tier = f.tier === "resident" ? "常驻带（每场必带）" : "按需格（按戏份补）";
    out[f.key] = { type: "string", description: `${tier} ${f.label}：${f.placeholder}` };
  }
  return out;
}

function pickFields(args: Record<string, unknown>): CharacterFields {
  const out: CharacterFields = {};
  for (const f of EDITABLE_FIELDS) {
    const v = args[f.key];
    if (typeof v === "string" && v !== undefined) out[f.key] = v;
  }
  return out;
}

/** 还缺哪些**常驻格**。按需格缺失不是缺陷——按戏份填，所以不催。 */
function pendingLabels(fields: CharacterFields): string[] {
  return RESIDENT_FIELDS.filter((f) => isMissingField(fields[f.key])).map((f) => f.label);
}

/** add-character：新建一张角色卡（缺失字段自动补（待定），输出提示后续补哪些）。 */
export const addCharacterTool: RegisteredTool<Record<string, unknown>> = defineTool<Record<string, unknown>>({
  id: "add-character",
  description: P("add-character"),
  input: {
    type: "object",
    properties: fieldProps(["name"]),
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = (args.name as string | undefined)?.trim();
    if (!name) return { output: "add-character 需要 name（角色名）。" };
    if ((await ctx.readDesign(cardPath(name))) !== undefined) {
      return { output: `角色「${name}」已存在。要改它请用 update-character。` };
    }
    const fields = pickFields(args);
    // confirm:false —— 新建无破坏性，沿用原行为不打断用户
    const r = await applyDesignOp(ctx, {
      kind: "write",
      name: cardPath(name),
      content: buildCardMarkdown(name, fields),
      confirm: false,
    });
    if (!r.ok) return { output: r.output };
    const pend = pendingLabels(fields);
    return {
      output:
        `已新增角色卡「${name}」（design/characters/${name}.md）。` +
        (pend.length
          ? `\n仍待补（常驻带）：${pend.join("、")}——这四格每场都要带，先补它们；` +
            "按需格（性格与矛盾 / 来历 / 语录 / 关联角色…）按戏份随时补。"
          : "\n常驻带四格都填了；按需格按戏份随时补。"),
      metadata: { name },
    };
  },
});

/**
 * update-character：改一张卡的若干小节，confirm 后写回并同步总表。
 *
 * 改动是**外科**的（framework/characters.applyCardEdits）：只动传入的格，规范外的自定义小节
 * （如「回响」）与别名格（老卡的「习惯动作」）原样保留。旧实现整卡重建，会把它们静默抹掉。
 * 「当前」是工具托管格，这里碰不到。
 */
export const updateCharacterTool: RegisteredTool<Record<string, unknown>> = defineTool<Record<string, unknown>>({
  id: "update-character",
  description: P("update-character"),
  input: {
    type: "object",
    properties: fieldProps([]),
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = (args.name as string | undefined)?.trim();
    if (!name) return { output: "update-character 需要 name（角色名）。" };
    const content = await ctx.readDesign(cardPath(name));
    if (content === undefined) return { output: `没有找到角色「${name}」。可用 add-character 新建。` };
    const incoming = pickFields(args);
    const changed = EDITABLE_FIELDS.filter((f) => incoming[f.key] !== undefined);
    if (!changed.length) {
      return {
        output:
          `没有传入要改的小节。可改：${EDITABLE_FIELDS.map((f) => f.key).join(" / ")}。` +
          "（「当前」由章末回写维护，不走这里。）",
      };
    }
    for (const f of changed) {
      const bad = rejectHeadings(incoming[f.key]!);
      if (bad) return { output: `「${f.label}」${bad}` };
    }
    // 外科改：只换传入的格，其余（含自定义小节）字节不动。confirm 摊出的是改完的完整卡。
    const next = applyCardEdits(content, incoming);
    const r = await applyDesignOp(ctx, {
      kind: "write",
      name: cardPath(name),
      content: next,
      action: `更新角色卡「${name}」`,
      meta: `将改写小节：${changed.map((f) => f.label).join("、")}；其余小节（含自定义小节）原样保留。`,
    });
    if (!r.ok) return { output: r.output };
    return { output: `已更新角色卡「${name}」：${changed.map((f) => f.label).join("、")}。`, metadata: { name } };
  },
});

/** remove-character：删除角色卡（删前引用检查进 confirm，删除后同步总表）。 */
export const removeCharacterTool: RegisteredTool<{ name: string }> = defineTool<{ name: string }>({
  id: "remove-character",
  description: P("remove-character"),
  input: {
    type: "object",
    properties: { name: { type: "string", description: "Character name to delete" } },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = args.name.trim();
    const r = await applyDesignOp(ctx, {
      kind: "drop",
      name: cardPath(name),
      term: name,
      action: `删除角色卡「${name}」（design/characters/${name}.md）`,
      refScope: "含角色卡自身，请判断需否级联改 world/outline",
      notFound: `没有找到角色「${name}」。`,
    });
    if (!r.ok) return { output: r.output };
    return { output: `已删除角色「${name}」。` };
  },
});

export const CHARACTER_TOOLS: RegisteredTool[] = [addCharacterTool, updateCharacterTool, removeCharacterTool];
