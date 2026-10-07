/**
 * file-tools：改文件的两个面——`write`（整篇）与 `edit`（局部），分开是因为意图与安全性质不同：
 *   write  「这份文件整个是我的」——模型是作者，整篇给，旧文件不在场也能写（新建）
 *   edit   「我在动它的一部分」——模型给锚点（原文片段）与替换文本，其余字节原样
 * 合并成一个就得靠"哪个参数给没给"分辨，schema 对模型是含糊的。两者都不自己落盘，拼出 `FileOp`
 * 交给 `framework/write_ops.ts` 那条唯一路径（校验、权限、CAS、原子写、diff 都在那里）；可写的根
 * 是作品的三个根（design / chapters / state，见 core/config.ts），能碰哪一个由权限表划。
 */
import { writeFile } from "../framework/write_ops";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/**
 * 回给模型的 diff 预览要有上限：一次整节重写的 diff 能有几百行，全灌回去等于让模型重读一遍
 * 它自己刚写的东西。
 */
function preview(diff: string, maxLines = 24): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  return [...lines.slice(0, maxLines), `…（另有 ${lines.length - maxLines} 行，略）`].join("\n");
}

export const writeTool: RegisteredTool<{ path: string; content: string }> = defineTool<{
  path: string;
  content: string;
}>({
  id: "write",
  description: P("write"),
  permission: "edit",
  input: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Project-relative path: design/<...> (design docs) or chapters/<...> (finished prose)",
      },
      content: { type: "string", description: "The complete file content, byte for byte" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const r = await writeFile(ctx, {
      via: "confirm",
      op: { kind: "write", path: args.path, content: args.content },
      action: `写入 ${args.path}`,
    });
    if (!r.ok) return { output: r.output };
    const what = r.isNew ? "新建" : `改写（+${r.additions} / -${r.deletions} 行）`;
    return { output: `已${what} ${r.path}`, metadata: { file: r.path } };
  },
});

/**
 * edit：改文件里的一段——给它锚点，不给整篇。与 `write` 的分别不是"大小"，是你手里有没有那份
 * 文件的权威全文：有 → write（你就是作者），没有、只知道要改哪一段 → edit（模糊匹配兜住复制
 * 粘贴的偏差）。所以它更便宜也更安全，用户审的是那一小段 diff，而不是再读一遍整篇文档。
 */
export const editTool: RegisteredTool<{ path: string; find: string; replace: string; all?: boolean }> = defineTool<{
  path: string;
  find: string;
  replace: string;
  all?: boolean;
}>({
  id: "edit",
  description: P("edit"),
  permission: "edit",
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative path to an existing file: design/<...> or chapters/<...>" },
      find: { type: "string", description: "The exact text to replace, with enough context to be unique" },
      replace: { type: "string", description: "The text to put in its place; must differ from find" },
      all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default false)" },
    },
    required: ["path", "find", "replace"],
  },
  async execute(args, ctx) {
    const r = await writeFile(ctx, {
      via: "confirm",
      op: { kind: "replace", path: args.path, find: args.find, replace: args.replace, all: args.all },
      action: `改写 ${args.path}`,
    });
    if (!r.ok) return { output: r.output };
    // 模糊命中要说出来：模型给的原文不是逐字命中时，"它以为改的那段"未必是实际改的那段，
    // 所以把真实命中回给它自己核对
    const fuzzy = r.match !== undefined && r.match !== "exact";
    return {
      output: [
        `已改写 ${r.path}（${r.count ?? 1} 处，+${r.additions} / -${r.deletions} 行）`,
        "```diff",
        preview(r.diff),
        "```",
        fuzzy ? `注意：这次是按「${r.match}」模糊匹配到的，不是逐字命中——请核对上面换掉的是你想改的那一段。` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { file: r.path, match: r.match, count: r.count },
    };
  },
});

/** 文件名去掉目录与扩展名——引用检查的缺省术语（`design/characters/林晚.md` → `林晚`）。 */
function stemOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

/**
 * delete：删掉一份文件——设计文档、角色卡、章节同一条路。它比"一个删文件的工具"多做一件事：
 * 删之前把"这个名字还在哪儿出现"送到用户眼前，因为影响面不在那份文件里（`core.md`、卷纲、好几章
 * 正文里都可能提着它），看不见就没法判断要不要一起清。但它不替你做级联——该不该动哪一句是判断
 * 不是机械操作，所以职责到"列出影响面"为止，清理由模型用 `edit` 逐处做；局部删除也走 `edit`。
 */
export const deleteTool: RegisteredTool<{ path: string; term?: string }> = defineTool<{
  path: string;
  term?: string;
}>({
  id: "delete",
  description: P("delete"),
  permission: "edit",
  input: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Project-relative path of the file to delete: design/<...> or chapters/<...>",
      },
      term: {
        type: "string",
        description:
          "Name to look up references by before deleting; defaults to the filename without its extension",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = args.path.trim();
    const term = args.term?.trim() || stemOf(path);
    // 引用检查覆盖整个项目（`path: ""` = 不设前缀）：章节正文里也会提到角色与设定名，
    // 只看 `design/` 会让模型删完之后留下悬空引用，而它压根不知道那些引用存在
    const refs =
      `引用检查「${term}」——删它之前先看这个名字还在哪儿出现；` +
      `有命中就自己判断要不要用 edit 一并清理，别留悬空引用：\n${await ctx.searchDocs(term, "")}`;

    const r = await writeFile(ctx, {
      via: "confirm",
      op: { kind: "delete", path },
      action: `删除 ${path}`,
      note: refs,
    });
    if (!r.ok) return { output: r.output };
    return { output: `已删除 ${path}（连同它的全部内容）`, metadata: { file: path } };
  },
});

export const FILE_TOOLS: RegisteredTool[] = [writeTool, editTool, deleteTool];
