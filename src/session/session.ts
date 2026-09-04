/**
 * Session：一个项目上下文里的会话。它只做两件事——
 * 1) 持有会话状态（id/项目/角色/模型/IO/data）、落盘会话元、可中止；
 * 2) 当接线器：把 storage / LLM / 工具 / 上下文组装成 LoopDeps，交给 session/loop 的 runLoop 去跑。
 *
 * 循环本身不在 Session 里（见 loop.ts）。Session 不自造循环，只把"这次请求怎么取历史、怎么生成、
 * 怎么执行工具、怎么落盘"这些能力喂给 runLoop。
 *
 * 消息读取做了内存缓存：一次 post() 里只有首次读盘，之后每次 append 都同步 push 进内存，
 * buildRequest 从内存取、不再每步重读整个 messages.jsonl。
 */
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../agent/registry";
import { loadModelConfig } from "../core/config";
import type { AgentDef, AssistantPart, LLMEvent, ModelConfig, ProjectMeta, StoredMessage, ToolContext } from "../core/types";
import { buildSystemPrompt, toNeutralMessages } from "../context/assemble";
import { chat } from "../llm/provider";
import type { NeutralMsg, ToolSchema } from "../llm/types";
import { discoverSkills, loadSkillByName, renderSkillCatalog } from "../skill/discovery";
import { listDocs, loadProjectMeta, readDoc, readProjectRules, saveChapter, writeDoc } from "../storage/project";
import { appendMessage, createSession, loadMessages, loadModelWindow } from "../storage/session-store";
import { BUILTIN_TOOLS } from "../tool/builtin";
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

  /** 跑完一轮：输入 → runLoop（agent 循环）→ 返回最终 assistant 正文 */
  async post(input: string, opts?: { agentId?: string }): Promise<string> {
    const agentId = opts?.agentId ?? this.agentId;
    const agent = this.agents.get(agentId);

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
      executeTool: (ag, call) => executeToolPart(agentId, call, this.tools, this.makeContext(agent)),
      commitAssistant: (msg) => this.persistAssistant(msg.agent, msg.parts, msg.finish),
    });
  }

  /** 组装一次请求：截窗后的历史 → NeutralMsg + system + 该角色可见工具 */
  private async buildRequest(agent: AgentDef): Promise<{ system: string; messages: NeutralMsg[]; tools?: ToolSchema[] }> {
    const neutral = toNeutralMessages(await this.messageWindow());
    const system = await this.buildSystem(agent);
    const toolSchemas = this.tools.schemasFor(agent.tools);
    return { system, messages: neutral, tools: toolSchemas.length ? toolSchemas : undefined };
  }

  /** 拼 system prompt：env(在 buildSystemPrompt 里) + 角色 system + AGENTS.md + skill 目录 */
  private async buildSystem(agent: AgentDef): Promise<string> {
    const rules = await readProjectRules(this.projectId);
    const skills = await discoverSkills(this.projectId);
    return buildSystemPrompt({
      projectTitle: this.meta.title,
      agentName: agent.name,
      roleSystem: agent.system,
      rules,
      skills: renderSkillCatalog(skills),
    });
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
      readDoc: (name) => readDoc(this.projectId, name),
      writeDoc: (name, content) => writeDoc(this.projectId, name, content),
      listDocs: async () => {
        const docs = await listDocs(this.projectId);
        return `docs/\n${docs.map((d) => `  - ${d}`).join("\n") || "  （空）"}`;
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
    const m = await compact({
      projectId: this.projectId,
      sessionId: this.sessionId,
      model: this.model,
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
