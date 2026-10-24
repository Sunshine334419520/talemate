/**
 * Session：一个项目上下文里的会话。只做两件事——
 * 1) 持有会话状态（id/项目/角色/模型/IO）、落盘会话元、可中止；
 * 2) 当接线器：把 storage / LLM / 工具 / 上下文组装成 LoopDeps，交给 session/loop 的 runLoop 去跑。
 *
 * 循环本身在 loop.ts。消息读走内存缓存：一次 post() 里只有首次读盘，之后每次 append 同步 push 进内存。
 */
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../agent/registry";
import { DRAFT_MODE, MODES } from "../agent/modes";
import {
  BASE_PERMISSIONS,
  deriveSubagentPermission,
  evaluate,
  evaluateWithSource,
  fromConfig,
  mergeConfigs,
  visibleTools,
} from "../permission";
import { loadModelConfig } from "../core/config";
import { PLAN_KEY } from "../core/types";
import type { ModeDef } from "../agent/modes";
import type { Action, PermissionConfig, Rule, Ruleset } from "../permission";
import type {
  AgentDef,
  AskAnswer,
  AskOutcome,
  AskRequest,
  AssistantPart,
  ConfirmReply,
  LLMEvent,
  ModelConfig,
  PendingAskRecord,
  PendingProposal,
  ProjectMeta,
  StoredMessage,
  ToolCall,
  ToolContext,
} from "../core/types";
import { buildSystemPrompt, toNeutralMessages } from "../context/assemble";
import { buildResidentDesigns, buildIndex } from "../framework/anchor";
import { isChapterFile, planRelPath } from "../framework/plan";
import { buildProseBrief } from "../framework/prose";
import { labelOf } from "../framework/proposal";
import { renderHits } from "../framework/search";
import { chat } from "../llm/provider";
import type { NeutralMsg, ToolSchema } from "../llm/types";
import { discoverSkills, loadSkillByName, renderSkillCatalog } from "../skill/discovery";
import { loadProjectMeta, readProjectRules } from "../storage/project";
import { readDoc, scanDocs } from "../storage/corpus";
import { loadWebSettings } from "../storage/web_config";
import { dropFileCheckpointsFrom } from "../storage/file-history";
import {
  appendMessage,
  appendUsage,
  backupMessages,
  clearPendingAsk,
  createSession,
  loadMessages,
  loadModelWindow,
  loadPendingAsk,
  loadSessionMeta,
  savePendingAsk,
  truncateMessagesBefore,
} from "../storage/session-store";
import { BUILTIN_TOOLS } from "../tool";
import { ToolRegistry } from "../tool/registry";
import { executeToolPart } from "../tool/runner";
import {
  mergeJournalAsk,
  openAsks,
  renderAnswerMessage,
  renderOpenAskNote,
  settledCallIds,
  validateAnswers,
  type OpenAsk,
} from "./asks";
import { compact, isOverBudget } from "./compaction";
import { runLoop } from "./loop";
import { previewFileRewind, restoreFilesForRewind, type FileRewindOutcome, type FileRewindPreview } from "./rewind_files";

/** 用户交互口：CLI/TUI 提供；冒烟可用自动答复实现 */
export interface UserIO {
  onEvent(e: LLMEvent): void;
  /** `always` = 这一类以后都别问（进会话级 approved 表）。这个答复是权限系统唯一的记忆来源。 */
  confirm(action: string, summary: string): Promise<ConfirmReply>;
  /** answered 才带答案；pending 表示这一轮先停、问题仍可回答；cancelled 是拒绝/没有回答方 */
  askUser(req: AskRequest): Promise<AskOutcome>;
}

/**
 * 规则表的展示视图（`Session.permissionView` 的产物）。给两个外壳的 `/permissions` 用——
 * 它要回答"我配的那条生效没有"，所以除了结论还得有每一层各自贡献了什么。
 */
export interface PermissionView {
  agentName: string;
  modeTitle?: string;
  /** 子会话：规则由父会话派生，不是四层叠加 */
  derived: boolean;
  /** 顺序即优先级 */
  layers: { label: string; rules: Ruleset }[];
  /** 会话级 approved：用户说过「以后都允许」的规则 */
  approved: Ruleset;
}

/** 一份规则集的紧凑写法：`edit: *→ask  design/core.md→allow`。 */
function renderRuleset(rules: Ruleset): string {
  if (!rules.length) return "（无）";
  const byPerm = new Map<string, string[]>();
  for (const r of rules) {
    byPerm.set(r.permission, [...(byPerm.get(r.permission) ?? []), `${r.pattern}→${r.action}`]);
  }
  return [...byPerm].map(([p, list]) => `${p}: ${list.join("  ")}`).join("   ");
}

/**
 * 规则表渲染成文本——`/permissions` 在两个外壳里的输出都是它，一份实现。
 *
 * 先给结论（每类动作现在是什么、是哪一层定的），再给分层（每层贡献了什么）：只有结论不够用——
 * 用户配了一条想放宽、看到的却还是 deny，得能一眼看出是被模式盖住了（`deny` 单调，不受层级顺序影响）。
 *
 * `paint` 只给 CLI 上色用（终端能着色），界面不传。**动作类别取自 `BASE_PERMISSIONS` 的键**——
 * 那是这些类别的唯一定义处，不在这里再抄一份。
 */
export function renderPermissionView(
  view: PermissionView,
  paint: (action: Action) => string = (a) => a,
): string {
  const where = view.derived
    ? `${view.agentName}（子会话）`
    : `${view.agentName}${view.modeTitle ? ` · 模式：${view.modeTitle}` : " · 无模式"}`;
  const out: string[] = [`规则表 · ${where}`, "  现在（按 `*` 算；点名到具体文件的例外见「分层」）："];

  const sets = [...view.layers.map((l) => l.rules), view.approved];
  const labels = [...view.layers.map((l) => l.label), "会话已批准"];
  for (const p of Object.keys(BASE_PERMISSIONS)) {
    const { rule, layer } = evaluateWithSource(p, "*", ...sets);
    const from = layer < 0 ? "没有规则匹配 → 默认问" : labels[layer];
    out.push(`    ${p.padEnd(10)}${paint(rule.action)} ← ${from}`);
  }

  out.push("", `  ${view.derived ? "派生" : "分层"}（后写的优先；deny 例外——任何一层说不许就是不许）：`);
  for (const l of view.layers) out.push(`    · ${l.label} — ${renderRuleset(l.rules)}`);
  if (!view.derived) out.push(`    · 会话已批准 — ${renderRuleset(view.approved)}`);
  return out.join("\n");
}

