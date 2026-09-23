/**
 * read-tools：**项目语料的三个读口**——read / list / search。
 *
 * 三个动词对应三种问法：给路径要内容（`read`）、要目录（`list`）、要跨文档找词（`search`）。
 * 都**按项目相对路径**寻址（`design/core.md` / `chapters/chapter_ch2_v1.md`），与 `write` / `edit` /
 * `delete` 同一套口径——所以 `read` 读得到章节，`search` 也扫得到章节。
 *
 * 从前它们叫 `read-design` / `list-designs` / `search-designs`，把"只管 `design/`"焊进了名字里：
 * 于是章节读不到、`listChapters` 成了没人调的死方法。现在管辖范围由 `path` 参数给，名字不再撒谎。
 *
 * 取数在 `storage/corpus.ts`，目录渲染在 `framework/anchor.buildIndex`，命中渲染在
 * `framework/search.renderHits`——本文件只是三个薄壳，一句 fs 都不碰（有结构测试钉着）。
 */
import type { ToolContext } from "../core/types";
import { getSection } from "../framework/markdown";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/**
 * 路径所属的那一段（`design/core.md` → `design/`），用于"没找到"时列出**那一段**有什么。
 * 认不出根（模型给了个裸文件名）→ 整个项目，反正它更需要看全貌。
 */
function rootOf(path: string): string {
  const i = path.indexOf("/");
  return i > 0 ? `${path.slice(0, i)}/` : "";
}

/**
 * 文档不存在时的文案。它是给模型的**路由线索**——"可用：…"让模型知道该写哪一份，
 * 所以带上清单，而不是只说一句"找不到"。
 */
async function notFound(ctx: ToolContext, path: string): Promise<string> {
  return `没有找到文档 ${path}。可用：\n${await ctx.listIndex(rootOf(path))}`;
}

/** read：读整篇或按小节读 */
export const readTool: RegisteredTool<{ path: string; section?: string }> = defineTool<{
  path: string;
  section?: string;
}>({
  id: "read",
  description: P("read"),
  input: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Document path incl. its root and .md — design/core.md, design/characters/林晚.md, chapters/chapter_ch1_v1.md",
      },
      section: { type: "string", description: "Optional: exact section heading to read only that section" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const content = await ctx.readDoc(args.path);
    if (content === undefined) return { output: await notFound(ctx, args.path) };
    if (args.section) {
      const s = getSection(content, args.section);
      if (!s.found) {
        return {
          output: `文档 ${args.path} 里没有小节「${args.section}」。可用小节：\n${(s.available ?? []).join("\n")}`,
        };
      }
      return {
        output: `# ${args.path} › ${args.section}\n${s.block ?? ""}`,
        metadata: { path: args.path, section: args.section },
      };
    }
    return { output: `# ${args.path}\n${content}`, metadata: { path: args.path } };
  },
});

/**
 * list：目录索引。`path` 是**项目相对前缀**——给 `design/` 就只列企划，给 `chapters/` 只列正文，
 * 不给就列整个项目。
 */
export const listTool: RegisteredTool<{ path?: string }> = defineTool<{ path?: string }>({
  id: "list",
  description: P("list"),
  input: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional project-relative prefix to scope the listing: design/ or chapters/. Omit for the whole project.",
      },
    },
  },
  async execute(args, ctx) {
    return { output: await ctx.listIndex((args.path ?? "").trim()) };
  },
});

/** search：跨文档查引用。`path` 同上——范围是参数，不是焊在工具名里的。 */
export const searchTool: RegisteredTool<{ query: string; path?: string }> = defineTool<{
  query: string;
  path?: string;
}>({
  id: "search",
  description: P("search"),
  input: {
    type: "object",
    properties: {
      query: { type: "string", description: "Term to search (character / setting / term)" },
      path: {
        type: "string",
        description: "Optional project-relative prefix to scope the search: design/ or chapters/. Omit for the whole project.",
      },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    return { output: await ctx.searchDocs(args.query, (args.path ?? "").trim()) };
  },
});

export const READ_TOOLS: RegisteredTool[] = [readTool, listTool, searchTool];
