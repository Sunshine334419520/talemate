/**
 * character-tools：角色卡领域工具（add/update/remove-character）。
 * 角色规范（卡该有哪 5 个小节）在 src/framework/characters.ts —— 工具入参即契约，落盘成合规卡。
 * 一角色一卡（design/characters/<名>.md）；characters/_index.md 是派生总表，每次增删改后重建。
 * 文件读写复用 ctx 原语，不互相调用其它工具。
 */
import {
  CHARACTER_FIELDS,
  buildCardMarkdown,
  cardPath,
  INDEX_PATH,
  isMissingField,
  nameFromPath,
  parseCardBody,
  syncIndex as renderIndex,
  type CharacterFields,
} from "../framework/characters";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";
import type { ToolContext } from "../core/types";

const P = (id: string) => readPrompt(`tools/${id}`);

function fieldProps(required: string[]): Record<string, { type: string; description: string }> {
  const out: Record<string, { type: string; description: string }> = {
    name: { type: "string", description: "Character name (creates characters/<name>.md)" },
  };
  for (const f of CHARACTER_FIELDS) out[f.key] = { type: "string", description: `${f.label}：${f.placeholder}` };
  return out;
}

function pickFields(args: Record<string, unknown>): CharacterFields {
  const out: CharacterFields = {};
  for (const f of CHARACTER_FIELDS) {
    const v = args[f.key];
    if (typeof v === "string" && v !== undefined) out[f.key] = v;
  }
  return out;
}

function pendingLabels(fields: CharacterFields): string[] {
  return CHARACTER_FIELDS.filter((f) => isMissingField(fields[f.key])).map((f) => f.label);
}

/** 扫描 characters/ 重建 _index.md（工具每次增删改后调用）。 */
async function rebuildIndex(ctx: ToolContext): Promise<void> {
  const cards: { name: string; one_line: string | undefined }[] = [];
  for (const rel of await ctx.listDocPaths()) {
    const name = nameFromPath(rel);
    if (!name) continue; // 含 _index.md 本身
    const content = await ctx.readDoc(rel);
    if (content === undefined) continue;
    cards.push({ name, one_line: parseCardBody(content).one_line });
  }
  await ctx.writeDoc(INDEX_PATH, renderIndex(cards));
}

/** add-character：新建一张角色卡（缺失字段自动补（待定），输出提示后续补哪些），并同步总表。 */
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
    if ((await ctx.readDoc(cardPath(name))) !== undefined) {
      return { output: `角色「${name}」已存在。要改它请用 update-character。` };
    }
    const fields = pickFields(args);
    await ctx.writeDoc(cardPath(name), buildCardMarkdown(name, fields));
    await rebuildIndex(ctx);
    const pend = pendingLabels(fields);
    return {
      output:
        `已新增角色卡「${name}」（design/characters/${name}.md）。` +
        (pend.length ? `\n仍待补：${pend.join("、")}——可用 update-character 逐格完善。` : "\n卡已完整（五个小节都填了）。"),
      metadata: { name },
    };
  },
});

/** update-character：改一张卡的若干小节（只改传入的格，其余保留），confirm 后写回并同步总表。 */
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
    const content = await ctx.readDoc(cardPath(name));
    if (content === undefined) return { output: `没有找到角色「${name}」。可用 add-character 新建。` };
    const incoming = pickFields(args);
    const changed = CHARACTER_FIELDS.filter((f) => incoming[f.key] !== undefined).map((f) => f.label);
    if (!changed.length) return { output: "没有传入要改的小节（至少给一个：one_line / want_fear / idiolect / habit / function）。" };
    const merged: CharacterFields = { ...parseCardBody(content), ...incoming };
    const ok = await ctx.confirm(`更新角色卡「${name}」`, `将改写小节：${changed.join("、")}；其余保留。`);
    if (!ok) return { output: `用户已拒绝更新角色卡「${name}」` };
    await ctx.writeDoc(cardPath(name), buildCardMarkdown(name, merged));
    await rebuildIndex(ctx);
    return { output: `已更新角色卡「${name}」：${changed.join("、")}。`, metadata: { name } };
  },
});

/** remove-character：删除角色卡（删除前引用检查进 confirm，删除后同步总表）。 */
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
    if ((await ctx.readDoc(cardPath(name))) === undefined) {
      return { output: `没有找到角色「${name}」。` };
    }
    const refs = await ctx.searchDocs(name);
    const summary =
      refs.startsWith("没有命中") || refs.startsWith(`「${name}」在文档里没有命中`)
        ? `引用检查「${name}」：无命中。`
        : `引用检查「${name}」（含角色卡自身，请判断需否级联改 world/outline）：\n${refs}`;
    const ok = await ctx.confirm(`删除角色卡「${name}」（design/characters/${name}.md）`, summary);
    if (!ok) return { output: `用户已拒绝删除角色「${name}」` };
    await ctx.removeDoc(cardPath(name));
    await rebuildIndex(ctx);
    return { output: `已删除角色「${name}」并同步角色总表。` };
  },
});

export const CHARACTER_TOOLS: RegisteredTool[] = [addCharacterTool, updateCharacterTool, removeCharacterTool];