/**
 * 自动 IO：一律放行（`once`，不写 approved——无人值守时不该替用户改规则）。
 * 提问没有回答方，必须 fail closed：返回 cancelled，而不是编一个答案继续。
 */
export const autoIO: UserIO = {
  onEvent() {},
  async confirm() {
    return "once";
  },
  async askUser(): Promise<AskOutcome> {
    return { kind: "cancelled", reason: "no-answerer" };
  },
};


/**
 * 用户这轮回话属于三向里的哪一种。
 *
 * 核心只认这三种结局，怎么问是交付层的事——今天在 REPL 里用文字问，将来 UI 用三个按钮，
 * 这一层不动。所以判定留在这里（harness），而不在工具里。
 */
export type DraftVerdict = "accept" | "reject" | "refine";

/**
 * 词表必须整句只由它们构成才算数——这是 fail-closed 的关键：
 * 「没问题，但第 3 格改成 X」夹着改动要求，匹配不上，于是走"提意见"那一路多绕一轮，
 * 而不是被当成同意把用户没认可的东西落下去。
 */
const AGREE_WORDS = "没问题|可以|行|好的|好|同意|确认|就这样|写吧|落盘|ok|okay|yes|y";
const REJECT_WORDS = "不行|不要|不用|不好|不对|算了|不了|先不|拒绝|取消|否|no|n";
const AGREE_CHAIN_RE = new RegExp(`^(?:(?:${AGREE_WORDS})[，,、。！!.…~\\s]*)+$`, "i");
const REJECT_CHAIN_RE = new RegExp(`^(?:(?:${REJECT_WORDS})[，,、。！!.…~\\s]*)+$`, "i");

/** 导出供测试。 */
export function isAgreement(text: string): boolean {
  return AGREE_CHAIN_RE.test(text.trim());
}

export function isRejection(text: string): boolean {
  return REJECT_CHAIN_RE.test(text.trim());
}

/** 三向判定。认不出的一律算"提意见"——留在模式里多走一轮，绝不误判成接受。 */
export function draftVerdict(text: string): DraftVerdict {
  const t = text.trim();
  if (AGREE_CHAIN_RE.test(t)) return "accept";
  if (REJECT_CHAIN_RE.test(t)) return "reject";
  return "refine";
}

/**
 * 这一种结局对协议状态意味着什么。规则单独拎成纯函数是为了能测——`Session.markPendingApproval`
 * 走 `post()`，一测就要打 LLM；突变留在 Session，规则在这里。
 *
 * `leaveDraft` 是接受或拒绝都退，不是"提案成功就退"：提意见是在模式里打转。
 */
export function verdictEffect(v: DraftVerdict): {
  approved: boolean;
  /** 拒绝了就把提案作废——留着的话 apply-design 还能把它落下去，而那正是用户刚说不的 */
  dropProposal: boolean;
  leaveDraft: boolean;
} {
  return { approved: v === "accept", dropProposal: v === "reject", leaveDraft: v !== "refine" };
}

/**
 * 这一次工具调用算不算"把规划里那一章的正文写下来了"——`Session.markPlanDone` 的判据。
 * 与 `verdictEffect` 同一个形状：策略是纯的，突变留在 Session 里。
 *
 * "执行完了没有"是结果，不是声明：模型说"我写完了"不算，章节文件真落地才算——同 `approved`
 * 由 harness 按用户回话判定，不由模型自述。
 */
export function writeSettlesPlan(plan: PendingProposal, call: ToolCall, ok: boolean): boolean {
  if (plan.name !== PLAN_KEY || !plan.approved || plan.done || plan.chapter === undefined) return false;
  if (!ok) return false;
  if (call.name !== "write" && call.name !== "edit") return false;
  const path = (call.input as { path?: unknown }).path;
  return typeof path === "string" && isChapterFile(path, plan.chapter);
}

/**
 * 未落盘提案的状态注入（进 system，每轮都有；纯函数，导出供测试）。
 * 让协议状态独立于消息历史——压缩会把 tool 消息折掉，`/open` 恢复后历史也可能被截。
 *
 * 分两段：`<pending-proposal>` 是"给用户看过、还没执行"的；`<settled-plan>` 是"执行过、还留在
 * 手边的规划"，它不是待办，但也不能不提——规划正文只活在 pending 里，工件在 `.talemate/plans/`，
 * `read` 够不着，用户随时可能说"改第 2 条"，mate 得先知道第 2 条是什么。
 */
