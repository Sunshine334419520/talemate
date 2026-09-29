/**
 * research-tools：考据本的两个动词——**`recall` 翻，`remember` 记**。
 *
 * 这本账是 `researcher` 自己的（`.talemate/research/`，见 `storage/notes.ts`）。它挂在**研究这一层**，
 * 不塞进 `websearch` / `webfetch`：联网工具是薄壳，把"这条查过没有"的判断塞进去，它们就不再是
 * "给定参数就给结果"的东西了；而"要不要重查"本来就是判断，归模型。
 *
 * ## 两个工具的守卫是不对称的，而且刻意如此
 *
 * - `remember` **三重上锁**：不在别人的白名单里、`notes` 为 `deny` 时从 schema 里消失、runner 还有
 *   一道粗粒度兜底。写是在改东西，就该这么锁。
 * - `recall` **没有 `permission`**（读不改世界，同 `read` / `list` / `search`）。代价要说清楚：
 *   `runner` 的兜底是 `if (tool.permission && …)`，没有 `permission` 这条就是死代码——**它挡不住
 *   被幻觉调出来的 `recall`，而且将来想"某个模式下禁掉它"也没有把手**。所以圈定必须是结构性的：
 *   目录由 `projectId` 推死、**不收任何路径参数**、题目在读侧也过校验。
 *   `tests/framework.test.ts` 有一条钉住"这个缺席是故意的"——否则下一个人会为了对称给它加上。
 */
import { hasSource, noteName, recallText, saveNote, sourceProblem } from "../framework/research";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** recall：翻考据本。带 query 找，不带 query 要目录。 */
export const recallTool: RegisteredTool<{ query?: string }> = defineTool<{ query?: string }>({
  id: "recall",
  description: P("recall"),
  input: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Words to look for in the notes' titles and bodies. Omit to list what is already recorded.",
      },
    },
  },
  async execute(args, ctx) {
    return { output: await recallText(ctx.projectId, args.query) };
  },
});

/** remember：记一条结论。同名即覆盖（重查之后换掉旧结论走的也是这条路）。 */
export const rememberTool: RegisteredTool<{ name: string; content: string }> = defineTool<{
  name: string;
  content: string;
}>({
  id: "remember",
  description: P("remember"),
  permission: "notes",
  input: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Short title for the topic, without file extension. Reuse an existing note's exact title to replace that note.",
      },
      content: {
        type: "string",
        description:
          "The note body: the conclusion, where sources disagree, what could not be confirmed — with the source URLs.",
      },
    },
    required: ["name", "content"],
  },
  async execute(args, ctx) {
    const raw = (args.name ?? "").trim();
    const content = (args.content ?? "").trim();
    if (!raw || !content) {
      return {
        output: `remember 缺少 name/content（收到：${JSON.stringify(args).slice(0, 200)}）——请带完整字段重新调用。`,
      };
    }
    // 题目先归一（`safeNoteName` 是"原样通过"，防止静默改名），再查出处。两条都是模型自己能改的错，
    // 所以走 return 而不是 throw。
    const named = noteName(raw);
    if ("problem" in named) return { output: named.problem };
    if (!hasSource(content)) return { output: sourceProblem() };

    const verdict = await ctx.ask({
      permission: "notes",
      pattern: named.name,
      always: "*",
      summary: `记一条研究笔记「${named.name}」`,
      detail: `正文 ${content.length} 字。`,
    });
    if (verdict === "deny") {
      return { output: "当前不允许记研究笔记（notes 被禁）。把结论直接交回给写作搭档。" };
    }
    if (verdict === "reject") return { output: "用户已拒绝记下这条研究笔记。" };

    const { date, replaced } = await saveNote(ctx.projectId, named.name, content);
    return replaced === undefined
      ? { output: `已记下研究笔记「${named.name}」（查于 ${date}）。`, metadata: { note: named.name } }
      : {
          // 必须让模型看见自己**替换**了东西：旧结论是从此不再服务的那一版。
          output: `已用新的结论替换研究笔记「${named.name}」（原查于 ${replaced}，新查于 ${date}）。`,
          metadata: { note: named.name, replaced },
        };
  },
});

export const RESEARCH_TOOLS: RegisteredTool[] = [recallTool, rememberTool];
