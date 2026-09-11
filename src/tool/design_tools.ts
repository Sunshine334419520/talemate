/**
 * design-tools：design/ 通用文档操作（read / list / search / write / edit / append / remove）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt。
 *
 * 写侧（write/edit/append/remove-design-section）都是**薄壳**——校验、confirm(完整内容)、变换、
 * 落盘全在 framework/design_ops.ts 那一份实现里，这里只留自己的入参契约与成功文案。
 * 读侧（read/list/search）不走 design_ops。
 */
import { applyDesignOp, designNotFound } from "../framework/design_ops";
import { getSection } from "../framework/markdown";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** read-design：读整篇或按小节读 */
export const readDesignTool: RegisteredTool<{ name: string; section?: string }> = defineTool<{
  name: string;
  section?: string;
}>({
  id: "read-design",
  description: P("read-design"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      section: { type: "string", description: "Optional: exact section heading to read only that section" },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const content = await ctx.readDesign(args.name);
    if (content === undefined) return { output: await designNotFound(ctx, args.name) };
    if (args.section) {
      const s = getSection(content, args.section);
      if (!s.found) {
        return {
          output: `文档 ${args.name} 里没有小节「${args.section}」。可用小节：\n${(s.available ?? []).join("\n")}`,
        };
      }
      return { output: `# ${args.name} › ${args.section}\n${s.block ?? ""}`, metadata: { name: args.name, section: args.section } };
    }
    return { output: `# ${args.name}\n${content}`, metadata: { name: args.name } };
  },
});

/** list-designs：列文档 + 每文档小节标题 */
export const listDesignsTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "list-designs",
  description: P("list-designs"),
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    return { output: await ctx.listDesigns() };
  },
});

/** search-designs：跨文档查引用 */
export const searchDesignsTool: RegisteredTool<{ query: string }> = defineTool<{ query: string }>({
  id: "search-designs",
  description: P("search-designs"),
  input: {
    type: "object",
    properties: { query: { type: "string", description: "Term to search (character / setting / term)" } },
    required: ["query"],
  },
  async execute(args, ctx) {
    return { output: await ctx.searchDesigns(args.query) };
  },
});

/** write-design：整篇写/覆盖 */
export const writeDesignTool: RegisteredTool<{ name: string; content: string }> = defineTool<{
  name: string;
  content: string;
}>({
  id: "write-design",
  description: P("write-design"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      content: { type: "string", description: "The complete document body" },
    },
    required: ["name", "content"],
  },
  async execute(args, ctx) {
    const r = await applyDesignOp(ctx, { kind: "write", name: args.name, content: args.content });
    if (!r.ok) return { output: r.output };
    const diff = r.isNew ? "(新建)" : `(旧 ${r.oldLen} 字 → 新 ${r.newLen} 字)`;
    return { output: `已保存 ${r.file} ${diff}` };
  },
});

/** edit-design：改一个小节（其余原样） */
export const editDesignTool: RegisteredTool<{ name: string; section: string; content: string }> = defineTool<{
  name: string;
  section: string;
  content: string;
}>({
  id: "edit-design",
  description: P("edit-design"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      section: { type: "string", description: "Section heading to rewrite (must match read-design)" },
      content: { type: "string", description: "New body for that section, without the heading line" },
    },
    required: ["name", "section", "content"],
  },
  async execute(args, ctx) {
    const r = await applyDesignOp(ctx, {
      kind: "edit",
      name: args.name,
      section: args.section,
      content: args.content,
    });
    if (!r.ok) return { output: r.output };
    return { output: `已改写 ${r.file} › ${args.section}`, metadata: { name: args.name, section: args.section } };
  },
});

/** append-design：末尾追加一块（新设定小节等） */
export const appendDesignTool: RegisteredTool<{ name: string; block: string }> = defineTool<{ name: string; block: string }>({
  id: "append-design",
  description: P("append-design"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      block: { type: "string", description: "Markdown block to append (with its own ## / ### headings)" },
    },
    required: ["name", "block"],
  },
  async execute(args, ctx) {
    const r = await applyDesignOp(ctx, { kind: "append", name: args.name, block: args.block });
    if (!r.ok) return { output: r.output };
    return { output: `已追加到 ${r.file}`, metadata: { name: args.name } };
  },
});

/** remove-design-section：删一个小节（删前引用检查进 confirm） */
export const removeDesignSectionTool: RegisteredTool<{ name: string; section: string; term?: string }> = defineTool<{
  name: string;
  section: string;
  term?: string;
}>({
  id: "remove-design-section",
  description: P("remove-design-section"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      section: { type: "string", description: "Section heading to delete" },
      term: { type: "string", description: "Optional: entity term for the reference check; defaults to the section heading" },
    },
    required: ["name", "section"],
  },
  async execute(args, ctx) {
    const r = await applyDesignOp(ctx, {
      kind: "cut",
      name: args.name,
      section: args.section,
      term: args.term,
    });
    if (!r.ok) return { output: r.output };
    return { output: `已删除 ${r.file} › ${args.section}`, metadata: { name: args.name, section: args.section } };
  },
});

export const DESIGN_TOOLS: RegisteredTool[] = [
  readDesignTool,
  listDesignsTool,
  searchDesignsTool,
  writeDesignTool,
  editDesignTool,
  appendDesignTool,
  removeDesignSectionTool,
];