export function renderPendingNote(pending: Map<string, PendingProposal>): string | undefined {
  if (!pending.size) return undefined;
  const open: string[] = [];
  const settled: string[] = [];
  for (const p of pending.values()) {
    // 规划没有要落盘的目标文档：它批准的是"照它去写正文"这个执行，不是一次落盘。
    // 工件路径要报出来：规划落在 `.talemate/plans/`，那是 `read` / `list` 看不见的地方，
    // 压缩之后 mate 仍得知道它存下来了（见 framework/plan.ts 的文件头）。
    if (p.name === PLAN_KEY) {
      const what = p.chapter ? `第 ${p.chapter} 章的规划（${planRelPath(p.chapter)}）` : "这一章的规划";
      // 正文一落盘就不再是待办——不分开的话，此后每一轮都会重复"照它执行"，而它早执行完了。
      if (p.done) {
        settled.push(`- ${what}：正文已落盘。用户要改哪一条，照规划里那一条直接改，不必重新提案`);
        continue;
      }
      const state = p.approved
        ? "用户已表示同意 → 立刻开始写这一章的正文（规范与文风已随本 system 交给你）；不要重新提案，不要先解释"
        : "用户还没同意 → 等他回话；他要改就重新 propose-plan";
      open.push(`- ${what}：${state}`);
      continue;
    }
    const state = p.approved
      ? "用户已表示同意 → 立刻调用 apply-design；不要重新提案，不要先解释"
      : "用户还没同意 → 等他回话；他要改就重新 propose-design";
    open.push(`- ${p.name}：${state}`);
  }
  const blocks: string[] = [];
  if (open.length) {
    blocks.push(
      [
        "<pending-proposal>",
        "有一份东西已经给用户看过、但还没执行。执行必须等用户同意——同意由 harness 按他的回话判定，你自己说了不算。",
        ...open,
        "</pending-proposal>",
      ].join("\n"),
    );
  }
  if (settled.length) {
    blocks.push(
      [
        "<settled-plan>",
        "已经执行过、还留在手边的规划（用户随时可能点着某一条改）：",
        ...settled,
        "</settled-plan>",
      ].join("\n"),
    );
  }
  return blocks.length ? blocks.join("\n\n") : undefined;
}

export interface SessionDeps {
  projectId: string;
  /** 会话角色，缺省 primary 第一个 */
  agentId?: string;
  model?: ModelConfig;
  /** 这套配置在 `models.json` 里的名字（环境变量那套没有名字）。**续聊靠它把厂商认回来**。 */
  profile?: string;
  io?: UserIO;
  /** 保留现有会话（续聊）时传入；缺省新建并落盘 */
  sessionId?: string;
  title?: string;
  /** 子会话深度（task 委派限深用） */
  depth?: number;
  /** 子会话专用：派生它的父会话 id（落进 session.json，列表据此把子会话排除在外） */
  parentSessionId?: string;
  /** 子会话专用：父会话当前生效的规则集，用来派生自己的（父的 deny 继承、allow 不继承） */
  parentRuleset?: Ruleset;
}

export class Session {
  readonly projectId: string;
  readonly sessionId: string;
  readonly depth: number;
  /** 派生这次子会话的父会话 id；用户会话没有。 */
  readonly parentSessionId?: string;
  readonly agentId: string;
  model: ModelConfig;
  /** 这套配置的名字；没有（环境变量那套）时为 undefined。 */
  readonly profile?: string;
  io: UserIO;
  meta: ProjectMeta;
  agents: AgentRegistry;
  tools: ToolRegistry;
  private abort = new AbortController();
  /** 会话消息内存缓存：同会话多次 post() 间复用；首次按需从盘载入 */
  private cache: StoredMessage[] | null = null;
  /** 上一次请求发出去多少 token（provider 报的真数）——压缩的触发判据 */
  private lastInput: number | undefined;
  /** 这一轮由哪条用户消息发起；文件回退快照按它归组。 */
  private lastUserSeq: number | undefined;
  /**
   * 待落盘的提案（design 写入 propose → apply 的中转态），按文档路径索引。
   * 只在内存里：重启即失效，apply 会要求重新提案。
   */
  readonly pending = new Map<string, PendingProposal>();

  /**
   * 提问已开始、助手消息还没提交时的那一条 write-ahead 记录。
   * 助手消息一提交，问题就从 tool part 投影出来，这条随即清掉（见 `hydrate`）。
   */
  private pendingAskRecord?: PendingAskRecord;

  /** 有没有一轮正在跑。迟到回答要排队，不能在同一个会话上并发开两轮。 */
  private running = false;

  /**
   * 当前会话模式（见 agent/modes.ts）。只在内存里——和 pending 同生命周期，进程重启即回默认模式。
   * 硬保证不靠它：三向审阅的前置是模式，但那条链的"停"靠 `propose-design` 自己的 `halt`，丢了也不漏。
   */
  private mode?: string;

  /** 用户说过「以后都允许」的规则（`ctx.ask` 答复为 `always` 时追加）。同样是会话内存。 */
  private readonly approved: Rule[] = [];

  /** `rulesetFor` 的缓存：键是 (agent, 模式)——两者不变时复用同一份规则数组。 */
  private rulesetCache?: { key: string; rules: Ruleset };

  /**
   * 子会话的派生来源。有值 = 这是个子代理会话：规则集由 `deriveSubagentPermission` 从父的
   * deny 派生（父的 allow 不继承），而不是自己从内置默认起算。
   */
  private readonly parentRuleset?: Ruleset;

  constructor(deps: SessionDeps & { meta: ProjectMeta; agents: AgentRegistry; tools: ToolRegistry; model: ModelConfig }) {
    this.projectId = deps.projectId;
    this.sessionId = deps.sessionId ?? randomUUID();
    this.depth = deps.depth ?? 0;
    this.parentSessionId = deps.parentSessionId;
    this.parentRuleset = deps.parentRuleset;
    this.agentId = deps.agentId ?? deps.agents.getDefaultPrimary().id;
    this.model = deps.model;
    this.profile = deps.profile;
    this.io = deps.io ?? autoIO;
    this.meta = deps.meta;
    this.agents = deps.agents;
    this.tools = deps.tools;
  }

  get agent(): AgentDef {
    return this.agents.get(this.agentId);
  }

  /**
   * 事件先自己过一手再转给界面：用量是会话自己的账（界面的占比、将来的压缩都靠它），
   * 而它只活在 provider 的回应里——不在这里记下来，切个会话或者关掉应用就没了。
   */
  private forwardEvent(e: LLMEvent): void {
    if (e.type === "usage") {
      this.lastInput = e.input; // 压缩的判据（见 compaction.isOverBudget）
      void appendUsage(this.projectId, this.sessionId, { input: e.input, output: e.output }).catch(() => {});
    }
    this.io.onEvent(e);
  }

