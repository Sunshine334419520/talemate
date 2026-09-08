/**
 * doc-tools：design/ 通用文档操作（read/list/search/write/edit/append/remove）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt。特殊领域（角色/大纲）另有专工具。
 */
import { appendBlock, getSection, listHeadings, removeSection, replaceSection } from "../framework/markdown";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

const noDoc = (name: string) => `没有找到文档 ${name}。可用：\n${/* injected list */ ""}`;

/** read-doc：读整篇或按小节读 */
export const readDocTool: RegisteredTool<{ name: string; section?: string }> = defineTool<{
  name: string;
  section?: string;
}>({
  id: "read-doc",
  description: P("read-doc"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      section: { type: "string", description: "Optional: exact section heading to read only that section" },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const content = await ctx.readDoc(args.name);
    if (content === undefined) return { output: `${noDoc(args.name)}${await ctx.listDocs()}` };
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

/** list-docs：列文档 + 每文档小节标题 */
export const listDocsTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "list-docs",
  description: P("list-docs"),
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    return { output: await ctx.listDocs() };
  },
});

/** search-docs：跨文档查引用 */
export const searchDocsTool: RegisteredTool<{ query: string }> = defineTool<{ query: string }>({
  id: "search-docs",
  description: P("search-docs"),
  input: {
    type: "object",
    properties: { query: { type: "string", description: "Term to search (character / setting / term)" } },
    required: ["query"],
  },
  async execute(args, ctx) {
    return { output: await ctx.searchDocs(args.query) };
  },
});

/** write-doc：整篇写/覆盖 */
export const writeDocTool: RegisteredTool<{ name: string; content: string }> = defineTool<{
  name: string;
  content: string;
}>({
  id: "write-doc",
  description: P("write-doc"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      content: { type: "string", description: "The complete document body" },
    },
    required: ["name", "content"],
  },
  needsConfirm(args) {
    return `覆盖 design/${args.name}（${args.content.length} 字，整篇重写）`;
  },
  async execute(args, ctx) {
    const old = await ctx.readDoc(args.name);
    const file = await ctx.writeDoc(args.name, args.content);
    const diff = old === undefined ? "(新建)" : `(旧 ${old.length} 字 → 新 ${args.content.length} 字)`;
    return { output: `已保存 ${file} ${diff}` };
  },
});

/** edit-doc：改一个小节（其余原样），confirm 动态 */
export const editDocTool: RegisteredTool<{ name: string; section: string; content: string }> = defineTool<{
  name: string;
  section: string;
  content: string;
}>({
  id: "edit-doc",
  description: P("edit-doc"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      section: { type: "string", description: "Section heading to rewrite (must match read-doc)" },
      content: { type: "string", description: "New body for that section, without the heading line" },
    },
    required: ["name", "section", "content"],
  },
  async execute(args, ctx) {
    const current = await ctx.readDoc(args.name);
    if (current === undefined) return { output: `${noDoc(args.name)}${await ctx.listDocs()}` };
    const s = getSection(current, args.section);
    if (!s.found) {
      return { output: `文档 ${args.name} 没有小节「${args.section}」。可用小节：\n${(s.available ?? []).join("\n")}` };
    }
    const ok = await ctx.confirm(
      `改写 design/${args.name} › ${args.section}`,
      `旧 ${(s.body ?? "").length} 字 → 新 ${args.content.length} 字；其余小节不变。`,
    );
    if (!ok) return { output: `用户已拒绝改写 design/${args.name} › ${args.section}` };
    const next = replaceSection(current, args.section, args.content);
    const file = await ctx.writeDoc(args.name, next);
    return { output: `已改写 ${file} › ${args.section}`, metadata: { name: args.name, section: args.section } };
  },
});

/** append-doc：末尾追加一块（新角色卡/新设定小节） */
export const appendDocTool: RegisteredTool<{ name: string; block: string }> = defineTool<{ name: string; block: string }>({
  id: "append-doc",
  description: P("append-doc"),
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "Document filename under design/ (incl. .md)" },
      block: { type: "string", description: "Markdown block to append (with its own ## / ### headings)" },
    },
    required: ["name", "block"],
  },
  async execute(args, ctx) {
    const current = await ctx.readDoc(args.name);
    if (current === undefined) return { output: `${noDoc(args.name)}${await ctx.listDocs()}` };
    const blockHeads = listHeadings(args.block, 2);
    if (blockHeads.length) {
      const existing = new Set(listHeadings(current, 2).map((h) => h.title));
      const dup = blockHeads.find((h) => existing.has(h.title));
      if (dup) {
        return { output: `「${dup.title}」已存在于 ${args.name}——若想修改它请用 edit-doc，而不是再追加一份。` };
      }
    }
    const file = await ctx.writeDoc(args.name, appendBlock(current, args.block));
    return { output: `已追加到 ${file}`, metadata: { name: args.name } };
  },
});

/** remove-doc-section：删一个小节，删除前引用检查进 confirm */
export const removeDocSectionTool: RegisteredTool<{ name: string; section: string; term?: string }> = defineTool<{
  name: string;
  section: string;
  term?: string;
}>({
  id: "remove-doc-section",
  description: P("remove-doc-section"),
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
    const current = await ctx.readDoc(args.name);
    if (current === undefined) return { output: `${noDoc(args.name)}${await ctx.listDocs()}` };
    const s = getSection(current, args.section);
    if (!s.found) {
      return { output: `文档 ${args.name} 没有小节「${args.section}」。可用小节：\n${(s.available ?? []).join("\n")}` };
    }
    const term = args.term?.trim() || args.section;
    const refs = await ctx.searchDocs(term);
    const summary =
      refs.startsWith("没有命中") || refs.startsWith(`「${term}」在文档里没有命中`)
        ? `引用检查「${term}」：无命中。`
        : `引用检查「${term}」（含本文档内同小节行，请判断是否需级联）：\n${refs}`;
    const ok = await ctx.confirm(`删除 design/${args.name} › ${args.section}（${(s.block ?? "").length} 字）`, summary);
    if (!ok) return { output: `用户已拒绝删除 design/${args.name} › ${args.section}` };
    const file = await ctx.writeDoc(args.name, removeSection(current, args.section));
    return { output: `已删除 ${file} › ${args.section}`, metadata: { name: args.name, section: args.section } };
  },
});

export const DOC_TOOLS: RegisteredTool[] = [
  readDocTool,
  listDocsTool,
  searchDocsTool,
  writeDocTool,
  editDocTool,
  appendDocTool,
  removeDocSectionTool,
];
