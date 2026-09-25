/** talemate 跨层共享类型。轻栈：TS + Bun、无 Effect、文件系统存储。 */
import type { Action, PermissionConfig, PermissionName } from "../permission";

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
  id: string; // "mate" | "writer" | …
  name: string; // 显示名（搭档 / 写手）
  description: string; // 何时选它（task 路由 / 用户可见）
  mode: AgentMode;
  tools: string[]; // 该角色可见工具 id 列表（**广告**；执行边界是 permission）
  system: string; // 角色 system prompt
  /** 这个角色自己的权限规则（配置形），拼在内置默认之后、模式之前。缺省 = 全用默认 */
  permission?: PermissionConfig;
  model?: ModelConfig; // 缺省继承项目默认模型
  steps?: number; // 本轮最多多少步（防跑飞）
  /** 内部隐藏 agent（如 summarizer）：不参与 /agent 切换、不进 task 可派列表、不当默认 primary。 */
  hidden?: boolean;
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

/**
 * 一份待用户拍板的设计提案（propose → apply 的中转态）。
 * apply-design 不收正文、只写这里存的那份，所以"用户看过的 == 落盘的"由构造保证。
 */
/**
 * `propose-plan` 登记的章节节拍在待执行表里的键。节拍**没有目标文件**（不落盘），所以它占一个
 * 保留键；设计文档的键一定是 design/ 下的路径，撞不上。
 */
export const PLAN_KEY = "__plan__";

export interface PendingProposal {
  /**
   * 目标活文档的**项目相对路径**（`design/core.md`）；节拍提案是 `PLAN_KEY`——它**不是一个路径**，
   * 所以这个字段叫 `name` 而不是 `path`：它装的是"这份提案的键"。
   */
  name: string;
  /** 将落盘的正文：提案=整篇全文；节拍=节拍全文 */
  content: string;
  /**
   * 提案时的整篇快照——落盘前校验文档未被改过，变了要求重新提案（CAS 的基准）。
   *
   * **提案永远是整篇**：局部修改走二向的 `edit`，不进提案。所以没有"只改一格"的提案这一说，
   * 也就没有那个曾经的 `section` 字段——"我只动了第 3 格"由提案渲染里的 `★本版改动` 表达。
   */
  base?: string;
  /** 仅节拍提案：这一章在用户面前叫什么（如"第 1 章"）。让待办注记在压缩之后还能自己说清是哪一章 */
  chapter?: string;
  /** 用户已回话表示同意。**由 harness 判定**（见 Session 里按用户回话匹配同意词），不由模型自述 */
  approved: boolean;
  at: number;
}

/**
 * 一次文件改动的**字节级**描述。四个 kind，**零领域知识**——不认识"小节""角色卡""层"。
 *
 * 领域语义（"改某一格"）不占 op 种类：它在工具层派生成 `replace` 的 (find, replace)。
 * 这样加一种新文档形状不必加新 op，写盘路径也只有一条。
 *
 * `path` 是**项目相对路径**（`design/core.md` / `chapters/chapter_ch1_v1.md`）——
 * 与权限的 `pattern` 同一个口径，两者不会各说各话。
 */
export type FileOp =
  /** 整篇：新建或覆盖。 */
  | { kind: "write"; path: string; content: string }
  /** 局部：把 find 换成 replace。find 必须非空且唯一（`all` 时例外）。 */
  | { kind: "replace"; path: string; find: string; replace: string; all?: boolean }
  // 没有 `append`。它一度在（"末尾加一节"），但**没有任何工具会产出它**——末尾追加拿尾块当锚点
  // 就是一次普通的 `replace`，而进不了 op 的东西留着只会让"四个 kind"这句话不成立。
  /** 删掉整个文件。 */
  | { kind: "delete"; path: string };