  async saveMeta(title?: string): Promise<void> {
    await createSession(this.projectId, {
      id: this.sessionId,
      projectId: this.projectId,
      title: title ?? this.agent.name,
      agent: this.agentId,
      model: this.model,
      profile: this.profile,
      ...(this.depth > 0 ? { depth: this.depth } : {}),
      ...(this.parentSessionId !== undefined ? { parentSessionId: this.parentSessionId } : {}),
    });
  }

  /**
   * 就地回退到某条用户消息**之前**。
   *
   * 目标消息及其之后的内容从当前会话移除，目标文本返回给外壳回填输入框。原 messages.jsonl
   * 先整份备份到 `rewind-backups/` 再重写——talemate 的日志本来只追加，这里为了"就地回退"
   * 付的代价是重写；备份是那次重写的审计底。
   *
   * 只允许空闲时调用：正在跑的回合里撤回它读过的消息，没有安全的落点。
   *
   * `restoreFiles` 为 true 时，先把 `seq >= target` 的写还原；还原失败会先回滚已改的文件再抛错，
   * 对话**不**撤回——半还原比不还原更糟。成功后才备份并截断会话，最后清掉这些检查点。
   */
  async rewindTo(
    seq: number,
    opts: { restoreFiles?: boolean } = {},
  ): Promise<{ text: string; backup?: string; files?: FileRewindOutcome }> {
    if (this.running) throw new Error("这一轮还在跑，等它结束再回退。");
    const all = await this.ensureLoaded();
    const target = all.find((m) => m.seq === seq && m.role === "user");
    if (target === undefined) throw new Error(`没有 seq=${seq} 的用户消息，不能回退。`);

    const files = opts.restoreFiles === true
      ? await restoreFilesForRewind(this.projectId, this.sessionId, seq)
      : undefined;
    const backup = await backupMessages(this.projectId, this.sessionId);
    await truncateMessagesBefore(this.projectId, this.sessionId, seq);
    // 两种模式都清：seq 会被新分支复用，旧账留着会还原错东西
    await dropFileCheckpointsFrom(this.projectId, this.sessionId, seq);

    this.cache = all.filter((m) => m.seq < seq);
    // 目标之后的提案/提问都属于被撤回的那一段，不能留着让模型"执行一个已经不存在的提议"
    this.pending.clear();
    this.pendingAskRecord = undefined;
    await clearPendingAsk(this.projectId, this.sessionId);
    this.lastInput = undefined; // 上下文变小了；下一次按估算重新量
    this.lastUserSeq = undefined;

    return {
      text: target.text ?? "",
      ...(backup === undefined ? {} : { backup }),
      ...(files === undefined ? {} : { files }),
    };
  }

  /** 给回退确认框看的文件清单；目标不合法时返回空，不抛。 */
  async rewindPreview(seq: number): Promise<FileRewindPreview> {
    const all = await this.ensureLoaded();
    if (!all.some((m) => m.seq === seq && m.role === "user")) return { items: [] };
    return previewFileRewind(this.projectId, this.sessionId, seq);
  }

  abortCurrent(): void {
    this.abort.abort();
  }

  /**
   * 用户这轮说了话 → 判这是三向里的哪一种，并据此决定要不要退出草稿模式。
   *
   * 出口条件是"用户接受或拒绝"，不是"提案成功"：提意见是在模式里打转，不出——所以一次设计会话
   * 只进一次模式，里面可以来回提很多版。退出的动作归这里（harness），不归 `propose-*`——只有
   * harness 知道这轮回话属于哪一种。只认最近提交的那一份：halt 保证一回合只提交一份。
   */
  private markPendingApproval(input: string): void {
    const latest = this.latestOpenPending();
    if (!latest) return;
    const effect = verdictEffect(draftVerdict(input));
    latest.approved = effect.approved;
    if (!effect.leaveDraft) return;

    // 只出草稿模式：别的模式（accept-edits）底下不该有待审阅的提案。
    if (this.mode === DRAFT_MODE) this.mode = undefined;
    if (effect.dropProposal) this.pending.delete(latest.name);
  }

  /** 最近一份还没执行的提案。`done` 的规划留在表里当工作单，不是待拍板。 */
  private latestOpenPending(): PendingProposal | undefined {
    let latest: PendingProposal | undefined;
    for (const p of this.pending.values()) {
      if (!p.done && (!latest || p.at > latest.at)) latest = p;
    }
    return latest;
  }

  /**
   * 界面的结构化拍板：接受 / 拒绝。
   *
   * 不落成用户消息——用户点的是按钮，不是打了“没问题”；这句话不该出现在对话历史里。
   * 接受之后由外壳再跑一轮（`resumeAfterAnswer`），system 里的 `<pending-proposal>` 会告诉
   * 模型"用户已同意，可以 apply-design / 照它执行"。拒绝没有后续模型回合。
   */
  decideProposal(verdict: "accept" | "reject"): void {
    if (this.running) throw new Error("这一轮还在跑，等它结束再拍板。");
    const latest = this.latestOpenPending();
    if (!latest) throw new Error("没有待拍板的提案。");

    if (verdict === "accept") latest.approved = true;
    else this.pending.delete(latest.name);
    if (this.mode === DRAFT_MODE) this.mode = undefined;
  }

  /**
   * 接受一份提案。
   *
   * **文档提案由 harness 直接落盘**——用户已经看过这一版字节，接受是确定的动作，不需要再让
   * 模型猜“现在该调 apply-design 了”。走的是同一个 `apply-design` 工具、同一条 write_ops
   * 路径，权限/不变量/CAS 一样不少；只是不再多一次模型往返。
   * 规划提案没法由 harness 执行（正文要模型写），返回 plan 让外壳跑执行回合。
   */
  async acceptProposal(): Promise<{ kind: "design" | "plan" }> {
    if (this.running) throw new Error("这一轮还在跑，等它结束再拍板。");
    const latest = this.latestOpenPending();
    if (!latest) throw new Error("没有待拍板的提案。");

    this.decideProposal("accept");
    if (latest.name === PLAN_KEY) return { kind: "plan" };

    // 文档落盘虽然快，也要占住会话：否则用户在这几十毫秒里发话，会和写盘并发。
    this.running = true;
    this.io.onEvent({ type: "session.status", status: "busy" });
    try {
      await this.applyApprovedDesign(latest.name);
    } finally {
      this.running = false;
      this.io.onEvent({ type: "session.status", status: "idle" });
    }
    return { kind: "design" };
  }

