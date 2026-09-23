/**
 * core-tools：委派/知识/人机交互类工具（task / skill / ask-user / confirm / propose-plan / enter-draft / exit-draft）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt；execute 只用 ctx 原语。
 *
 * **落盘的工具不在这里**。`save-chapter` 曾在这里，它只是"`write` 加一个写死的 chapters/ 前缀"——
 * 已删除，改由 `write` 承担，writer 的范围由权限表划（见 agent/registry.ts）。改文件的两个面在
 * `file_tools.ts`，走 `framework/write_ops.ts` 那条唯一路径。
 */
import { DRAFT_MODE } from "../agent/modes";
import { PLAN_KEY } from "../core/types";
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
      return { output: `当前不允许委派子代理（${args.agent}）。若是草稿模式挡住了，先 exit-draft。` };
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

/**
 * propose-plan：把**这一章**的节拍摆给用户拍板，并**结束本回合**等他回话。
 *
 * **与 propose-design 的区别：没有 apply 那一半。** 节拍不落盘——它批准的是**动作**（去写正文），
 * 不是一份文档。所以这里不登记提案、不留 base 快照、不判"同意"：用户说"没问题"之后，mate 直接
 * 带着这份节拍去 `task(writer)`。用户要改 → 改完再摆一次，这是个循环。
 *
 * `halt` 是它存在的全部理由：光靠纪律，mate 可能拿着没批准的节拍直接叫 writer。而"摆出来就停"
 * 正是草稿模式的出口干的事——这里不要阶段状态机（`design-docs.md` 明确否决过），只要一个会停的工具。
 *
 * **要先进草稿模式**：三向（接受 / 拒绝 / 提意见）只有那一条通道，不在里面就没有"提意见"这一路。
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
    // **本工具的每条自愈路径都必须 throw，不能 return**：runner 对任何 return 都置 halt，return
    // 一个校验错误等于把回合停在一个本可自愈的错误上。throw 会变成 error part，模型同轮就能补上重调。
    // （`tests/framework.test.ts` 的 "tool runner · halt" 钉的就是这条。）
    if (!content) {
      throw new Error(
        `propose-plan 缺少 content（收到：${JSON.stringify(args).slice(0, 200)}）——请带这一章的节拍正文重新调用。`,
      );
    }
    if (ctx.getMode() !== DRAFT_MODE) {
      throw new Error(notInDraft("把这一章的节拍摆出来"));
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
    // **不在这里退模式**：出口条件是"用户接受或拒绝"，由 harness 判（`session.verdictEffect`）。
    // 提意见是在模式里打转，退出去就等于把用户关在门外——他得重新进一次才能接着改。
    return {
      output:
        "节拍已摆给用户（尚未写任何正文）。本回合已结束，等用户回话：认可 → 带这份节拍 task(writer)；" +
        "要改 → 改完再 propose-plan 一次（改了内容必须重新摆）。",
      metadata: { chapter: args.chapter },
    };
  },
});

/**
 * 「你不在草稿模式里」的自愈文案。`propose-design` / `propose-plan` 共用——它们的前置是同一条，
 * 文案也该是同一条，否则模型会从两句不同的话里推出两条不同的规则。
 */
export function notInDraft(what: string): string {
  return (
    `还没进草稿模式——三向审阅（接受 / 拒绝 / 提意见）只有那一条通道，不在里面就摆不出东西。` +
    `请先 enter-draft，再${what}；用户接受或拒绝之后模式会自己退出。`
  );
}

/**
 * enter-draft / exit-draft：会话模式的进出口（见 `agent/modes.ts`）。
 *
 * **模式的边界感全在这两个工具上**：进入之后只有两条路——用户接受或拒绝（正常路径，模式自己退）、
 * 或者 `exit-draft`（用户改主意不做了）。没有第二条会把 mate 关在"能读能问、但派不了活"的笼子里。
 *
 * 进入不弹 confirm：用户刚说了"写第 1 章"，再问一句"要不要先规划"是噪音。
 */
export const enterDraftTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "enter-draft",
  description: P("enter-draft"),
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    ctx.setMode(DRAFT_MODE);
    return {
      output:
        "已进入草稿模式（落盘与委派都不可用）。把要审的东西准备好，用 propose-design 或 propose-plan 摆给用户；" +
        "他接受或拒绝之后模式自己退出，他提意见就留在模式里接着改。",
    };
  },
});

/** exit-draft：用户改主意不做了 → 离开草稿模式。正常路径不需要它（接受/拒绝会自己退）。 */
export const exitDraftTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "exit-draft",
  description: P("exit-draft"),
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    ctx.setMode(undefined);
    return { output: "已离开草稿模式。" };
  },
});

export const CORE_TOOLS: RegisteredTool[] = [
  skillTool,
  taskTool,
  askUserTool,
  confirmTool,
  proposePlanTool,
  enterDraftTool,
  exitDraftTool,
];
