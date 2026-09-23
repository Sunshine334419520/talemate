/**
 * file-tools：**改文件的两个面**——`write`（整篇）与 `edit`（局部）。
 *
 * 它们是同一件事的两个面，分开是因为**意图与安全性质不同**：
 *
 *   write  「这份文件整个是我的」——模型是作者，整篇给。旧文件不在场也能写（新建）。
 *   edit   「我在动它的一部分」——模型给锚点（原文片段）与替换文本，其余字节原样。
 *
 * 合并成一个工具就得靠"哪个参数给没给"来分辨，schema 对模型来说是含糊的；opencode 也是分开的，
 * 且它的 edit 明确拒绝在已存在的文件上用空锚点（"use write for a full-file replacement"）。
 *
 * **两者都不自己落盘**：拼出 `FileOp` 交给 `framework/write_ops.ts` 那条唯一路径。所以
 * 校验、权限、CAS、原子写、diff 全在那一处，这里只剩"语义 + 入参 + 成功文案"。
 *
 * 可写的根只有 design/ 与 chapters/；某个 agent 能碰哪一个由权限表划（见 agent/registry.ts）。
 */
import { writeFile } from "../framework/write_ops";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/**
 * 回给模型的 diff 预览。**要有上限**：一次整节重写的 diff 能有几百行，全灌回去等于让模型
 * 重读一遍它自己刚写的东西。
 */
function preview(diff: string, maxLines = 24): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  return [...lines.slice(0, maxLines), `…（另有 ${lines.length - maxLines} 行，略）`].join("\n");
}

/** write：整篇写/覆盖（新建或整体替换）。 */
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
 * edit：改文件里的一段。**给它锚点，不给它整篇。**
 *
 * 与 `write` 的分别不是"大小"，是**你手里有没有那份文件的权威全文**：
 * 有 → write（你就是作者）；没有、只知道要改哪一段 → edit（锚点式，模糊匹配兜住复制粘贴的偏差）。
 *
 * 所以它更便宜也更安全：用户要审的是那一小段 diff，而不是再读一遍整篇文档。
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
    // 模糊命中要说出来：精确命中时模型给的原文与文件一字不差；不模糊时它可能差在缩进/引号上，
    // 而那意味着"模型以为改的那一段"未必就是"实际改的那一段"——所以**把真实命中回给它**，
    // 让它自己核对（这也是 opencode 把 diff 回给模型的目的，只是这里给的是实际换掉的那段）。
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
 * delete：删掉**一份文件**——设计文档、角色卡、章节，同一条路。
 *
 * 它比"一个删文件的工具"多做一件事，而那正是它存在的理由：**删之前把"这个名字还在哪儿出现"
 * 摆到用户眼前**。删一个角色/一个术语，影响面不在那份文件里——`core.md`、卷纲、好几章正文里
 * 都可能提着它。看不见那个影响面，用户就没法判断"要不要一起清"。
 *
 * **但它不替你做级联。** 该不该动 `world.md` 里那句话、该不该改 `outline/vol_2.md` 里的登场安排，
 * 是判断不是机械操作：工具做不了，模型做得了。所以这里的职责到"把影响面摆出来"为止，清理由模型
 * 用 `edit` 逐处做（见 `prompts/tools/delete.txt`）。
 *
 * 局部删除（删一个段落、一节）**不在这里**——那是 `edit`，把那段原文换成空。
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
    // 引用检查只覆盖 design/（chapters/ 的搜索还没通，见 docs/roadmap.md 的「章节读不回来」）
    const refs =
      `引用检查「${term}」——删它之前先看这个名字还在哪儿出现；` +
      `有命中就自己判断要不要用 edit 一并清理，别留悬空引用：\n${await ctx.searchDesigns(term)}`;

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
