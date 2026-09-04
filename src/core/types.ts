/**
 * talemate 共享类型。语义基准：04-harness-design.md（P0 基础设施，轻栈：TS+Bun、无 Effect、文件系统存储）。
 */

/** Provider 抽象：anthropic 原生 + openai 兼容（DeepSeek/Moonshot 等经 baseURL 指向）+ mock（离线冒烟） */
export type Provider = "anthropic" | "openai" | "mock";

/** 推理强度：off=关；low/high/max=开（DeepSeek 等生效） */
export type Reasoning = "off" | "low" | "high" | "max";

/** 模型配置：每角色可覆盖（talemate.json 里 agents.<id>），缺省读环境 */
export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens: number;
  reasoning: Reasoning;
  temperature?: number;
}

/** 角色模式：primary=日常对话面；subagent=只能被 task 委派 */
export type AgentMode = "primary" | "subagent";

/** 声明式角色定义（纯数据，注册表持有；talemate.json 可覆盖 model 等字段） */
export interface AgentDef {
  id: string; // "editor" | "planner" | "writer" | …
  name: string; // 显示名（主编 / 规划 / 写手）
  description: string; // 何时选它（task 路由 / 用户可见）
  mode: AgentMode;
  tools: string[]; // 该角色可见工具 id 列表
  system: string; // 角色 system prompt
  model?: ModelConfig; // 缺省继承项目默认模型
  steps?: number; // 本轮最多多少步（防跑飞）
}

/** ─── 工具 ─── */

/** 一个工具的入参 JSON Schema（阶段一：极简 JSONSchema 子集） */
export type JsonSchema = {
  type: "object";
  properties?: Record<
    string,
    { type: string; description?: string; enum?: string[]; items?: { type: string } }
  >;
  required?: string[];
  description?: string;
};

/** 工具执行环境：循环提供给 execute 的能力（会话上下文） */
export interface ToolContext {
  projectId: string;
  sessionId: string;
  agent: string;
  /** 向用户展示一次性确认（落盘/覆盖前） */
  confirm(action: string, summary: string): Promise<boolean>;
  /** 向用户提问要创作决策（非审批），返回答案文本 */
  askUser(question: string, options?: string[]): Promise<string>;
  /** 读取一个活文档文件内容（docs/ 下），不存在返回 undefined */
  readDoc(name: string): Promise<string | undefined>;
  /** 写/覆盖活文档（docs/ 下），返回完整路径 */
  writeDoc(name: string, content: string): Promise<string>;
  /** 列项目 docs/ */
  listDocs(): Promise<string>;
  /** 把一个子 agent 当 subagent 跑（只传 prompt 文本，独立上下文），返回其正文 */
  runSubagent(agentId: string, prompt: string): Promise<string>;
  /** 读指定 skill 正文 */
  loadSkill(name: string): Promise<string | undefined>;
  /** 成品落 chapters/（返回完整路径） */
  saveChapter(filename: string, content: string): Promise<string>;
  /** 中止信号 */
  signal: AbortSignal;
}

export interface ToolResult {
  output: string; // 回灌模型的文本
  title?: string; // UI 即时标题
  metadata?: Record<string, unknown>; // 结构化信息
}

export interface ToolDef<Args = unknown> {
  id: string;
  description: string; // 给模型的说明（写清何时用/边界/用法）
  input: JsonSchema;
  /** 返回该调用是否需要人类确认；需要则返回给用户看的摘要 */
  needsConfirm?(args: Args): string | undefined;
  execute(args: Args, ctx: ToolContext): Promise<ToolResult>;
}

/** ─── 消息模型（持久化 messages.jsonl 的一行 = 一条消息） ─── */

export type ToolState = "pending" | "running" | "completed" | "error";

/** 一次工具调用（模型返回，待执行） */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** assistant 消息内容单元 */
export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      state: ToolState;
      input?: string;
      output?: string;
      error?: string;
      time?: { ran?: number; completed?: number };
    };

export type MessageRole = "user" | "assistant" | "system" | "compaction";

/** 持久化消息。role=compaction 时 summary+recent 承载前情摘要（§8 设计）。 */
export interface StoredMessage {
  seq: number;
  role: MessageRole;
  /** user/assistant 消息绑定产生它的角色 */
  agent?: string;
  ts: number;
  /** role=user/system：文本 */
  text?: string;
  /** role=assistant：内容单元 */
  parts?: AssistantPart[];
  finish?: "stop" | "tool_calls" | "error";
  /** role=compaction */
  summary?: string;
  recent?: string;
  model?: string;
}

/** ─── 会话 ─── */

export interface SessionMeta {
  id: string;
  projectId: string;
  title: string;
  agent: string; // 当前角色
  model?: ModelConfig;
  time: { created: number; updated: number };
}

/** ─── 项目 ─── */

export interface ProjectMeta {
  id: string;
  title: string;
  genre?: string;
  createdAt: number;
  /** 角色覆盖（talemate.json agents.<id> 可覆盖 model/system 等） */
  agents?: Record<string, Partial<AgentDef>>;
  /** 项目级 AGENTS.md 之外的补充说明（可选） */
  notes?: string;
}

/** ─── LLM 事件（CLI 打印 / 未来 SSE 用） ─── */

export type LLMEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: string }
  | { type: "step.start" }
  | { type: "step.end"; finish: "stop" | "tool_calls" | "error" }
  | { type: "session.status"; status: "busy" | "idle" };