  /** 把已批准的文档提案交给 apply-design 工具落盘；失败时把工具错误原样抛出。 */
  private async applyApprovedDesign(path: string): Promise<void> {
    if (!this.tools.has("apply-design")) throw new Error("apply-design 工具没有注册。");
    const callId = `apply-${randomUUID()}`;
    const call: ToolCall = { id: callId, name: "apply-design", input: { path } };
    this.io.onEvent({ type: "tool-call", id: callId, name: call.name, input: JSON.stringify(call.input) });
    const part = await executeToolPart(this.agentId, call, this.tools, this.makeContext(this.agent, callId));
    this.io.onEvent({
      type: "tool.result",
      id: callId,
      name: call.name,
      output: part.type === "tool" ? (part.output ?? part.error ?? "") : "",
      change: part.type === "tool" ? part.change : undefined,
    });
    await this.persistAssistant(this.agentId, [part], "tool_calls");
    // apply-design 失败时返回 completed + 错误文案（工具层约定），只有清掉提案才算成功
    if (this.pending.has(path)) {
      throw new Error(
        part.type === "tool" ? (part.output || part.error || "apply-design 失败") : "apply-design 失败",
      );
    }
  }

  /**
   * 提意见：用户确实写了一段话，照常落成 user 消息；但不再走 `draftVerdict`——
   * 界面已经明确是 refine，一段恰好写成“没问题”的意见不该被误判成接受。
   */
  async refineProposal(note: string): Promise<string> {
    if (this.running) throw new Error("这一轮还在跑，等它结束再提意见。");
    const latest = this.latestOpenPending();
    if (!latest) throw new Error("没有待拍板的提案。");
    if (note.trim() === "") throw new Error("提意见不能为空。");

    latest.approved = false;
    return this.runTurn(this.agent, note, (text, id) => this.persistUser(text, id));
  }

  /** 提示符用：待落盘提案的展示名（如"核心层"）。没有未决的 → undefined。 */
  get pendingLabel(): string | undefined {
    const open = [...this.pending.values()].filter((p) => !p.done);
    if (!open.length) return undefined;
    return [...new Set(open.map((p) => labelOf(p.name, p.content)))].join("、");
  }

  /**
   * 还有没有"给用户看过、但没执行"的东西。
   *
   * 不等于 `pending.size > 0`：执行完的规划会留着条目（`done`）——那是"手边的工作单"，不是待办
   * （理由见 `core/types.ts` 的 `done`）。探针的收尾判据要的是这个区分。
   */
  get hasOpenProposal(): boolean {
    return [...this.pending.values()].some((p) => !p.done);
  }

  /** 正文落盘 → 把那一章的规划记为"已执行"（判据见 `writeSettlesPlan`，`done` 见 core/types.ts）。 */
  private markPlanDone(call: ToolCall, part: AssistantPart): void {
    const plan = this.pending.get(PLAN_KEY);
    if (!plan) return;
    if (!writeSettlesPlan(plan, call, part.type === "tool" && !part.error)) return;
    plan.done = true;
  }

  /** 跑完一轮：输入 → runLoop（agent 循环）→ 返回最终 assistant 正文 */
  async post(input: string, opts?: { agentId?: string }): Promise<string> {
    const agent = this.agents.get(opts?.agentId ?? this.agentId);
    // 三向裁决只认用户这轮的话；迟到回答不是对提案的裁决，绝不能在这里被当成“同意”
    this.markPendingApproval(input);
    return this.runTurn(agent, input, (text, agId) => this.persistUser(text, agId));
  }

  /** 迟到回答已经落成一条用户消息，这里只跑模型这一轮，不再提交 user 消息。 */
  async resumeAfterAnswer(): Promise<string> {
    return this.runTurn(this.agent, "", async () => {});
  }

  /** 一轮的真身。`post` 与 `resumeAfterAnswer` 的差别只在“user 消息由谁落盘”。 */
  private async runTurn(
    agent: AgentDef,
    input: string,
    commitUser: (text: string, agentId: string) => Promise<void>,
  ): Promise<string> {
    if (this.running) throw new Error("会话正在运行，不能并发开第二轮");
    this.running = true;

    // 每回合一个新的控制器。`abort()` 是一次性的——信号一旦中止就**永远**中止，不重建的话
    // 用户点过一次「停止」，这个会话就再也发不出去：之后每一轮的 signal 一上来就是已中止的。
    const ctrl = new AbortController();
    this.abort = ctrl;

    try {
      return await runLoop(agent, input, {
        signal: ctrl.signal,
        steps: agent.steps,
        onEvent: (e) => this.forwardEvent(e),
        maybeCompact: () => this.maybeCompact(),
        commitUser,
        buildRequest: (ag) => this.buildRequest(ag),
        generate: (req, o) =>
          chat({
            model: this.model,
            system: req.system,
            messages: req.messages,
            tools: req.tools?.length ? req.tools : undefined,
            signal: o.signal,
            onText: o.onText,
            onReasoning: o.onReasoning,
            onToolCallStart: o.onToolCallStart,
          }),
        executeTool: async (ag, call) => {
          // 详细打印事件：工具调用、task 子代理边界（子会话事件发生在 scope.open/close 之间）、工具结果
          const isTask = call.name === "task";
          this.io.onEvent({ type: "tool-call", id: call.id, name: call.name, input: JSON.stringify(call.input ?? {}) });
          if (isTask) {
            const sub = (call.input as { agent?: string }).agent ?? call.name;
            this.io.onEvent({ type: "scope.open", label: `task → ${sub}` });
          }
          const part = await executeToolPart(ag.id, call, this.tools, this.makeContext(ag, call.id));
          if (isTask) this.io.onEvent({ type: "scope.close", label: "task" });
          this.markPlanDone(call, part);
          const out = part.type === "tool" ? (part.output ?? part.error ?? "") : "";
          this.io.onEvent({
            type: "tool.result",
            id: call.id,
            name: call.name,
            output: out,
            change: part.type === "tool" ? part.change : undefined,
            ask: part.type === "tool" ? part.ask : undefined,
          });
          return part;
        },
        commitAssistant: (msg) => this.persistAssistant(msg.agent, msg.parts, msg.finish),
      });
    } catch (err) {
      // 用户按了停止：**中止不是错误**。状态收尾在 `runLoop` 的 finally 里，这里只把它转成
      // 一次正常结束，免得壳把"用户主动停的"报成 [错误]。
      if (ctrl.signal.aborted) return "";
      throw err;
    } finally {
      this.running = false;
    }
  }

