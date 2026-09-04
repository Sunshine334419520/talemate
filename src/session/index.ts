/**
 * Session 运行时：把一条用户消息跑完一轮 agent 循环。
 *
 * 结构（借用 opencode V2 干净循环 + 去 Effect）：
 *   post(user) → 落 user 消息 → while true:
 *     读历史(loadModelWindow，最新 compaction 之后) → 转 NeutralMsg
 *     → buildSystemPrompt(角色 system + AGENTS.md + skills 目录)
 *     → llm.chat(tools=该角色可见) → 若返回 toolCalls：执行并内嵌结果落一条 assistant → continue
 *     → 无 toolCalls：落带正文的 assistant → break
 *
 * 存储模型：一条 assistant 存储消息 = 一次模型回复，工具调用与结果内嵌其 parts；
 * 转 NeutralMsg 时展开成 assistant(toolCalls) + 各 role:"tool" 结果（见 context/toNeutralMessages）。
 */
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../agent";
import { loadModelConfig } from "../core/config";
import type { AgentDef, AssistantPart, LLMEvent, ModelConfig, ProjectMeta, ToolCall, ToolContext } from "../core/types";
import { buildSystemPrompt, toNeutralMessages } from "../context";
import { chat, type NeutralMsg } from "../llm";
import { discoverSkills, loadSkillByName, renderSkillCatalog } from "../skill";
import * as store from "../storage";
import { ToolRegistry } from "../tool";
import { BUILTIN_TOOLS } from "../tool/builtin";

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
    await store.createSession(this.projectId, {
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

  /** 跑完一轮：输入 → agent 循环 → 返回最终 assistant 正文（供 CLI/task 拿结果） */
  async post(input: string, opts?: { agentId?: string }): Promise<string> {
    const agentId = opts?.agentId ?? this.agentId;
    const agent = this.agents.get(agentId);
    this.io.onEvent({ type: "session.status", status: "busy" });

    // 1) 落 user 消息
    await store.appendMessage(this.projectId, this.sessionId, { role: "user", agent: agentId, text: input });

    // 2) 工具循环
    let lastText = "";
    const steps = agent.steps ?? 10;
    for (let step = 0; step < steps; step++) {
      this.io.onEvent({ type: "step.start" });
      // 3) 组装本次请求
      const all = await store.loadMessages(this.projectId, this.sessionId);
      const window = store.loadModelWindow(all);
      const neutral: NeutralMsg[] = toNeutralMessages(window);
      const system = await this.buildSystem(agent);
      const toolSchemas = this.tools.schemasFor(agent.tools);

      // 4) 调用 LLM（流式 delta 转发给 io）
      const turn = await chat({
        model: this.model,
        system,
        messages: neutral,
        tools: toolSchemas.length ? toolSchemas : undefined,
        signal: this.abort.signal,
        onText: (d) => this.io.onEvent({ type: "text.delta", text: d }),
        onReasoning: (d) => this.io.onEvent({ type: "reasoning.delta", text: d }),
      });

      // 5) 执行工具（内嵌进本条 assistant 的 parts）
      const parts: AssistantPart[] = [];
      if (turn.reasoning) parts.push({ type: "reasoning", text: turn.reasoning });
      if (turn.text) parts.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls) {
        parts.push(await this.runTool(agent, call, parts));
      }

      // 6) 落一条 assistant（含工具结果），判断是否继续
      await store.appendMessage(this.projectId, this.sessionId, {
        role: "assistant",
        agent: agentId,
        parts,
        finish: turn.toolCalls.length ? "tool_calls" : "stop",
        model: this.model.model,
      });

      this.io.onEvent({ type: "step.end", finish: turn.toolCalls.length ? "tool_calls" : "stop" });
      lastText = parts
        .filter((p): p is Extract<AssistantPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("");

      if (!turn.toolCalls.length) break;
      // 有工具调用 → 工具结果已内嵌在 parts，下一轮会以 role:"tool" 回放
    }

    this.io.onEvent({ type: "session.status", status: "idle" });
    return lastText;
  }

  /** 执行一次工具调用，返回它对应的 tool part（completed/error），并把交互转给 io/子会话 */
  private async runTool(agent: AgentDef, call: ToolCall, _siblings: AssistantPart[]): Promise<AssistantPart> {
    const tool = this.tools.has(call.name) ? this.tools.get(call.name) : undefined;
    const ctx = this.makeContext(agent);
    const base: AssistantPart = {
      type: "tool",
      id: call.id,
      name: call.name,
      state: "running",
      input: call.input ? JSON.stringify(call.input) : undefined,
      time: { ran: Date.now() },
    };
    if (!tool) {
      return { ...base, state: "error", error: `未知工具 ${call.name}`, time: { ...base.time, completed: Date.now() } };
    }
    // 极简权限：工具声明了 needsConfirm 就先问用户
    if (tool.needsConfirm) {
      const summary = tool.needsConfirm(call.input as never);
      if (summary) {
        const ok = await ctx.confirm(tool.id, summary);
        if (!ok) {
          return { ...base, state: "error", error: "用户拒绝了该操作", time: { ...base.time, completed: Date.now() } };
        }
      }
    }
    try {
      const args = call.input as never;
      const res = await tool.execute(args, ctx);
      return { ...base, state: "completed", output: res.output, time: { ...base.time, completed: Date.now() } };
    } catch (e) {
      return {
        ...base,
        state: "error",
        error: e instanceof Error ? e.message : String(e),
        time: { ...base.time, completed: Date.now() },
      };
    }
  }

  private makeContext(agent: AgentDef): ToolContext {
    return {
      projectId: this.projectId,
      sessionId: this.sessionId,
      agent: agent.id,
      signal: this.abort.signal,
      confirm: (action, summary) => this.io.confirm(action, summary),
      askUser: (q, options) => this.io.askUser(q, options),
      readDoc: (name) => store.readDoc(this.projectId, name),
      writeDoc: (name, content) => store.writeDoc(this.projectId, name, content),
      listDocs: async () => {
        const docs = await store.listDocs(this.projectId);
        return `docs/\n${docs.map((d) => `  - ${d}`).join("\n") || "  （空）"}`;
      },
      runSubagent: (agentId, prompt) => this.runSubagent(agentId, prompt),
      loadSkill: (name) => loadSkillByName(this.projectId, name).then((s) => s?.body),
      saveChapter: (filename, content) => store.saveChapter(this.projectId, filename, content),
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

  private async buildSystem(agent: AgentDef): Promise<string> {
    const rules = await store.readProjectRules(this.projectId);
    const skills = await discoverSkills(this.projectId);
    return buildSystemPrompt({
      projectTitle: this.meta.title,
      agentName: agent.name,
      roleSystem: agent.system,
      rules,
      skills: renderSkillCatalog(skills),
    });
  }
}

/** 打开（或新建并落盘）一个项目会话，返回可 post 的 Session */
export async function openSession(deps: SessionDeps): Promise<Session> {
  const meta = await store.loadProjectMeta(deps.projectId);
  const agents = new AgentRegistry();
  agents.applyProject(meta);
  const tools = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) tools.register(t);
  const model = deps.model ?? loadModelConfig();
  const session = new Session({ ...deps, meta, agents, tools, model });
  if (!deps.sessionId) await session.saveMeta(deps.title);
  return session;
}
