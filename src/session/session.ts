/**
 * Session：一个项目上下文里的会话。只做两件事——
 * 1) 持有会话状态（id/项目/角色/模型/IO）、落盘会话元、可中止；
 * 2) 当接线器：把 storage / LLM / 工具 / 上下文组装成 LoopDeps，交给 session/loop 的 runLoop 去跑。
 *
 * 循环本身在 loop.ts。消息读走内存缓存：一次 post() 里只有首次读盘，之后每次 append 同步 push 进内存。
 */
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../agent/registry";
import { MODES } from "../agent/modes";
import { BASE_PERMISSIONS, deriveSubagentPermission, evaluate, fromConfig, mergeConfigs, visibleTools } from "../permission";
import { loadModelConfig } from "../core/config";
import { PLAN_KEY } from "../core/types";
import type { ModeDef } from "../agent/modes";
import type { PermissionConfig, Rule, Ruleset } from "../permission";
import type {
  AgentDef,
  AssistantPart,
  ConfirmReply,
  LLMEvent,
  ModelConfig,
  PendingProposal,
  ProjectMeta,
  StoredMessage,
  ToolContext,
} from "../core/types";
import { buildSystemPrompt, toNeutralMessages } from "../context/assemble";
import { buildResidentDesigns, buildDesignIndex } from "../framework/anchor";
import { labelOf } from "../framework/proposal";
import { renderHits, searchDesigns } from "../framework/search";
import { chat } from "../llm/provider";
import type { NeutralMsg, ToolSchema } from "../llm/types";
import { discoverSkills, loadSkillByName, renderSkillCatalog } from "../skill/discovery";
import { listChapters, listDesigns, loadProjectMeta, readDesign, readProjectRules, removeDesign, saveChapter, writeDesign } from "../storage/project";
import { appendMessage, createSession, loadMessages, loadModelWindow } from "../storage/session-store";
import { BUILTIN_TOOLS } from "../tool";
import { ToolRegistry } from "../tool/registry";
import { executeToolPart } from "../tool/runner";
import { compact, isOverBudget } from "./compaction";
import { runLoop } from "./loop";

/** 用户交互口：CLI/TUI 提供；冒烟可用自动答复实现 */
export interface UserIO {
  onEvent(e: LLMEvent): void;
  /** `always` = 这一类以后都别问（进会话级 approved 表）。这个答复是权限系统唯一的记忆来源。 */
  confirm(action: string, summary: string): Promise<ConfirmReply>;
  askUser(question: string, options?: string[]): Promise<string>;
}

/**
 * 规则表的展示视图（`Session.permissionView` 的产物）。给 CLI 的 `/permissions` 用——
 * 它要回答的是"我配的那条生效没有"，所以除了结论还得有**每一层各自贡献了什么**。
 */
export interface PermissionView {
  agentName: string;
  /** 当前模式（没进模式 → undefined） */
  modeTitle?: string;
  /** 子会话：规则由父会话派生，不是四层叠加 */
  derived: boolean;
  /** 顺序即优先级 */
  layers: { label: string; rules: Ruleset }[];
  /** 会话级 approved：用户说过「以后都允许」的规则 */
  approved: Ruleset;
}

/** 自动 IO：一律放行（`once`，不写 approved——无人值守时不该替用户改规则）、askUser 返回占位 */
export const autoIO: UserIO = {
  onEvent() {},
  async confirm() {
    return "once";
  },
  async askUser(q) {
    return `（自动答复：${q}）`;
  },
};

/**
 * 用户这轮回话算不算"同意待落盘的提案"。
 *
 * 由 harness 判、不问模型：同意必须落在**用户真的说过的话**上，模型自述不算。
 * fail-closed：措辞不常见就多走一轮，不会写用户没认可的东西。
 * 「没问题，但第 3 格改成 X」不算同意——夹着改动要求，匹配不上。
 */
const AGREE_WORDS = "没问题|可以|行|好的|好|同意|确认|就这样|写吧|落盘|ok|okay|yes|y";
const AGREE_CHAIN_RE = new RegExp(`^(?:(?:${AGREE_WORDS})[，,、。！!.…~\\s]*)+$`, "i");

