/**
 * character-tools：角色卡领域工具（add/update/remove-character）。
 * 角色规范（卡该有哪 5 个小节）在 src/framework/characters.ts —— 工具入参即契约，落盘成合规卡。
 * 文件读写复用 ctx 原语 + framework/markdown，不互相调用其它工具。
 */
import {
  CHARACTER_FIELDS,
  cardTitle,
  charactersDocSkeleton,
  parseCard,
  removeCard,
  upsertCard,
  type CharacterFields,
} from "../framework/characters";
import { getSection } from "../framework/markdown";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);
const DOC = "characters.md";

function fieldProps(required: string[]): Record<string, { type: string; description: string }> {
  const out: Record<string, { type: string; description: string }> = {
    name: { type: "string", description: "角色名（会建成 `## 角色：<名字>` 卡片）" },
  };
  for (const f of CHARACTER_FIELDS) out[f.key] = { type: "string", description: `${f.label}：${f.placeholder}` };
  return out;
}

function isPlaceholder(v: string | undefined): boolean {
  const t = (v ?? "").trim();
  return !t || /^（待定.*）$/.test(t);
}

function pendingLabels(fields: CharacterFields): string[] {
  return CHARACTER_FIELDS.filter((f) => isPlaceholder(fields[f.key])).map((f) => f.label);
}

function pickFields(args: Record<string, unknown>): CharacterFields {
  const out: CharacterFields = {};
  for (const f of CHARACTER_FIELDS) {
    const v = args[f.key];
    if (typeof v === "string" && v !== undefined) out[f.key] = v;
  }
  return out;
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
    // 懒建：characters.md 不存在就先建骨架（总表），再落卡
    let content = await ctx.readDoc(DOC);
    if (content === undefined) {
      await ctx.writeDoc(DOC, charactersDocSkeleton());
      content = (await ctx.readDoc(DOC)) ?? charactersDocSkeleton();
    }
    if (getSection(content, cardTitle(name)).found) {
      return { output: `角色「${name}」已存在。要改它请用 update-character。` };
    }
    const fields = pickFields(args);
    const next = upsertCard(content, name, fields).content;
    await ctx.writeDoc(DOC, next);
    const pend = pendingLabels(fields);
    return {
      output:
        `已新增角色卡「${name}」（characters.md）。` +
        (pend.length ? `\n仍待补：${pend.join("、")}——可用 update-character 逐格完善。` : "\n卡已完整（五个小节都填了）。"),
      metadata: { name },
    };
  },
});

/** update-character：改一张卡的若干小节（只改传入的格，其余保留），confirm 后写回。 */
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
    const content = await ctx.readDoc(DOC);
    if (content === undefined) return { output: `没有找到 ${DOC}。` };
    const parsed = parseCard(content, name);
    if (!parsed.found) return { output: `没有找到角色「${name}」。可用 add-character 新建。` };
    const incoming = pickFields(args);
    const changed = CHARACTER_FIELDS.filter((f) => incoming[f.key] !== undefined).map((f) => f.label);
    if (!changed.length) return { output: "没有传入要改的小节（至少给一个：one_line / want_fear / idiolect / habit / function）。" };
    const merged: CharacterFields = { ...parsed.fields, ...incoming };
    const ok = await ctx.confirm(`更新角色卡「${name}」`, `将改写小节：${changed.join("、")}；其余保留。`);
    if (!ok) return { output: `用户已拒绝更新角色卡「${name}」` };
    await ctx.writeDoc(DOC, upsertCard(content, name, merged).content);
    return { output: `已更新角色卡「${name}」：${changed.join("、")}。`, metadata: { name } };
  },
});

/** remove-character：删除角色卡（删除前引用检查进 confirm，并同步角色总表）。 */
export const removeCharacterTool: RegisteredTool<{ name: string }> = defineTool<{ name: string }>({
  id: "remove-character",
  description: P("remove-character"),
  input: {
    type: "object",
    properties: { name: { type: "string", description: "要删除的角色名" } },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = args.name.trim();
    const content = await ctx.readDoc(DOC);
    if (content === undefined) return { output: `没有找到 ${DOC}。` };
    if (!getSection(content, cardTitle(name)).found) {
      return { output: `没有找到角色「${name}」。` };
    }
    const refs = await ctx.searchDocs(name);
    const summary =
      refs.startsWith("没有命中") || refs.startsWith(`「${name}」在文档里没有命中`)
        ? `引用检查「${name}」：无命中。`
        : `引用检查「${name}」（含角色卡自身，请判断需否级联改 world/outline）：\n${refs}`;
    const ok = await ctx.confirm(`删除角色卡「${name}」`, summary);
    if (!ok) return { output: `用户已拒绝删除角色「${name}」` };
    await ctx.writeDoc(DOC, removeCard(content, name));
    return { output: `已删除角色「${name}」并同步角色总表。` };
  },
});

export const CHARACTER_TOOLS: RegisteredTool[] = [addCharacterTool, updateCharacterTool, removeCharacterTool];
