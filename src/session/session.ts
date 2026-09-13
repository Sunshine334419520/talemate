/**
 * Session：一个项目上下文里的会话。只做两件事——
 * 1) 持有会话状态（id/项目/角色/模型/IO）、落盘会话元、可中止；
 * 2) 当接线器：把 storage / LLM / 工具 / 上下文组装成 LoopDeps，交给 session/loop 的 runLoop 去跑。
 *
 * 循环本身在 loop.ts。消息读走内存缓存：一次 post() 里只有首次读盘，之后每次 append 同步 push 进内存。
 */
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../agent/registry";
import { loadModelConfig } from "../core/config";
import type {
  AgentDef,
  AssistantPart,
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
  confirm(action: string, summary: string): Promise<boolean>;
  askUser(question: string, options?: string[]): Promise<string>;
}

/** 自动 IO：默认放行确认、askUser 返回占位（供 mock/无人值守） */
export const autoIO: UserIO = {
  onEvent() {},
  async confirm() {
    return true;
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
    const what = p.section ? `只改「${p.section}」这一格` : "整篇";
    const state = p.approved
      ? "用户已表示同意 → 可以 apply-design"
      : "用户还没同意 → 等他回话；他要改就重新 propose-design";
    return `- ${p.name}（${what}）：${state}`;
  });
  return [
    "<pending-proposal>",
    "有一份提案已经摆给用户看过、但还没写进任何文件。能落盘的只有这一份（apply-design 不接受新正文），且必须等用户同意。",
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

  constructor(deps: SessionDeps & { meta: ProjectMeta; agents: AgentRegistry; tools: ToolRegistry; model: ModelConfig }) {
    this.projectId = deps.projectId;
    this.sessionId = deps.sessionId ?? randomUUID();
    this.depth = deps.depth ?? 0;
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
    const toolSchemas = this.tools.schemasFor(
      agent.tools,
      agent.tools.includes("task") ? { taskCatalog: this.agents.subagentCatalog() } : undefined,
    );
    return { system, messages: neutral, tools: toolSchemas.length ? toolSchemas : undefined };
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
    const note = renderPendingNote(this.pending);
    return note ? `${base}\n\n${note}` : base;
  }

  /** 构造工具执行上下文（ToolContext），供 execute 获取读写/确认/委派等能力 */
  private makeContext(agent: AgentDef): ToolContext {
    return {
      projectId: this.projectId,
      sessionId: this.sessionId,
      agent: agent.id,
      signal: this.abort.signal,
      confirm: (action, summary) => this.io.confirm(action, summary),
      askUser: (q, options) => this.io.askUser(q, options),
      showProposal: (text) => this.io.onEvent({ type: "proposal", text }),
      // 以方法暴露而非裸 Map：approved / base 这些不变量只能在这里改
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
      runSubagent: (agentId, prompt) => this.runSubagent(agentId, prompt),
      loadSkill: (name) => loadSkillByName(this.projectId, name).then((s) => s?.body),
      saveChapter: (filename, content) => saveChapter(this.projectId, filename, content),
    };
  }

  /** task 委派：子会话独立上下文，只传 prompt，返回最终正文 */
  private async runSubagent(agentId: string, prompt: string): Promise<string> {
    const sub = this.agents.get(agentId);
    if (sub.mode !== "subagent") throw new Error(`agent ${agentId} 不是 subagent，不能 task 委派`);
    if (this.depth >= 2) throw new Error("子代理深度超限（task 嵌套最多 2 层）");

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
    if (!isOverBudget(all)) return;
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
