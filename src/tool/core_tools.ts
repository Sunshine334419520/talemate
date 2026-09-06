/**
 * core-tools：委派/知识/人机交互类工具（task / skill / ask-user / confirm / save-chapter）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt；execute 只用 ctx 原语。
 */
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** task：委派 subagent（可派列表由 schemasFor 动态注入 description） */
export const taskTool: RegisteredTool<{ agent: string; prompt: string }> = defineTool<{
  agent: string;
  prompt: string;
}>({
  id: "task",
  description: P("task"),
  input: {
    type: "object",
    properties: {
      agent: { type: "string", description: "子代理 id（见下方可委派列表）" },
      prompt: { type: "string", description: "给子代理的完整任务说明，把所需材料/切片写全" },
    },
    required: ["agent", "prompt"],
  },
  needsConfirm(args) {
    return `委派 ${args.agent} 子代理执行（prompt ${args.prompt.length} 字）`;
  },
  async execute(args, ctx) {
    const result = await ctx.runSubagent(args.agent, args.prompt);
    return {
      output: `<task agent="${args.agent}" state="completed">\n<task_result>\n${result}\n</task_result>\n</task>`,
      metadata: { agent: args.agent },
    };
  },
});

/** skill：按名注入知识包正文 */
export const skillTool: RegisteredTool<{ name: string }> = defineTool<{ name: string }>({
  id: "skill",
  description: P("skill"),
  input: {
    type: "object",
    properties: { name: { type: "string", description: "skill 名" } },
    required: ["name"],
  },
  async execute(args, ctx) {
    const body = await ctx.loadSkill(args.name);
    if (body === undefined) return { output: `没有找到 skill：${args.name}` };
    return { output: `<skill_content name="${args.name}">\n${body}\n</skill_content>` };
  },
});

/** ask-user：向用户要创作决策（非审批），返回答案文本给模型继续 */
export const askUserTool: RegisteredTool<{ question: string; options?: string[] }> = defineTool<{
  question: string;
  options?: string[];
}>({
  id: "ask-user",
  description: P("ask-user"),
  input: {
    type: "object",
    properties: {
      question: { type: "string", description: "要问用户的创作问题" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "可选选项（供用户快速选，最多 4 个）",
      },
    },
    required: ["question"],
  },
  async execute(args, ctx) {
    const answer = await ctx.askUser(args.question, args.options);
    return { output: `用户回答：${answer}`, metadata: { answer } };
  },
});

/** confirm：给模型一个显式"落盘前征求主编确认"的动作入口 */
export const confirmTool: RegisteredTool<{ action: string; summary: string }> = defineTool<{
  action: string;
  summary: string;
}>({
  id: "confirm",
  description: P("confirm"),
  input: {
    type: "object",
    properties: {
      action: { type: "string", description: "动作名，如 覆盖 characters.md" },
      summary: { type: "string", description: "影响摘要，给用户看" },
    },
    required: ["action", "summary"],
  },
  async execute(args, ctx) {
    const ok = await ctx.confirm(args.action, args.summary);
    return ok ? { output: `用户已确认：${args.action}` } : { output: `用户已拒绝：${args.action}` };
  },
});

/** save-chapter：写手把成品/规划落 chapters/ */
export const saveChapterTool: RegisteredTool<{ filename: string; content: string }> = defineTool<{
  filename: string;
  content: string;
}>({
  id: "save-chapter",
  description: P("save-chapter"),
  input: {
    type: "object",
    properties: {
      filename: { type: "string", description: "文件名，含 .md" },
      content: { type: "string", description: "完整内容" },
    },
    required: ["filename", "content"],
  },
  needsConfirm(args) {
    return `落盘 chapters/${args.filename}（${args.content.length} 字）`;
  },
  async execute(args, ctx) {
    const file = await ctx.saveChapter(args.filename, args.content);
    return { output: `已保存 ${file}`, metadata: { file } };
  },
});

export const CORE_TOOLS: RegisteredTool[] = [skillTool, taskTool, askUserTool, confirmTool, saveChapterTool];