  get isBusy(): boolean {
    return this.running;
  }

  /** 会话打开时把 journal 接回来；助手消息已经提交的同一条记录直接清掉。 */
  async hydrate(): Promise<void> {
    const journal = await loadPendingAsk(this.projectId, this.sessionId);
    if (journal === undefined) return;
    const messages = await this.ensureLoaded();
    const committed = messages.some(
      (m) => m.parts?.some((p) => p.type === "tool" && p.ask?.callId === journal.callId) === true,
    );
    if (committed) {
      await clearPendingAsk(this.projectId, this.sessionId);
      return;
    }
    this.pendingAskRecord = journal;
  }

  /**
   * 仍然开着、可回答的提问：消息投影 + journal。顺序即提问先后。
   *
   * 扫**全部**消息而不是模型窗口：问题可能已经被压缩掉，但它仍然开着。压缩只影响模型上下文，
   * 不该让一个没答的问题从界面上消失。
   */
  async openAskViews(): Promise<OpenAsk[]> {
    const messages = await this.ensureLoaded();
    const settled = settledCallIds(messages);
    const journal =
      this.pendingAskRecord !== undefined && !settled.has(this.pendingAskRecord.callId)
        ? this.pendingAskRecord
        : undefined;
    return mergeJournalAsk(openAsks(messages), journal);
  }

  /**
   * 把一条迟到回答落成用户消息，并清掉 journal；不跑模型。
   * 跑模型由壳在后台调 `resumeAfterAnswer`——IPC 不该等一整轮生成。
   */
  async preparePendingAnswer(
    callId: string,
    answers: AskAnswer[],
  ): Promise<"ok" | "stale" | "invalid"> {
    const open = await this.openAskViews();
    const ask = open.find((a) => a.callId === callId);
    if (ask === undefined) return "stale";
    if (validateAnswers(ask.questions, answers) !== undefined) return "invalid";
    const m = await appendMessage(this.projectId, this.sessionId, {
      role: "user",
      agent: this.agentId,
      text: renderAnswerMessage(ask.questions, answers, callId),
      answersTo: { callId, questions: ask.questions, answers },
    });
    await this.push(m);
    await clearPendingAsk(this.projectId, this.sessionId);
    if (this.pendingAskRecord?.callId === callId) this.pendingAskRecord = undefined;
    return "ok";
  }

  /**
   * 这一次请求的三段各有多少字符（系统提示词 / 工具定义 / 对话消息）。
   *
   * 给界面算"上下文基线"用：一行正文都还没写时，系统提示词和工具定义已经在窗口里占着位置，
   * 那时显示 0% 是错的。**字符不是 token**——界面按比例估，标「~」。
   */
  async requestSizes(): Promise<{ system: number; tools: number; messages: number }> {
    const req = await this.buildRequest(this.agent);
    return {
      system: req.system.length,
      tools: JSON.stringify(req.tools ?? []).length,
      messages: JSON.stringify(req.messages).length,
    };
  }

  /** 组装一次请求：截窗后的历史 → NeutralMsg + system + 该角色可见工具 */
  private async buildRequest(agent: AgentDef): Promise<{ system: string; messages: NeutralMsg[]; tools?: ToolSchema[] }> {
    const neutral = toNeutralMessages(await this.messageWindow());
    const system = await this.buildSystem(agent);
    const tools = this.allowedTools(agent);
    const toolSchemas = this.tools.schemasFor(
      tools,
      tools.includes("task") ? { taskCatalog: this.agents.subagentCatalog() } : undefined,
    );
    return { system, messages: neutral, tools: toolSchemas.length ? toolSchemas : undefined };
  }

  /**
   * 四层来源，顺序即优先级：内置默认 → agent 声明 → 模式覆盖 → 用户配置。
   * （`deny` 单调，不受这个顺序影响——见 `permission.evaluate` 第 1 步。）
   *
   * 求值与展示共用这一份定义：`rulesetFor` 把它拼起来跑，`permissionView` 把它摊开给人看；
   * 各写一份的话，"看到的规则"迟早和"执行的规则"说两套话。
   */
  private permissionSources(agent: AgentDef): { label: string; config: PermissionConfig }[] {
    return [
      { label: "内置默认", config: BASE_PERMISSIONS },
      { label: `agent ${agent.name}`, config: agent.permission ?? {} },
      { label: this.mode ? MODES[this.mode].title : "模式", config: this.mode ? MODES[this.mode].permission : {} },
      { label: "项目配置 talemate.json", config: this.meta.permissions ?? {} },
    ];
  }

  /**
   * 当前生效的规则集（见 `permissionSources`）。子会话走另一条路：只从父的 deny 派生。
   * 按 (agent, 模式) 缓存——`check`/`ask` 一轮里要跑好几次，不缓存等于反复转。
   */
  private rulesetFor(agent: AgentDef): Ruleset {
    if (this.parentRuleset) return deriveSubagentPermission(this.parentRuleset, agent);
    const key = `${agent.id}:${this.mode ?? ""}`;
    if (this.rulesetCache?.key !== key) {
      this.rulesetCache = { key, rules: mergeConfigs(...this.permissionSources(agent).map((s) => s.config)) };
    }
    return this.rulesetCache.rules;
  }

