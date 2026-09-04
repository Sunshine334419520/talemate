/**
 * 内置工具定义。execute 只用 ctx（ToolContext 由 session 注入实现），保持纯声明、可测。
 */
import { defineTool, type RegisteredTool } from "./index";

/** read_doc：读 docs/ 下某文档（含 .md），不存在返回 undefined 提示 */
export const readDocTool: RegisteredTool<{ name: string }> = defineTool<{ name: string }>({
  id: "read_doc",
  description:
    "读取项目里的一个文档内容。name 用文件名（core.md / world.md / characters.md / outline.md…，含 .md）。动手前先 list_docs 看有哪些材料。",
  input: {
    type: "object",
    properties: { name: { type: "string", description: "文档文件名，含 .md" } },
    required: ["name"],
  },
  async execute(args, ctx) {
    const content = await ctx.readDoc(args.name);
    if (content === undefined) return { output: `没有找到文档 ${args.name}。可用：\n${await ctx.listDocs()}` };
    return { output: `# ${args.name}\n${content}`, metadata: { name: args.name } };
  },
});

/** write_doc：写/覆盖 docs/ 下文档。破坏性 → needsConfirm 由 session 先问用户 */
export const writeDocTool: RegisteredTool<{ name: string; content: string }> = defineTool<{
  name: string;
  content: string;
}>({
  id: "write_doc",
  description:
    "写或覆盖 docs/ 下的一个设定文档（core/world/characters/outline…）。content 是完整新文档内容，不是补丁；写前先 read_doc 读当前版本，全文重写后覆盖。",
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "文档文件名，含 .md" },
      content: { type: "string", description: "完整文档正文" },
    },
    required: ["name", "content"],
  },
  needsConfirm(args) {
    return `覆盖 docs/${args.name}（${args.content.length} 字）`;
  },
  async execute(args, ctx) {
    const old = await ctx.readDoc(args.name);
    const file = await ctx.writeDoc(args.name, args.content);
    const diff = old === undefined ? "(新建)" : `(旧 ${old.length} 字 → 新 ${args.content.length} 字)`;
    return { output: `已保存 ${file} ${diff}` };
  },
});

/** list_docs：列 docs/ */
export const listDocsTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "list_docs",
  description: "列出项目里已有的设定文档（docs/）。动手前先看有哪些材料。",
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    return { output: await ctx.listDocs() };
  },
});

/** skill：按名注入知识包正文 */
export const skillTool: RegisteredTool<{ name: string }> = defineTool<{ name: string }>({
  id: "skill",
  description:
    "加载一个 skill 的完整正文（文风卡/技法等）进当前对话。name 用 available_skills 里的名字。",
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

/** task：委派 subagent（子会话隔离上下文，只传 prompt） */
export const taskTool: RegisteredTool<{ agent: string; prompt: string }> = defineTool<{
  agent: string;
  prompt: string;
}>({
  id: "task",
  description:
    "把一件事委派给一个 subagent 去做（planner 节拍规划 / writer 写正文等）。子代理在独立上下文里执行，只收到你的 prompt，做完返回正文/成品文本。适合'把这一章展开成节拍''照这个细纲写第 N 章正文'这类需要专注的活。",
  input: {
    type: "object",
    properties: {
      agent: { type: "string", description: "子代理 id：planner / writer" },
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

/** ask_user：向用户要创作决策（非审批），返回答案文本给模型继续 */
export const askUserTool: RegisteredTool<{ question: string; options?: string[] }> = defineTool<{
  question: string;
  options?: string[];
}>({
  id: "ask_user",
  description:
    "向用户提一个创作上的问题（要设定/要裁决/要取舍）。问题要具体、给默认倾向；用户回答后你会拿到答案继续。不要滥用——能自己合理默认的就别问。",
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

/** save_chapter：写手把成品/规划落 chapters/ */
export const saveChapterTool: RegisteredTool<{ filename: string; content: string }> = defineTool<{
  filename: string;
  content: string;
}>({
  id: "save_chapter",
  description:
    "把一段成品（正文或规划）存进 chapters/。filename 遵循命名规约（chapter_ch001_v1.md / plan_ch001.md）。正文很长时用它落盘，避免一次性吐回主编。",
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

/** confirm：给模型一个显式"落盘前征求主编确认"的动作入口 */
export const confirmTool: RegisteredTool<{ action: string; summary: string }> = defineTool<{
  action: string;
  summary: string;
}>({
  id: "confirm",
  description:
    "在做一个不可轻易反悔的动作（覆盖设定/落盘正文）前，向用户确认。给出简短 action 与影响摘要。",
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

/** 默认注册工具集 */
export const BUILTIN_TOOLS = [
  readDocTool,
  writeDocTool,
  listDocsTool,
  skillTool,
  taskTool,
  askUserTool,
  saveChapterTool,
  confirmTool,
];
