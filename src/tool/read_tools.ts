/**
 * read-tools：项目语料的读口 `read`——给路径要内容（整篇或某一小节）。
 * 按项目相对路径寻址，与 `write` / `edit` / `delete` 同一套口径，所以 `read` 读得到章节。
 * 找路径用 `find_tools` 的 `glob`，找内容用它的 `grep`；这里只负责"读一份"。
 *
 * 取数在 `storage/corpus.ts`；本文件只加"工具边界"的预算（§11.3：先截断，后压缩）。
 *
 * 边界：一句 fs 都不碰（有结构测试钉着）。
 */
import type { ToolContext } from "../core/types";
import { hashText } from "../core/hash";
import { getSection, listHeadings } from "../framework/markdown";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** 单次 read 的上限（字符）。压缩不为工具输出擦屁股，截断先在这一层发生。 */
const READ_LIMIT = 12_000;

/**
 * 路径所属的那一段（`design/core.md` → `design/`），"没找到"时用它列出那一段有什么；
 * 认不出根（模型给了个裸文件名）→ 整个项目，反正它更需要看全貌。
 */
function rootOf(path: string): string {
  const i = path.indexOf("/");
  return i > 0 ? `${path.slice(0, i)}/` : "";
}

/**
 * 文档不存在时的文案：它是给模型的路由线索，"可用：…"让模型知道该写哪一份，
 * 所以带上清单，而不是只说一句"找不到"。
 */
async function notFound(ctx: ToolContext, path: string): Promise<string> {
  return `没有找到文档 ${path}。可用：\n${await ctx.listIndex(rootOf(path))}`;
}

function revOf(content: string): string {
  return hashText(content).slice(0, 6);
}

/** 超长文档的目录式回答：小节索引 + 首段，细节用 section / offset 再读。 */
function truncatedIntro(path: string, content: string, rev: string): string {
  const heads = listHeadings(content, 2).filter((h) => h.level === 2);
  const first = content.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p !== "") ?? "";
  const lines = [
    `# ${path} @${rev}（共 ${content.length} 字，已截断）`,
    heads.length ? "小节索引（用 section=… 读某一节）：" : "（没有二级小节；用 offset=… 分段读全文）",
    ...heads.map((h) => `- ${h.title}`),
    "",
    "首段：",
    first.slice(0, 800),
    "",
    `用 section=<小节名> 读某一节，或用 offset=<字符数> 继续读全文。`,
  ];
  return lines.join("\n");
}

export const readTool: RegisteredTool<{ path: string; section?: string; offset?: number }> = defineTool<{
  path: string;
  section?: string;
  offset?: number;
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
      offset: {
        type: "number",
        description:
          "Optional: character offset to continue from when a document or section was truncated",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const content = await ctx.readDoc(args.path);
    if (content === undefined) return { output: await notFound(ctx, args.path) };
    const rev = revOf(content);

    if (args.section) {
      const s = getSection(content, args.section);
      if (!s.found) {
        return {
          output: `文档 ${args.path} 里没有小节「${args.section}」。可用小节：\n${(s.available ?? []).join("\n")}`,
        };
      }
      const block = s.block ?? "";
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const slice = block.slice(offset, offset + READ_LIMIT);
      const rest = block.length - (offset + slice.length);
      const lines = [`# ${args.path} › ${args.section} @${rev}（本节约 ${block.length} 字）`];
      if (offset > 0) lines.push(`（从第 ${offset} 字起）`);
      lines.push(slice);
      if (rest > 0) lines.push("", `此节还有 ${rest} 字，用 offset=${offset + slice.length} 继续。`);
      return {
        output: lines.join("\n"),
        metadata: { path: args.path, section: args.section, rev, chars: block.length, offset },
      };
    }

    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    if (content.length > READ_LIMIT || offset > 0) {
      const slice = content.slice(offset, offset + READ_LIMIT);
      const rest = content.length - (offset + slice.length);
      const head = offset === 0 && content.length > READ_LIMIT
        ? truncatedIntro(args.path, content, rev)
        : `# ${args.path} @${rev}（从第 ${offset} 字起，共 ${content.length} 字）\n${slice}`;
      return {
        output: rest > 0 ? `${head}\n\n全文还有 ${rest} 字，用 offset=${offset + slice.length} 继续。` : head,
        metadata: { path: args.path, rev, chars: content.length, offset },
      };
    }

    return {
      output: `# ${args.path} @${rev}\n${content}`,
      metadata: { path: args.path, rev, chars: content.length },
    };
  },
});

export const READ_TOOLS: RegisteredTool[] = [readTool];