/** 这句话是不是一个"同意"（见上；导出供测试）。 */
export function isAgreement(text: string): boolean {
  return AGREE_CHAIN_RE.test(text.trim());
}

/**
 * 未落盘提案的状态注入（进 system，每轮都有；纯函数，导出供测试）。
 * 让协议状态独立于消息历史——压缩会把 tool 消息折掉，`/open` 恢复后历史也可能被截。
 */
export function renderPendingNote(pending: Map<string, PendingProposal>): string | undefined {
  if (!pending.size) return undefined;
  const lines = [...pending.values()].map((p) => {
    // 节拍没有目标文件：它批准的是"去写正文"这个动作，不是一份文档。
    if (p.name === PLAN_KEY) {
      const what = p.chapter ? `${p.chapter}的节拍` : "这一章的节拍";
      const state = p.approved
        ? "用户已表示同意 → 可以带它 task(writer)"
        : "用户还没同意 → 等他回话；他要改就重新 propose-plan";
      return `- ${what}：${state}`;
    }
    const what = p.section ? `只改「${p.section}」这一格` : "整篇";
    const state = p.approved
      ? "用户已表示同意 → 可以 apply-design"
      : "用户还没同意 → 等他回话；他要改就重新 propose-design";
    return `- ${p.name}（${what}）：${state}`;
  });
  return [
    "<pending-proposal>",
    "有一份东西已经摆给用户看过、但还没执行。执行必须等用户同意——同意由 harness 按他的回话判定，你自己说了不算。",
    ...lines,
    "</pending-proposal>",
  ].join("\n");
}

export interface SessionDeps {
  projectId: string;
  /** 会话角色，缺省 primary 第一个 */
  agentId?: string;
  model?: ModelConfig;
  io?: UserIO;
  /** 保留现有会话（续聊）时传入；缺省新建并落盘 */
  sessionId?: string;
  title?: string;
  /** 子会话深度（task 委派限深用） */
  depth?: number;
  /** 子会话专用：父会话当前生效的规则集，用来派生自己的（父的 deny 继承、allow 不继承） */
  parentRuleset?: Ruleset;
}

export class Session {
  readonly projectId: string;
  readonly sessionId: string;
  readonly depth: number;
  readonly agentId: string;
  model: ModelConfig;
  io: UserIO;
  meta: ProjectMeta;
  agents: AgentRegistry;
  tools: ToolRegistry;
  private abort = new AbortController();
  /** 会话消息内存缓存：同会话多次 post() 间复用；首次按需从盘载入 */
  private cache: StoredMessage[] | null = null;
  /**
   * 待落盘的提案（design 写入 propose → apply 的中转态），按文档路径索引。
   * 只在内存里：重启即失效，apply 会要求重新提案。
   */
  readonly pending = new Map<string, PendingProposal>();

  /**
   * 当前会话模式（见 agent/modes.ts）。**只在内存里**——和 pending 同生命周期，进程重启即回到
   * 默认模式。硬保证不靠它（写正文那道门挂在 task(writer) 上），所以丢了也不漏。
   */
  private mode?: string;

  /** 用户说过「以后都允许」的规则（`ctx.ask` 答复为 `always` 时追加）。同样是会话内存。 */
  private readonly approved: Rule[] = [];

  /** `rulesetFor` 的缓存：键是 (agent, 模式)——两者不变时复用同一份规则数组。 */
  private rulesetCache?: { key: string; rules: Ruleset };

  /**
   * 子会话的派生来源。有值 = 这是个子代理会话：规则集由 `deriveSubagentPermission` 从父的
   * **deny** 派生（父的 allow 不继承），而不是自己从内置默认起算。
   */
  private readonly parentRuleset?: Ruleset;

  constructor(deps: SessionDeps & { meta: ProjectMeta; agents: AgentRegistry; tools: ToolRegistry; model: ModelConfig }) {
    this.projectId = deps.projectId;
    this.sessionId = deps.sessionId ?? randomUUID();
    this.depth = deps.depth ?? 0;
    this.parentRuleset = deps.parentRuleset;
    this.agentId = deps.agentId ?? deps.agents.getDefaultPrimary().id;
    this.model = deps.model;
    this.io = deps.io ?? autoIO;
    this.meta = deps.meta;
    this.agents = deps.agents;
    this.tools = deps.tools;
  }

