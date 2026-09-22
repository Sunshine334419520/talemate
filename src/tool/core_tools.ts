/**
 * core-tools：委派/知识/人机交互类工具（task / skill / ask-user / confirm / save-chapter / propose-plan）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt；execute 只用 ctx 原语。
 */
import { PLAN_KEY } from "../core/types";
import { askWrite, writeBlocked } from "../framework/design_ops";
import { renderPlan } from "../framework/proposal";
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
  permission: "delegate",
  async execute(args, ctx) {
    const verdict = await ctx.ask({
      permission: "delegate",
      pattern: args.agent,
      always: "*",
      summary: `委派 ${args.agent} 子代理执行`,
      detail: `prompt ${args.prompt.length} 字。`,
    });
    if (verdict === "deny") {
      return { output: `当前不允许委派子代理（${args.agent}）。若是计划模式挡住了，先 exit-plan。` };
    }
    if (verdict === "reject") return { output: `用户已拒绝委派 ${args.agent}。` };

    // 写正文这一支还有**硬门**：用户没拍板过这一章的节拍就不放行。它和 apply-design 是同一套机制——
    // propose-* 登记 → harness 按用户回话置 approved → 执行工具查它。门开在"执行"这一头而不是给
    // 整个会话加个模式，是为了让设计流程与正文流程共用一种"用户拍板"的语义。
    if (args.agent === "writer") {
      const plan = ctx.getProposal(PLAN_KEY);
      if (!plan?.approved) {
        return {
          output:
            "还没到写正文的时候：没有一份用户已拍板的节拍。先把这一章的节拍写出来，用 propose-plan 摆给" +
            "用户看、等他回话；他认可之后再调 task(writer)，把切片和节拍一起放进 prompt。",
        };
      }
    }
    const result = await ctx.runSubagent(args.agent, args.prompt);
    // 一次批准 = 一次写作：用掉就清，免得写下一章时凭一份旧批准就开写。
    if (args.agent === "writer") ctx.clearProposal(PLAN_KEY);
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
  permission: "question",
  async execute(args, ctx) {
    const question = args.question?.trim();
    if (!question) {
      return { output: `ask-user 缺少必填 question（收到：${JSON.stringify(args).slice(0, 200)}）——请用合法 JSON 带 question 重新调用。` };
    }
    // 这一个是"由我决定要不要开口问"，不是权限系统替你问——所以只求值、不弹窗
    // （否则会先弹一句"允许提问吗"，再弹真正的问题）。
    if (ctx.check("question", "*") === "deny") {
      return { output: "当前不允许打断用户（子代理不在场，或模式禁了提问）——把问题留在返回值里带回去。" };
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
  permission: "question",
  async execute(args, ctx) {
    if (!args.action?.trim() || !args.summary?.trim()) {
      return { output: `confirm 缺少 action/summary（收到：${JSON.stringify(args).slice(0, 200)}）——请带完整字段重新调用。` };
    }
    if (ctx.check("question", "*") === "deny") {
      return { output: "当前不允许打断用户（子代理不在场，或模式禁了提问）。" };
    }
    const reply = await ctx.confirm(args.action.trim(), args.summary.trim());
    return reply === "no"
      ? { output: `用户已拒绝：${args.action}` }
      : { output: `用户已确认：${args.action}` };
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
  permission: "edit",
  async execute(args, ctx) {
    // 走同一道权限口（渲染器复用 design_ops 那一份）——chapters/ 的文件名就是 pattern
    const verdict = await askWrite(ctx, {
      pattern: `chapters/${args.filename}`,
      action: `落盘 chapters/${args.filename}`,
      meta: `正文 ${args.content.length} 字。`,
      label: "将写入的内容",
      body: args.content,
    });
    if (verdict !== "allow") return { output: writeBlocked(verdict, `落盘 chapters/${args.filename}`) };
    const file = await ctx.saveChapter(args.filename, args.content);
    return { output: `已保存 ${file}`, metadata: { file } };
  },
});

/**
 * propose-plan：把**这一章**的节拍摆给用户拍板，并**结束本回合**等他回话。
 *
 * **与 propose-design 的区别：没有 apply 那一半。** 节拍不落盘——它批准的是**动作**（去写正文），
 * 不是一份文档。所以这里不登记提案、不留 base 快照、不判"同意"：用户说"没问题"之后，mate 直接
 * 带着这份节拍去 `task(writer)`。用户要改 → 改完再摆一次，这是个循环。
 *
 * `halt` 是它存在的全部理由：光靠纪律，mate 可能拿着没批准的节拍直接叫 writer。而"摆出来就停"
 * 正是计划模式里 ExitPlanMode 干的事——这里不要 mode（`design-docs.md` 明确否决过阶段状态机），
 * 只要一个会停的工具。
 */
export const proposePlanTool: RegisteredTool<{ content: string; chapter?: string }> = defineTool<{
  content: string;
  chapter?: string;
}>({
  id: "propose-plan",
  description: P("propose-plan"),
  halt: true, // 计划摆出来了，接下来该用户拍板——不靠模型自觉
  input: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The beat plan itself — what the user reviews and what the writer will follow. Plan text only: no notes to the user, no rationale, no questions.",
      },
      chapter: {
        type: "string",
        description: "Short label for the header, e.g. 第 1 章 / 序章. Optional.",
      },
    },
    required: ["content"],
  },
  async execute(args, ctx) {
    const content = (args.content ?? "").trim();
    // **这里必须 throw，不能 return**：runner 对任何 return 都置 halt，return 一个校验错误等于
    // 把回合停在一个本可自愈的错误上。throw 会变成 error part，模型同轮就能补上重调。
    // （`tests/framework.test.ts` 的 "tool runner · halt" 钉的就是这条。）
    if (!content) {
      throw new Error(
        `propose-plan 缺少 content（收到：${JSON.stringify(args).slice(0, 200)}）——请带这一章的节拍正文重新调用。`,
      );
    }
    // 登记成"待执行的节拍"。**只在会话内存里，不落盘**——用户回话后由 harness 置 approved，
    // task(writer) 靠它判断"这一章用户拍过板了没有"。改了内容重新提案即覆盖，approved 归零。
    ctx.setProposal({
      name: PLAN_KEY,
      content,
      chapter: args.chapter?.trim() || undefined,
      approved: false,
      at: Date.now(),
    });
    ctx.showProposal(renderPlan(args.chapter, content));
    // 计划出来了，模式就该退——它管的是"还没计划好之前别乱动"。批准与否由下面那条登记表达，
    // 不靠模式（模式只是纪律，硬门在 task(writer) 上）。
    ctx.setMode(undefined);
    return {
      output:
        "节拍已摆给用户（尚未写任何正文）。本回合已结束，等用户回话：认可 → 带这份节拍 task(writer)；" +
        "要改 → 改完再 propose-plan 一次（改了内容必须重新摆）。",
      metadata: { chapter: args.chapter },
    };
  },
});

