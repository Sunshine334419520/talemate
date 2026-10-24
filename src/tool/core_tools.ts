/**
 * core-tools：委派/知识/人机交互类工具（task / skill / ask-user / confirm / propose-plan / enter-draft / exit-draft）。
 * 一工具一职责；description 在 prompts/tools/<id>.txt；execute 只用 ctx 原语。
 *
 * 改作品文档的工具不在这里，它们在 `file_tools.ts`，走 `framework/write_ops.ts` 那条唯一路径。
 * 唯一的例外是 `propose-plan`：它自己落盘规划工件，因为规划不是作品文档（不审 diff、不做 CAS、
 * 不进语料），落点是 `.talemate/plans/` 引擎工作区，而 `write_ops` 只认作品的三个根。
 */
import { DRAFT_MODE } from "../agent/modes";
import { PLAN_KEY } from "../core/types";
import type { AskOutcome, AskRecord } from "../core/types";
import { planDisplay, renderPlan, savePlan } from "../framework/plan";
import { readPrompt } from "../prompts";
import {
  parseAskArgs,
  renderAskResult,
  renderCancelledResult,
  renderPendingResult,
} from "../session/asks";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** task：委派 subagent；可派列表由 schemasFor 动态注入 description。 */
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

    // 写正文走普通 `write`（用户在 diff 上点头），不经过任何可挂门的工具；拍板这一环留在
    // `propose-plan` 的 `halt` 上——规划交出去，本回合就停。
    const result = await ctx.runSubagent(args.agent, args.prompt);
    return {
      output: renderTaskResult(args.agent, result.text, result.sessionId),
      metadata: { agent: args.agent, sessionId: result.sessionId, empty: result.text.trim() === "" },
    };
  },
});

/**
 * task 结果的回填文本。
 *
 * 空结果必须显式写成 `state="empty"`：把空串塞进 `<task_result>` 会让 mate 以为"它答了，只是没内容"，
 * 于是接着往下走。真实的成因通常是子代理跑满步数、最后一步还停在工具调用上（无正文可返回）。
 * 子会话 id 一并带上，轨迹与调试命令靠它找回那一次委派的完整过程。
 */
export function renderTaskResult(agent: string, result: string, sessionId?: string): string {
  const text = result.trim();
  const state = text === "" ? "empty" : "completed";
  const body =
    text === ""
      ? "（子代理没有返回任何结论——通常是用完了步数，或停在工具调用上没有收尾。缩小问题范围后重派，或自己查。）"
      : result;
  const session = sessionId === undefined ? "" : ` session="${sessionId}"`;
  return `<task agent="${agent}" state="${state}"${session}>\n<task_result>\n${body}\n</task_result>\n</task>`;
}

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

/**
 * ask-user：向用户要创作决策，不是审批——审批走 confirm。
 *
 * 一次 1–3 题，可以带选项、多选、自定义答案。`pending` 是这一轮先停、问题仍可回答，
 * 不是跳过更不是同意——所以它必须 halt；交付层负责在超时/稍后/中断时给出这个结局。
 */
type AskUserArgs = { questions?: unknown; timeout?: unknown };

export const askUserTool: RegisteredTool<AskUserArgs> = defineTool<AskUserArgs>({
  id: "ask-user",
  description: P("ask-user"),
  input: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description:
          "1–3 questions. Ask only what cannot be inferred from the project or the conversation. " +
          "A recommended option goes first and ends its label with （推荐）.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id for this question; echoed in the answer." },
            header: {
              type: "string",
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            question: { type: "string", description: "The specific question to ask the user, in their language." },
            options: {
              type: "array",
              description:
                "Optional choices. If you recommend one, put it first and end its label with （推荐）.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Short user-facing option label." },
                  description: {
                    type: "string",
                    description: "One sentence explaining the tradeoff or impact.",
                  },
                },
                required: ["label"],
              },
            },
            multi_select: {
              type: "boolean",
              description: "Whether the user may select more than one option. Defaults to false.",
            },
          },
          required: ["id", "question"],
        },
      },
      timeout: {
        type: "number",
        description:
          "Seconds to wait for the whole batch (default 120); omit unless the user specifies a duration. " +
          "Use -1 only when an answer is required before proceeding.",
      },
    },
    required: ["questions"],
  },
  permission: "question",
  async execute(args, ctx) {
    const parsed = parseAskArgs(args);
    if (!parsed.ok) return { output: parsed.error };
    // 这里只用 check 求值、不弹窗——ask 会先弹一句"允许提问吗"，再弹真正的问题
    if (ctx.check("question", "*") === "deny") {
      return { output: "当前不允许打断用户（子代理不在场，或模式禁了提问）——把问题留在返回值里带回去。" };
    }

    const outcome: AskOutcome = await ctx.askUser({
      callId: ctx.callId,
      questions: parsed.value.questions,
      timeoutMs: parsed.value.timeoutMs,
      signal: ctx.signal,
    });
    const record: AskRecord = {
      callId: ctx.callId,
      questions: parsed.value.questions,
      outcome: outcome.kind,
      ...(outcome.kind === "answered" ? { answers: outcome.answers } : {}),
      at: Date.now(),
    };

    if (outcome.kind === "answered") {
      return { output: renderAskResult(record), ask: record, metadata: { outcome: "answered", callId: ctx.callId } };
    }
    if (outcome.kind === "pending") {
      return {
        output: renderPendingResult(record),
        ask: record,
        halt: true,
        metadata: { outcome: "pending", callId: ctx.callId },
      };
    }
    return {
      output: renderCancelledResult(record),
      ask: record,
      halt: true,
      metadata: { outcome: "cancelled", callId: ctx.callId },
    };
  },
});