  /** 当前模式（没进模式 → undefined）。CLI 拿它显示在提示符上：模式改了能做什么，看不见不行。 */
  get currentMode(): ModeDef | undefined {
    return this.mode ? MODES[this.mode] : undefined;
  }

  /** 壳给新会话定默认权限模式（见设置里的「权限」）；运行中切模式仍走 ctx.setMode。 */
  setMode(mode: string | undefined): void {
    this.mode = mode;
  }

  /** 见 `PermissionView`：`rulesetFor` 只给结论，这里要的是每一层各自的来源。 */
  permissionView(): PermissionView {
    if (this.parentRuleset) {
      // 子会话不是四层叠加，是从父的 deny 派生的（见 permission.deriveSubagentPermission）
      return {
        agentName: this.agent.name,
        derived: true,
        layers: [{ label: "由父会话派生：父的 deny 继承、allow 不继承", rules: this.rulesetFor(this.agent) }],
        approved: [],
      };
    }
    return {
      agentName: this.agent.name,
      modeTitle: this.currentMode?.title,
      derived: false,
      layers: this.permissionSources(this.agent).map((s) => ({ label: s.label, rules: fromConfig(s.config) })),
      approved: [...this.approved],
    };
  }

  /**
   * 该 agent 可见的工具：白名单减去被 `deny *` 盖住的。那些是"这个模式下没有这个工具"
   * （从 schema 里消失，不占上下文也不诱导模型去试），不是"有但会被拒"。
   */
  private allowedTools(agent: AgentDef): string[] {
    const defs = agent.tools.flatMap((id) => (this.tools.has(id) ? [this.tools.get(id)] : []));
    return visibleTools(defs, this.rulesetFor(agent)).map((t) => t.id);
  }

  /**
   * 拼 system prompt：env + 角色 system + (core/world 常驻设定) + AGENTS.md + skill 目录。
   * 常驻设定只给可见 primary（mate）注入——subagent 不注入（省 token，靠 task prompt 切片）。
   */
  private async buildSystem(agent: AgentDef): Promise<string> {
    const rules = await readProjectRules(this.projectId);
    const skills = await discoverSkills(this.projectId);
    let resident: string | undefined;
    if (agent.mode === "primary" && !agent.hidden) resident = await buildResidentDesigns(this.projectId);
    const base = buildSystemPrompt({
      projectTitle: this.meta.title,
      agentName: agent.name,
      roleSystem: agent.system,
      rules,
      skills: renderSkillCatalog(skills),
      resident,
    });
    // 模式注记排在角色壳之后、状态注记之前：它是"眼下在干什么"，压过角色的默认姿态。
    const mode = this.mode ? MODES[this.mode] : undefined;
    const note = renderPendingNote(this.pending);
    // 未答提问每轮都在场：压缩或换轮之后，模型仍要知道“有个问题还挂着，别把沉默当同意”
    const askNote = renderOpenAskNote(await this.openAskViews());
    const prose = await this.proseWindow(agent);
    return [base, mode?.note, note, askNote, prose].filter(Boolean).join("\n\n");
  }

  /**
   * 正文写作窗口：用户拍过板、这一章还没落盘时，把规范与这本书的文风卡放进 system。
   *
   * 判据是状态，不是模型自觉——同 `halt` 与 `approved`。窗口一关（正文落盘、`done` 置位）它们就
   * 退出上下文，所以这份 token 只在写那一章的几轮里付。理由见 `framework/prose.ts` 的文件头。
   */
  private async proseWindow(agent: AgentDef): Promise<string | undefined> {
    // 与常驻设定同一条边界：只给可见的 primary。规划只由 mate 执行。
    if (agent.mode !== "primary" || agent.hidden) return undefined;
    const plan = this.pending.get(PLAN_KEY);
    if (!plan || !plan.approved || plan.done || plan.chapter === undefined) return undefined;
    return buildProseBrief(this.projectId, plan.chapter);
  }

  private makeContext(agent: AgentDef, callId: string): ToolContext {
    return {
      projectId: this.projectId,
      sessionId: this.sessionId,
      agent: agent.id,
      callId,
      ...(this.lastUserSeq === undefined ? {} : { turnSeq: this.lastUserSeq }),
      signal: this.abort.signal,
      // 原始确认口：ask 拿它当弹窗，confirm 工具也用它。其余工具不该碰。
      confirm: (action, summary) => this.io.confirm(action, summary),
      // 纯求值：给 runner 做粗粒度兜底（被幻觉调出来的工具也得挡住）。不打扰用户。
      check: (permission, pattern) => evaluate(permission, pattern, this.rulesetFor(agent), this.approved).action,
      // 唯一一道"改世界之前"的口。所有落盘/委派/联网的工具走这里，不再各自调 io.confirm。
      ask: async (req) => {
        const rule = evaluate(req.permission, req.pattern, this.rulesetFor(agent), this.approved);
        if (rule.action === "deny") return "deny";
        if (rule.action === "allow") return "allow";
        const reply = await this.io.confirm(req.summary, req.detail ?? "");
        if (reply === "no") return "reject";
        if (reply === "always" && req.always) {
          this.approved.push({ permission: req.permission, pattern: req.always, action: "allow" });
        }
        return "allow";
      },
      askUser: async (req) => {
        const pending: PendingAskRecord = {
          callId: req.callId,
          questions: req.questions,
          at: Date.now(),
        };
        // journal 是崩溃窗口的保险，不是提问成功的前提；写不动也不挡这次提问
        await savePendingAsk(this.projectId, this.sessionId, pending).catch(() => {});
        try {
          const outcome = await this.io.askUser({
            ...req,
            signal: req.signal ?? this.abort.signal,
          });
          if (outcome.kind === "pending") {
            this.pendingAskRecord = pending;
          } else {
            this.pendingAskRecord = undefined;
            await clearPendingAsk(this.projectId, this.sessionId).catch(() => {});
          }
          return outcome;
        } catch (err) {
          this.pendingAskRecord = undefined;
          await clearPendingAsk(this.projectId, this.sessionId).catch(() => {});
          throw err;
        }
      },
      showProposal: (text, view) =>
        this.io.onEvent({ type: "proposal", text, ...(view === undefined ? {} : { view }) }),
      // 以方法暴露而非裸 Map：approved / base 这些不变量只能在这里改
      setMode: (m) => this.setMode(m),
      getMode: () => this.mode,
      getProposal: (name) => this.pending.get(name),
      setProposal: (p) => {
        this.pending.set(p.name, p);
      },
      clearProposal: (name) => {
        this.pending.delete(name);
      },
      // 三个读口，写口一个都不留——改文件只能走 tools 里的 write/edit（见 core/types.ts）。
      // 都不预设管辖范围：`prefix` 由调用工具给。
      readDoc: (path) => readDoc(this.projectId, path),
      listIndex: (prefix) => buildIndex(this.projectId, prefix),
      searchDocs: async (query, prefix) => renderHits(await scanDocs(this.projectId, query, prefix), query),
      // 把当前生效的规则集交给子会话去派生（父的 deny 继承、allow 不继承）
      runSubagent: (agentId, prompt) => this.runSubagent(agentId, prompt, this.rulesetFor(agent)),
      loadSkill: (name) => loadSkillByName(this.projectId, name).then((s) => s?.body),
      // 联网设置也由会话注入：工具不自己读盘（分层守卫钉着）
      webSettings: () => loadWebSettings(),
    };
  }