/** 工具执行环境：循环提供给 execute 的能力（会话上下文） */
export interface ToolContext {
  projectId: string;
  sessionId: string;
  agent: string;
  /**
   * **原始**确认口，不走权限。只有 `ask`（它要拿它当弹窗）和 `confirm` 工具该调它；
   * 其余工具一律走 `ask`——那才是带权限判定的那道口。
   */
  confirm(action: string, summary: string): Promise<ConfirmReply>;
  /** 纯求值：这个 `(permission, pattern)` 现在会怎么处理。**不打扰用户**——runner 的兜底用它。 */
  check(permission: PermissionName, pattern: string): Action;
  /** 求值 + 该问就问：`ask` 那一档弹给用户，并按答复记下「以后都允许」。所有改世界的工具走这一个口。 */
  ask(req: PermissionRequest): Promise<PermissionVerdict>;
  /** 向用户提问要创作决策（非审批），返回答案文本 */
  askUser(question: string, options?: string[]): Promise<string>;
  /** 把一份待审阅的提案整块展示给用户（只读、无返回值）——走事件通道，CLI/TUI 各自渲染 */
  showProposal(text: string): void;
  getProposal(name: string): PendingProposal | undefined;
  /** 替换时 approved 一律重置为 false——用户没见过新版就不算同意 */
  setProposal(p: PendingProposal): void;
  clearProposal(name: string): void;
  /** 切换会话模式（见 agent/modes.ts）；undefined = 回到普通模式 */
  setMode(mode: string | undefined): void;
  /**
   * 当前模式 id，没进模式 → undefined。
   *
   * 给"只在某种模式里才有意义"的工具做前置用：`propose-design` / `propose-plan` 是三向的出口，
   * 不在草稿模式里就没有三向可谈——它们据此回一句自愈文案，让模型先把模式切过去。
   */
  getMode(): string | undefined;
  /**
   * 读一份文档（**项目相对**路径：`design/core.md` / `chapters/chapter_ch1_v1.md`），不存在 → undefined。
   *
   * **读口留着，写口没有**：改文件一律走 `framework/write_ops` 那一条路径。
   * 从前这里还挂着 `writeDesign` / `removeDesign` / `saveChapter` 三个裸写方法，任何工具都能绕过
   * 整套变换、CAS 与权限——`save-chapter` 当年就是那么绕过去的。删掉它们之后，"唯一写路径"
   * 不再是一句约定，而是**类型上只有一个口**。
   *
   * 三个口都**不预设管辖范围**（没有"design 版"的方法）：`prefix` 由调用工具给。
   * 从前它们分别叫 `readDesign` / `listDesigns` / `searchDesigns`，把"只管 design/"焊进了名字里，
   * 于是章节读不到、`listChapters` 成了没人调的死方法。
   */
  readDoc(path: string): Promise<string | undefined>;
  /** 某一段语料的目录（渲染好的文本，含每个文档的一级小节标题）。`prefix` 是项目相对前缀，如 `design/` */
  listIndex(prefix: string): Promise<string>;
  /** 跨一段语料扫词（渲染好的命中表）：改/删前查引用、看影响面。`prefix` 同上 */
  searchDocs(query: string, prefix: string): Promise<string>;
  /** 把一个子 agent 当 subagent 跑（只传 prompt 文本，独立上下文），返回其正文 */
  runSubagent(agentId: string, prompt: string): Promise<string>;
  loadSkill(name: string): Promise<string | undefined>;
  signal: AbortSignal;
}

export interface ToolResult {
  output: string; // 回灌模型的文本
  title?: string; // UI 即时标题
  metadata?: Record<string, unknown>; // 结构化信息
}

/** 用户对一次确认的答复。`always` = 这一类以后都别问（记进会话级 approved 表，重启即清）。 */
export type ConfirmReply = "once" | "always" | "no";

/** 权限请求：工具在执行前声明"我要做这个动作、对什么做"。 */
export interface PermissionRequest {
  permission: PermissionName;
  /** 这次的具体对象：文件路径 / 子代理 id / URL。通配符匹配，`*` 跨 `/`。 */
  pattern: string;
  /** 用户选「以后都允许」时记下哪条规则（通常比 pattern 更宽的式样） */
  always?: string;
  /** 弹给用户的标题 */
  summary: string;
  /** 弹给用户**做判断的材料**（改文件时是 diff，委派子代理时是 prompt 规模等）。 */
  detail?: string;
}

/** `allow` 做了 · `reject` 用户拒了 · `deny` 规则不许 */
export type PermissionVerdict = "allow" | "reject" | "deny";

export interface ToolDef<Args = unknown> {
  id: string;
  description: string; // 给模型的说明（写清何时用/边界/用法）
  input: JsonSchema;
  /**
   * 这个工具属于哪一类动作。**没有 = 不改变世界，不要权限**（读设计、取规范、提案、模式切换）。
   * 两处用它：runner 做粗粒度兜底（`deny *` 的类别一律拒，哪怕工具是被幻觉调出来的），
   * session 把被禁的工具从 schema 里剔掉（`permission.visibleTools`）。
   */
  permission?: PermissionName;
  /**
   * 该工具**成功后结束本回合**，把控制权交回用户（如 propose-design：结论提出来了，该用户说话了）。
   * 只在 state==="completed" 时生效——校验失败必须留给模型同轮自纠，否则循环会死在一个本可自愈的错误上。
   */
  halt?: boolean;
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
      /** 该工具要求结束本回合（见 ToolDef.halt）；loop 据此在提交本条后 break */
      halt?: boolean;
      time?: { ran?: number; completed?: number };
    };

export type MessageRole = "user" | "assistant" | "system" | "compaction";

/** 持久化消息。role=compaction 时 summary+recent 承载前情摘要。 */
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
  /** 角色覆盖（talemate.json agents.<id> 可覆盖 model/system/permission 等） */
  agents?: Record<string, Partial<AgentDef>>;
  /**
   * 这个项目的权限规则（配置形）——规则表的**最后一层、最高优先级**。
   * 典型用法是"放宽大部分、收紧一个"：`{ edit: { "*": "allow", "design/core.md": "ask" } }`。
   * 但 `deny` 单调：模式写的 deny 压得过这里（见 docs/permissions.md）。
   */
  permissions?: PermissionConfig;
  /** 项目级 AGENTS.md 之外的补充说明（可选） */
  notes?: string;
}

/** ─── LLM 事件（CLI 打印 / 未来 SSE 用） ─── */

export type LLMEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: string }
  | { type: "tool.result"; id: string; name: string; output: string }
  | { type: "scope.open"; label: string }
  | { type: "scope.close"; label: string }
  /** 只读展示给用户的块（提案逐格清单等）——无返回值，与 confirm/askUser 的交互式提示区分 */
  | { type: "proposal"; text: string }
  | { type: "step.start" }
  | { type: "step.end"; finish: "stop" | "tool_calls" | "error" }
  | { type: "session.status"; status: "busy" | "idle" };
