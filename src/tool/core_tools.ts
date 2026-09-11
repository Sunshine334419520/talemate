/**
 * core-tools：委派/知识/人机交互类工具（task / skill / ask-user / confirm / save-chapter）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt；execute 只用 ctx 原语。
 */
import { confirmBody } from "../framework/design_ops";
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
      agent: { type: "string", description: "Subagent id (see the delegable list below)" },
      prompt: { type: "string", description: "Complete task description for the subagent; include all needed material/slices" },
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
    properties: { name: { type: "string", description: "Skill name" } },
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
      question: { type: "string", description: "The creative question to ask the user" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional choices for a quick pick (max 4)",
      },
    },
    required: ["question"],
  },
  async execute(args, ctx) {
    const question = args.question?.trim();
    if (!question) {
      return { output: `ask-user 缺少必填 question（收到：${JSON.stringify(args).slice(0, 200)}）——请用合法 JSON 带 question 重新调用。` };
    }
    const answer = await ctx.askUser(question, args.options);
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
      action: { type: "string", description: "Action name, e.g. rewrite design/core.md / delete character 林晚" },
      summary: { type: "string", description: "Impact summary shown to the user" },
    },
    required: ["action", "summary"],
  },
  async execute(args, ctx) {
    if (!args.action?.trim() || !args.summary?.trim()) {
      return { output: `confirm 缺少 action/summary（收到：${JSON.stringify(args).slice(0, 200)}）——请带完整字段重新调用。` };
    }
    const ok = await ctx.confirm(args.action.trim(), args.summary.trim());
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
      filename: { type: "string", description: "Filename incl. .md" },
      content: { type: "string", description: "Full content" },
    },
    required: ["filename", "content"],
  },
  // confirm 在 execute 里做：落盘前把正文摆给用户看（渲染器复用 design_ops 那一份）
  async execute(args, ctx) {
    const ok = await confirmBody(
      ctx,
      `落盘 chapters/${args.filename}`,
      `正文 ${args.content.length} 字。`,
      "将写入的内容",
      args.content,
    );
    if (!ok) return { output: `用户已拒绝落盘 chapters/${args.filename}` };
    const file = await ctx.saveChapter(args.filename, args.content);
    return { output: `已保存 ${file}`, metadata: { file } };
  },
});

export const CORE_TOOLS: RegisteredTool[] = [skillTool, taskTool, askUserTool, confirmTool, saveChapterTool];