/**
 * enter-plan / exit-plan：会话模式的进出口（见 `agent/modes.ts`）。
 *
 * **模式的边界感全在这两个工具上**：它必须有始有终，所以进入之后只有两条路——`propose-plan`
 * 成功（正常路径，自动退出）、或者 `exit-plan`（用户改主意不做了）。没有第二条会把 mate
 * 关在"能读能问、但派不了活"的笼子里。
 *
 * 进入不弹 confirm：用户刚说了"写第 1 章"，再问一句"要不要先规划"是噪音。
 */
export const enterPlanTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "enter-plan",
  description: P("enter-plan"),
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    ctx.setMode("plan");
    return { output: "已进入计划模式（task 起不可用）。做出计划后用 propose-plan 摆给用户拍板。" };
  },
});

/** exit-plan：用户改主意不做了 → 离开计划模式。正常路径不需要它（propose-plan 会退出）。 */
export const exitPlanTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "exit-plan",
  description: P("exit-plan"),
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    ctx.setMode(undefined);
    return { output: "已离开计划模式。" };
  },
});

export const CORE_TOOLS: RegisteredTool[] = [
  skillTool,
  taskTool,
  askUserTool,
  confirmTool,
  saveChapterTool,
  proposePlanTool,
  enterPlanTool,
  exitPlanTool,
];
