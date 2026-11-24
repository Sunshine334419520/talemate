/**
 * find-tools：`glob` 与 `grep` 两个基础读侧工具。
 *
 * 它们只是薄壳：参数校验在工具层，范围/过滤/上限/渲染都在 `framework/find.ts`。候选集来自
 * 项目根表（`core/roots.ts`），工具不认识任何根名——加一个目录不需要改这里。
 *
 * 错误分两种：缺参数/范围不对/正则坏了属于模型能自己修的 → `return { output }`；
 * 只有 `FindError` 之外的意外才冒出去（runner 会转成 error part）。
 */
import { FindError, globDocs, grepDocs } from "../framework/find";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

export const globTool: RegisteredTool<{ pattern: string; path?: string }> = defineTool<{
  pattern: string;
  path?: string;
}>({
  id: "glob",
  description: P("glob"),
  input: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Project-relative glob: * (within one segment, not across /), ** (any depth), ? (one character). A pattern without / matches the file name at any depth, so *.md finds every markdown file.",
      },
      path: {
        type: "string",
        description: "Optional directory to search under, project-relative (design, design/wiki). Omit to search the whole project.",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const pattern = (args.pattern ?? "").trim();
    if (pattern === "") {
      return { output: `glob 缺少 pattern（收到：${JSON.stringify(args).slice(0, 200)}）——给一个模式，如 design/**/*.md。` };
    }
    try {
      return { output: await ctx.globDocs(pattern, args.path?.trim() || undefined) };
    } catch (e) {
      if (e instanceof FindError) return { output: e.message };
      throw e;
    }
  },
});

export const grepTool: RegisteredTool<{
  pattern: string;
  path?: string;
  include?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
}> = defineTool<{
  pattern: string;
  path?: string;
  include?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
}>({
  id: "grep",
  description: P("grep"),
  input: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (or literal text with literal: true)" },
      path: {
        type: "string",
        description:
          "Optional directory or single file to search, project-relative. Omit to search the whole project.",
      },
      include: {
        type: "string",
        description: 'Optional file glob under path, e.g. "characters/*.md" or "*.md"',
      },
      literal: { type: "boolean", description: "Treat pattern as plain text instead of a regex" },
      ignoreCase: { type: "boolean", description: "Case-insensitive matching" },
      context: {
        type: "number",
        description: "0–3: lines of context before and after each match (default 0)",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const pattern = (args.pattern ?? "").trim();
    if (pattern === "") {
      return { output: `grep 缺少 pattern（收到：${JSON.stringify(args).slice(0, 200)}）——给一个正则，或加 literal:true 按普通文本搜。` };
    }
    try {
      return {
        output: await ctx.grepDocs({
          pattern,
          ...(args.path?.trim() ? { path: args.path.trim() } : {}),
          ...(args.include?.trim() ? { include: args.include.trim() } : {}),
          ...(args.literal === true ? { literal: true } : {}),
          ...(args.ignoreCase === true ? { ignoreCase: true } : {}),
          ...(typeof args.context === "number" ? { context: args.context } : {}),
        }),
      };
    } catch (e) {
      if (e instanceof FindError) return { output: e.message };
      throw e;
    }
  },
});

export const FIND_TOOLS: RegisteredTool[] = [globTool, grepTool];