/** confirm：落盘前显式征求主编确认的动作入口——审批通道，对应用户的"可/否"。 */
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
 * propose-plan：把这一章的规划交给用户拍板，并 halt 结束本回合等他回话——不靠模型自觉，
 * 否则它可能拿着没批准的规划直接开写。没有 apply 那一半：批准的是执行（照它写正文），
 * 不是要落盘的文档——所以没有 enter-draft 前置，草稿模式只服务文档提案的三向审阅。
 */
export const proposePlanTool: RegisteredTool<{ chapter: number; content: string }> = defineTool<{
  chapter: number;
  content: string;
}>({
  id: "propose-plan",
  description: P("propose-plan"),
  halt: true,
  input: {
    type: "object",
    properties: {
      chapter: {
        type: "number",
        description:
          "The chapter this plan is for, as its number (3 for 第 3 章). It names the plan artifact and is how the user refers to the chapter.",
      },
      content: {
        type: "string",
        description:
          "The plan itself — what the user reviews and what you then execute. Plan text only: no notes to the user, no rationale, no questions.",
      },
    },
    required: ["chapter", "content"],
  },
  async execute(args, ctx) {
    const content = (args.content ?? "").trim();
    // 本工具带 halt，而 runner 对任何 return 都置 halt——所以自愈路径必须 throw，throw 变成 error part 后
    // 模型同轮就能重调；`tests/framework.test.ts` 的 "tool runner · halt" 钉着这条
    if (!content) {
      throw new Error(
        `propose-plan 缺少 content（收到：${JSON.stringify(args).slice(0, 200)}）——请带这一章的规划正文重新调用。`,
      );
    }
    const chapter = Number(args.chapter);
    if (!Number.isInteger(chapter) || chapter < 1) {
      throw new Error(
        `propose-plan 的 chapter 要是正整数（收到：${JSON.stringify(args.chapter ?? null).slice(0, 200)}）` +
          `——它回答"这是第几章"，规划工件按它命名。请带章号重新调用。`,
      );
    }
    // 先落盘、再登记、再摆给用户：工件是这次执行的凭据
    const path = await savePlan(ctx.projectId, chapter, content);
    // 登记成待执行的规划；approved 由 harness 按用户回话置（模型自述无效），同一章再交一份即覆盖
    // 旧的那一份且 approved 归零——用户没见过新版就不算同意
    ctx.setProposal({
      name: PLAN_KEY,
      content,
      chapter,
      approved: false,
      at: Date.now(),
    });
    ctx.showProposal(renderPlan(chapter, content), planDisplay(chapter, content));
    return {
      output:
        `规划已交给用户（落在 ${path}，尚未写任何正文）。本回合已结束，等用户回话：` +
        "认可 → 照它把这一章的正文写出来；要改 → 改完再 propose-plan 一次（改了内容必须重新提交）。",
      metadata: { chapter, path },
    };
  },
});

/** 「你不在草稿模式里」的自愈文案，给 propose-design 用。 */
export function notInDraft(what: string): string {
  return (
    `还没进草稿模式——三向审阅（接受 / 拒绝 / 提意见）只有那一条通道，不在里面就提不出东西。` +
    `请先 enter-draft，再${what}；用户接受或拒绝之后模式会自己退出。`
  );
}

/**
 * enter-draft / exit-draft：会话模式的进出口（见 `agent/modes.ts`）。进入之后只有两条路：
 * 用户接受或拒绝（模式自己退）、或 exit-draft（用户改主意不做）——没有第三条把 mate 关在里面。
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
        "已进入草稿模式（落盘与委派都不可用）。把要审的那一版文档准备好，用 propose-design 交给用户；" +
        "他接受或拒绝之后模式自己退出，他提意见就留在模式里接着改。",
    };
  },
});

export const exitDraftTool: RegisteredTool<Record<string, never>> = defineTool<Record<string, never>>({
  id: "exit-draft",
  description: P("exit-draft"),
  input: { type: "object", properties: {} },
  async execute(_args, ctx) {
    ctx.exitDraft();
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