  get agent(): AgentDef {
    return this.agents.get(this.agentId);
  }

  async saveMeta(title?: string): Promise<void> {
    await createSession(this.projectId, {
      id: this.sessionId,
      projectId: this.projectId,
      title: title ?? this.agent.name,
      agent: this.agentId,
      model: this.model,
    });
  }

  abortCurrent(): void {
    this.abort.abort();
  }

  /**
   * 用户这轮说了话 → 更新待落盘提案的"同意"标记（见 isAgreement）。
   * 只认最近提交的那一份：halt 保证一回合只摆一份，更早的提案不能被顺带点亮。
   */
  private markPendingApproval(input: string): void {
    if (!this.pending.size) return;
    const ok = isAgreement(input);
    let latest: PendingProposal | undefined;
    for (const p of this.pending.values()) if (!latest || p.at > latest.at) latest = p;
    if (latest) latest.approved = ok;
  }

  /** 提示符用：待落盘提案的展示名（如"核心层"）。没有 pending → undefined。 */
  get pendingLabel(): string | undefined {
    if (!this.pending.size) return undefined;
    return [...new Set([...this.pending.values()].map((p) => labelOf(p.name, p.content)))].join("、");
  }

  /** 跑完一轮：输入 → runLoop（agent 循环）→ 返回最终 assistant 正文 */
  async post(input: string, opts?: { agentId?: string }): Promise<string> {
    const agentId = opts?.agentId ?? this.agentId;
    const agent = this.agents.get(agentId);
    this.markPendingApproval(input);

    return runLoop(agent, input, {
      signal: this.abort.signal,
      steps: agent.steps,
      onEvent: (e) => this.io.onEvent(e),
      maybeCompact: () => this.maybeCompact(),
      commitUser: (text, agId) => this.persistUser(text, agId),
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
        }),
      executeTool: async (ag, call) => {
        // 详细打印事件：工具调用、task 子代理边界（子会话事件发生在 scope.open/close 之间）、工具结果
        const isTask = call.name === "task";
        this.io.onEvent({ type: "tool-call", id: call.id, name: call.name, input: JSON.stringify(call.input ?? {}) });
        if (isTask) {
          const sub = (call.input as { agent?: string }).agent ?? call.name;
          this.io.onEvent({ type: "scope.open", label: `task → ${sub}` });
        }
        const part = await executeToolPart(agentId, call, this.tools, this.makeContext(agent));
        if (isTask) this.io.onEvent({ type: "scope.close", label: "task" });
        const out = part.type === "tool" ? (part.output ?? part.error ?? "") : "";
        this.io.onEvent({ type: "tool.result", id: call.id, name: call.name, output: out });
        return part;
      },
      commitAssistant: (msg) => this.persistAssistant(msg.agent, msg.parts, msg.finish),
    });
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
   * 四层来源，**顺序即优先级**：内置默认 → agent 声明 → 模式覆盖 → 用户配置。
   * （`deny` 单调，**不受这个顺序影响**——见 `permission.evaluate` 第 1 步。）
   *
   * 求值与展示共用这一份定义：`rulesetFor` 把它拼起来跑，`permissionView` 把它摊开给人看。
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
   * 当前生效的规则集（见 `permissionSources`）。
   * 子会话走另一条路：只从父的 deny 派生，父的 allow 不继承。
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

  /**
   * 规则表的**给人看的视图**：每一层各自贡献了什么 + 会话级 approved。CLI 的 `/permissions` 用它回答
   * "我配的那条生效没有、被谁盖住了"——同一个问题问 `rulesetFor` 只能得到结果，得不到来源。
   */
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
   * 该 agent 可见的工具：白名单**减去**被 `deny *` 盖住的。那些是"这个模式下**没有**这个工具"
   * （从 schema 里消失，不占上下文也不诱导模型去试），不是"有但会被拒"。
   */
  private allowedTools(agent: AgentDef): string[] {
    const defs = agent.tools.flatMap((id) => (this.tools.has(id) ? [this.tools.get(id)] : []));
    return visibleTools(defs, this.rulesetFor(agent)).map((t) => t.id);
  }

  /**
   * 拼 system prompt：env + 角色 system + (core/world 常驻设定) + AGENTS.md + skill 目录。
   * 常驻设定只给可见 primary（editor）注入——subagent 不注入（省 token，靠 task prompt 切片）。
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
    return [base, mode?.note, note].filter(Boolean).join("\n\n");
  }

  /** 构造工具执行上下文（ToolContext），供 execute 获取读写/确认/委派等能力 */
  private makeContext(agent: AgentDef): ToolContext {
    return {
      projectId: this.projectId,
      sessionId: this.sessionId,
      agent: agent.id,
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
      askUser: (q, options) => this.io.askUser(q, options),
      showProposal: (text) => this.io.onEvent({ type: "proposal", text }),
      // 以方法暴露而非裸 Map：approved / base 这些不变量只能在这里改
      setMode: (m) => {
        this.mode = m;
      },
      getProposal: (name) => this.pending.get(name),
      setProposal: (p) => {
        this.pending.set(p.name, p);
      },
      clearProposal: (name) => {
        this.pending.delete(name);
      },
      readDesign: (name) => readDesign(this.projectId, name),
      writeDesign: (name, content) => writeDesign(this.projectId, name, content),
      removeDesign: (name) => removeDesign(this.projectId, name),
      listDesigns: () => buildDesignIndex(this.projectId),
      listDesignPaths: () => listDesigns(this.projectId),
      searchDesigns: async (query) => {
        const hits = await searchDesigns(this.projectId, query, "design");
        return renderHits(hits, query);
      },
      listChapters: async () => {
        const names = await listChapters(this.projectId);
        return names.length ? names.join("\n") : "（尚无正文/规划落盘）";
      },
      // 把**当前生效的**规则集交给子会话去派生（父的 deny 继承、allow 不继承）
      runSubagent: (agentId, prompt) => this.runSubagent(agentId, prompt, this.rulesetFor(agent)),
      loadSkill: (name) => loadSkillByName(this.projectId, name).then((s) => s?.body),
      saveChapter: (filename, content) => saveChapter(this.projectId, filename, content),
    };
  }

  /** task 委派：子会话独立上下文，只传 prompt，返回最终正文 */
  private async runSubagent(agentId: string, prompt: string, parentRuleset: Ruleset): Promise<string> {
    const sub = this.agents.get(agentId);
    if (sub.mode !== "subagent") throw new Error(`agent ${agentId} 不是 subagent，不能 task 委派`);
    if (this.depth >= 1) throw new Error("子代理深度超限（task 最多嵌套 1 层）");

    const child = new Session({
      projectId: this.projectId,
      agentId,
      model: sub.model ?? this.model,
      io: this.io,
      depth: this.depth + 1,
      title: `task:${sub.name}`,
      meta: this.meta,
      agents: this.agents,
      tools: this.tools,
      parentRuleset,
    });
    await child.saveMeta(`task:${sub.name}`);
    return child.post(prompt);
  }

  // ─── 消息缓存与持久化（唯一读写磁盘/内存的出口） ───

  /** 取当前上下文窗口（最新 compaction 之后的 seq），从内存拿，不重读盘 */
  private async messageWindow(): Promise<StoredMessage[]> {
    return loadModelWindow(await this.ensureLoaded());
  }

  private async ensureLoaded(): Promise<StoredMessage[]> {
    if (!this.cache) this.cache = await loadMessages(this.projectId, this.sessionId);
    return this.cache;
  }

  /** 落盘一条消息 + 同步 push 进内存缓存 */
  private async push(msg: StoredMessage): Promise<void> {
    (await this.ensureLoaded()).push(msg);
  }

  private async persistUser(text: string, agentId: string): Promise<void> {
    const m = await appendMessage(this.projectId, this.sessionId, { role: "user", agent: agentId, text });
    await this.push(m);
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
    // 量**窗口**，不是文件：文件只增不减，量它等于过了阈值就永远超预算（见 isOverBudget 的注释）。
    if (!isOverBudget(loadModelWindow(all))) return;
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
  const model = deps.model ?? loadModelConfig();
  const session = new Session({ ...deps, meta, agents, tools, model });
  if (!deps.sessionId) await session.saveMeta(deps.title);
  return session;
}