  /**
   * task 委派：子会话独立上下文，只传 prompt，返回最终正文。
   *
   * 子会话 id 一并交出去：左栏列表会把子会话过滤掉，但轨迹和调试命令要靠它找回这一次委派。
   */
  private async runSubagent(
    agentId: string,
    prompt: string,
    parentRuleset: Ruleset,
  ): Promise<{ text: string; sessionId: string }> {
    const sub = this.agents.get(agentId);
    if (sub.mode !== "subagent") throw new Error(`agent ${agentId} 不是 subagent，不能 task 委派`);
    if (this.depth >= 1) throw new Error("子代理深度超限（task 最多嵌套 1 层）");

    const child = new Session({
      projectId: this.projectId,
      agentId,
      model: sub.model ?? this.model,
      io: this.io,
      depth: this.depth + 1,
      parentSessionId: this.sessionId,
      title: `task:${sub.name}`,
      meta: this.meta,
      agents: this.agents,
      tools: this.tools,
      parentRuleset,
    });
    await child.saveMeta(`task:${sub.name}`);
    return { text: await child.post(prompt), sessionId: child.sessionId };
  }

  // ─── 消息缓存与持久化（唯一读写磁盘/内存的出口） ───

  /** 取当前上下文窗口（最新 compaction 之后的 seq），从内存拿，不重读盘 */
  private async messageWindow(): Promise<StoredMessage[]> {
    return loadModelWindow(await this.ensureLoaded());
  }

  private async ensureLoaded(): Promise<StoredMessage[]> {
    if (!this.cache) {
      this.cache = await loadMessages(this.projectId, this.sessionId);
      // 续聊时把上一轮的用量读回来：它是压缩的判据，而进程重启之后内存里没有
      const meta = await loadSessionMeta(this.projectId, this.sessionId).catch(() => undefined);
      this.lastInput = meta?.usage?.at(-1)?.input;
    }
    return this.cache;
  }

  /** 落盘一条消息 + 同步 push 进内存缓存 */
  private async push(msg: StoredMessage): Promise<void> {
    (await this.ensureLoaded()).push(msg);
  }

  private async persistUser(text: string, agentId: string): Promise<void> {
    const m = await appendMessage(this.projectId, this.sessionId, { role: "user", agent: agentId, text });
    this.lastUserSeq = m.seq;
    await this.push(m);
    // 界面用 seq 把实时气泡变成可回退目标。只报事件，不进模型上下文。
    this.io.onEvent({ type: "user.message", seq: m.seq, text, sessionId: this.sessionId, agent: agentId });
  }

  private async persistAssistant(agent: string, parts: AssistantPart[], finish: "stop" | "tool_calls"): Promise<void> {
    const m = await appendMessage(this.projectId, this.sessionId, {
      role: "assistant",
      agent,
      parts,
      finish,
      model: this.model.model,
    });
    await this.push(m);
  }

  /** 压缩前检查：用内存消息判断是否超阈值，是则压缩并把 compaction 消息同步回缓存 */
  private async maybeCompact(): Promise<void> {
    const all = await this.ensureLoaded();
    // 量窗口，不是文件：文件只增不减，量它等于过了阈值就永远超预算（见 isOverBudget 的注释）。
    if (!isOverBudget(this.model.model, this.lastInput, loadModelWindow(all))) return;
    const summarizer = this.agents.get("summarizer");
    const m = await compact({
      projectId: this.projectId,
      sessionId: this.sessionId,
      model: this.model,
      system: summarizer.system,
      messages: all,
    });
    if (m) await this.push(m);
  }
}

/** 打开（或新建并落盘）一个项目会话，返回可 post 的 Session */
export async function openSession(deps: SessionDeps): Promise<Session> {
  const meta = await loadProjectMeta(deps.projectId);
  const agents = new AgentRegistry();
  agents.applyProject(meta);
  const tools = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) tools.register(t);
  // 续聊：把这份会话自己记的模型配置读回来。不读的话每开一次就退回 `.env`——用户配的那套
  // 等于只在"新建会话"那一次生效，重开 app 就悄悄换了厂商。
  const stored = deps.sessionId
    ? await loadSessionMeta(deps.projectId, deps.sessionId).catch(() => undefined)
    : undefined;
  const model = deps.model ?? stored?.model ?? loadModelConfig();
  const session = new Session({
    ...deps,
    meta,
    agents,
    tools,
    model,
    profile: deps.profile ?? stored?.profile,
  });
  if (!deps.sessionId) await session.saveMeta(deps.title);
  // 续聊/重开：把“提问已开始、助手消息还没提交”的那条 journal 接回来
  await session.hydrate();
  return session;
}
