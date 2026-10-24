/** talemate 跨层共享类型。轻栈：TS + Bun、无 Effect、文件系统存储。 */
import type { Action, PermissionConfig, PermissionName } from "../permission";

/** provider：anthropic 原生、openai 兼容（DeepSeek/Moonshot 等经 baseURL 指向）、mock（离线冒烟） */
export type Provider = "anthropic" | "openai" | "mock";

/** 推理强度；off=关，其余三档为开，只在 DeepSeek 等支持推理的 provider 上生效 */
export type Reasoning = "off" | "low" | "high" | "max";

/** 模型配置；每角色可覆盖（talemate.json 的 agents.<id>），缺省从环境变量读 */
export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens: number;
  reasoning: Reasoning;
  temperature?: number;
}

/**
 * 联网设置：用户级、跨作品，存在 `<talemateHome>/web.json`。
 *
 * 配了 DeepSeek key，`webfetch` / `websearch` 就优先走 DeepSeek 的 Search / Fetch API
 * （与模型调用同一把 key，按次计费）；不配则维持原来的直连抓取与 Tavily/Bocha/Exa/DDG 搜索。
 * 它不跟书走：同一台机器上的联网能力是作者的，不是某一部小说的设定。
 */
export interface WebSettings {
  deepseek?: {
    apiKey?: string;
    /** 含 `/v1/tools` 前缀；程序追加 `/search` 或 `/fetch`。默认 https://api.deepseek.com/v1/tools */
    baseURL?: string;
    /** 每次搜索请求的结果数（1–50）；缺省 10 */
    count?: number;
  };
}

/** 角色模式：primary 是日常对话面，subagent 只能被 task 委派 */
export type AgentMode = "primary" | "subagent";

/** 声明式角色定义：纯数据、注册表持有，talemate.json 可覆盖 model 等字段 */
export interface AgentDef {
  id: string; // "mate" | "planner" | "researcher" | …
  name: string; // 显示名（搭档 / 写手）
  description: string; // 何时选它（task 路由 / 用户可见）
  mode: AgentMode;
  tools: string[]; // 该角色可见工具 id 列表——是广告，不是执行边界（边界是 permission）
  system: string;
  /** 这个角色的权限规则（配置形），拼在内置默认之后、模式之前；缺省即全用默认 */
  permission?: PermissionConfig;
  model?: ModelConfig; // 缺省继承项目默认模型
  steps?: number; // 本轮最多多少步，防跑飞
  /** 内部隐藏 agent（如 summarizer）：不参与 /agent 切换、不进 task 可派列表、不当默认 primary */
  hidden?: boolean;
}

/** ─── 工具 ─── */

/** 工具入参的 JSON Schema；只支持 JSONSchema 的一个极小子集（可递归） */
export type JsonSchema =
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "number"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchema }
  | {
      type: "object";
      description?: string;
      properties?: Record<string, JsonSchema>;
      required?: string[];
    };

/** 一条提问选项：label 是用户看见、也是回传的值；description 讲取舍。 */
export interface AskOption {
  label: string;
  description?: string;
}

/**
 * 一条要用户回答的问题。
 *
 * JSON 里字段叫 `multi_select`（模型侧），域模型用 `multiSelect`——工具 execute 负责映射。
 * 推荐项不另设字段：label 以「（推荐）」或「(Recommended)」结尾，UI 只认这一种写法。
 */
export interface AskQuestion {
  id: string;
  header?: string;
  question: string;
  options?: AskOption[];
  multiSelect?: boolean;
}

/** 一项答案。`selected` 为空且没有 `custom` = 用户明确跳过；这不是 pending，也不是同意。 */
export interface AskAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

/** 一次提问的请求：交付层据 timeoutMs 决定什么时候返回 pending。 */
export interface AskRequest {
  callId: string;
  questions: AskQuestion[];
  /** 等待毫秒数；undefined = 不限时（只有用户明确要求“等到我答”时才用）。 */
  timeoutMs?: number;
  /** 用户中止这一轮时，交付层据此把问题转成 pending，而不是永远挂着。 */
  signal?: AbortSignal;
}

/**
 * 一次提问的结局。`pending` 不是答案：它是“这一轮先停，问题仍可回答”，
 * 因此调用方必须 halt，且绝不能把沉默当成同意。
 */
export type AskOutcome =
  | { kind: "answered"; answers: AskAnswer[] }
  | { kind: "pending"; callId: string }
  | { kind: "cancelled"; reason: "no-answerer" | "aborted" };

/** 提案卡的一格：标题 + 正文 + 两个展示标记。 */
export interface ProposalDisplaySection {
  heading: string;
  body: string;
  /** 这一格还没填（空 / 只有占位） */
  blank: boolean;
  /** 与上一版相比改过 */
  changed: boolean;
}

/**
 * 提案的结构化视图：界面按它画标题、分格与 markdown；CLI 仍可用同一份 `text`。
 *
 * 它只描述“怎么展示”，不改变“什么会落盘”——落盘内容仍是提案登记里的 `content`。
 */
export interface ProposalDisplay {
  kind: "design" | "plan";
  /** 卡片标题：角色：陆敬斋 / 核心层 / 第 4 章 · 规划 */
  title: string;
  /** 格数、待定数等一行小字 */
  subtitle?: string;
  /** 额外提醒（如核心设定被外部改写） */
  warning?: string;
  /** 替换了上一版时的说明 */
  previousNote?: string;
  /** 不在任何格里的开头/导语；与标题相同的 H1 已被去掉，空则不显示 */
  loose?: string;
  looseChanged?: boolean;
  sections: ProposalDisplaySection[];
  /** 整篇散文（规划 / 无格文档）的正文；有 sections 时为空 */
  body?: string;
  /** 还没定的格提示 */
  blankNote?: string;
}

/** 一次提问的结构化记录：挂在 tool part 上落盘，界面据此回看。 */
export interface AskRecord {
  callId: string;
  questions: AskQuestion[];
  outcome: "answered" | "pending" | "cancelled";
  answers?: AskAnswer[];
  at: number;
}

/**
 * 未答提问的 write-ahead 记录：只覆盖“提问已开始、助手消息还没提交”那段窗口。
 * 助手消息一旦落盘，问题就从 tool part 投影；这个文件随即清掉，不是第二份真相。
 */
export interface PendingAskRecord {
  callId: string;
  questions: AskQuestion[];
  at: number;
}

/**
 * `propose-plan` 登记的章节规划在待执行表里的键。
 *
 * 用保留键而不是路径：待执行表的键对文档提案来说是落盘目标（`write_ops` 的 `via:"pending"` 拿它
 * 去取 op），而规划不走那条路——它落 `.talemate/plans/`（引擎工作区），由 `framework/plan.ts`
 * 自己写。设计文档的键一定是 `design/` 下的路径，撞不上。
 */
export const PLAN_KEY = "__plan__";

/**
 * 一份待用户拍板的设计提案（propose → apply 的中转态）。
 * apply-design 不收正文、只写这里存的那份，所以"用户看过的 == 落盘的"由构造保证。
 */
export interface PendingProposal {
  /**
   * 目标活文档的项目相对路径（`design/core.md`）；规划提案是 `PLAN_KEY`——那不是路径，
   * 所以字段叫 `name` 而不是 `path`：它装的是这份提案的键。
   */
  name: string;
  /** 正文：文档提案 = 将落盘的整篇全文；规划 = 那一份规划（落 `.talemate/plans/`） */
  content: string;
  /**
   * 提案时的整篇快照——落盘前校验文档未被改过，变了要求重新提案（CAS 的基准）。
   *
   * 提案永远是整篇：局部修改走二向的 `edit`，不进提案，所以不存在"只改一格"的提案。
   */
  base?: string;
  /**
   * 仅规划提案：这份规划是第几章的。
   *
   * 存章号而不是展示用字符串，是因为它有两个活儿：待办注记靠它说清"这是哪一章的规划"，
   * 工件路径（`.talemate/plans/ch_<N>.md`）也靠它算出来——一份规划只有一个出处。
   */
  chapter?: number;
  /** 用户已回话表示同意；由 harness 按用户回话匹配同意词判定，不由模型自述 */
  approved: boolean;
  /**
   * 仅规划提案：这一章的正文已经落盘了。
   *
   * 是标记，不是删除：规划正文只活在 `pending` 的 `content` 里（工件在 `.talemate/plans/`，
   * 而 `.talemate/` 不在 `DOC_ROOTS`，`read` / `list` / `search` 都够不着它），删掉条目就成了
   * "用户说改第 2 条时谁也读不到第 2 条"；留着只多一行注记。
   * 置位者是 harness（正文落盘那一刻），不由模型自述——同 `approved`。
   */
  done?: boolean;
  at: number;
}

/**
 * 一次文件改动的字节级描述：四个 kind，零领域知识——不认识"小节""角色卡""层"。
 *
 * 领域语义（"改某一格"）不占 op 种类，它在工具层派生成 `replace` 的 (find, replace)，
 * 所以加一种新文档形状不必加新 op，写盘路径也只有一条。
 *
 * `path` 是项目相对路径，与权限的 `pattern` 同一个口径，两者不会各说各话。
 */
export type FileOp =
  | { kind: "write"; path: string; content: string }
  /** 局部：把 find 换成 replace。find 必须非空且唯一（`all` 时例外）。 */
  | { kind: "replace"; path: string; find: string; replace: string; all?: boolean }
  | { kind: "delete"; path: string };

/** 工具执行环境：循环提供给 execute 的能力（会话上下文） */
export interface ToolContext {
  projectId: string;
  sessionId: string;
  agent: string;
  /** 当前这次工具调用的 id——ask-user 用它把 pending 的回答关联回这次调用。 */
  callId: string;
  /**
   * 发起这一轮的用户消息 seq。文件回退快照按它归组——回退到某条消息时，要还原的就是
   * 那条消息之后（含这一轮）所有写过的文件。没有（首轮之前）就不记快照。
   */
  turnSeq?: number;
  /**
   * 原始确认口，不走权限：只有 `ask`（拿它当弹窗）和 `confirm` 工具该调它，其余工具一律走 `ask`
   * ——那才是带权限判定的那道口。
   */
  confirm(action: string, summary: string): Promise<ConfirmReply>;
  /** 纯求值：这个 `(permission, pattern)` 现在会怎么处理，不打扰用户——runner 的兜底用它 */
  check(permission: PermissionName, pattern: string): Action;
  /** 求值 + 该问就问：`ask` 那一档弹给用户，并按答复记下「以后都允许」；所有改世界的工具走这一个口 */
  ask(req: PermissionRequest): Promise<PermissionVerdict>;
  /** 向用户提问要创作决策（非审批）。answered 才带答案；pending 必须 halt，且不是同意 */
  askUser(req: AskRequest): Promise<AskOutcome>;
  /**
   * 把一份待审阅的提案展示给用户（只读、无返回值）——走事件通道。
   * `text` 是终端视图；`view` 是结构化的卡片视图（标题、分格、markdown）。
   */
  showProposal(text: string, view?: ProposalDisplay): void;
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
   * 读一份文档（项目相对路径：`design/core.md` / `chapters/chapter_ch1_v1.md`），不存在 → undefined。
   *
   * 读口留着，写口没有：改文件一律走 `framework/write_ops` 那一条路径——留一个裸写方法，任何工具
   * 都能绕开整套变换、CAS 与权限，所以"唯一写路径"要靠类型上只有一个口来保证。
   *
   * 三个口都不预设管辖范围（没有"design 版"的方法），`prefix` 由调用工具给。
   */
  readDoc(path: string): Promise<string | undefined>;
  /** 某一段语料的目录（渲染好的文本，含每个文档的一级小节标题）。`prefix` 是项目相对前缀，如 `design/` */
  listIndex(prefix: string): Promise<string>;
  /** 跨一段语料扫词（渲染好的命中表）：改/删前查引用、看影响面。`prefix` 同上 */
  searchDocs(query: string, prefix: string): Promise<string>;
  /**
   * 把一个子 agent 当 subagent 跑（只传 prompt 文本，独立上下文），返回其正文与子会话 id。
   *
   * 子会话 id 不是给人看的：轨迹视图与调试命令靠它找回那一次委派的完整过程
   * （子会话不在左栏会话列表里，见 `storage/session-store.ts` 的 `isSubagentSession`）。
   */
  runSubagent(agentId: string, prompt: string): Promise<{ text: string; sessionId: string }>;
  loadSkill(name: string): Promise<string | undefined>;
  /**
   * 联网设置（DeepSeek Search / Fetch）。
   *
   * 从 ctx 来而不是让 `web_tools` 自己读盘：工具层只有一个取数口（`docs/architecture.md`），
   * 而"设置文件长什么样"是存储层的事。没有配置时返回空对象。
   */
  webSettings(): Promise<WebSettings>;
  signal: AbortSignal;
}

/**
 * 一次成功落盘的改动记录。界面按轮汇总"这次改了什么"，模型上下文不读它。
 *
 * `diff` 只对修改/删除有值；新建文件的正文就在盘上，界面点开读全文，不另存一份。
 */
export interface WriteChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  diff: string;
  additions: number;
  deletions: number;
}

export interface ToolResult {
  output: string; // 回灌模型的文本
  title?: string; // UI 即时标题
  metadata?: Record<string, unknown>; // 结构化信息
  /** 写文件成功时带上的改动记录；只给界面汇总，不进模型上下文 */
  change?: WriteChange;
  /** ask-user 的结构化记录；runner 原样挂到 tool part 上，界面回看用 */
  ask?: AskRecord;
  /** 覆盖 ToolDef.halt：pending / cancelled 时结束本回合（只有成功返回才生效） */
  halt?: boolean;
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
  /** 弹给用户做判断的材料（改文件时是 diff，委派子代理时是 prompt 规模等）。 */
  detail?: string;
}

/** `allow` 做了 · `reject` 用户拒了 · `deny` 规则不许 */
export type PermissionVerdict = "allow" | "reject" | "deny";

export interface ToolDef<Args = unknown> {
  id: string;
  description: string; // 给模型的说明（写清何时用/边界/用法）
  input: JsonSchema;
  /**
   * 这个工具属于哪一类动作：没有 = 不改变世界、不要权限（读设计、取规范、提案、模式切换）。
   * 两处用它：runner 做粗粒度兜底（`deny *` 的类别一律拒，哪怕工具是被幻觉调出来的），
   * session 把被禁的工具从 schema 里剔掉（`permission.visibleTools`）。
   */
  permission?: PermissionName;
  /**
   * 该工具成功后结束本回合，把控制权交回用户（如 propose-design：结论提出来了，该用户说话了）。
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
      /** 写文件成功后的结构化记录；界面按轮汇总，模型上下文不读它 */
      change?: WriteChange;
      /** ask-user 的结构化记录：问答内容、跳过、pending——界面回看用 */
      ask?: AskRecord;
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
  /**
   * role=user：这条消息是在回答一次已经 pending 的提问。
   *
   * 问题原文一并带上，使这条消息自包含——助手那条提问可能已经压缩掉，回看卡仍能画出问答。
   */
  answersTo?: { callId: string; questions: AskQuestion[]; answers: AskAnswer[] };
  finish?: "stop" | "tool_calls" | "error";
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
  /** 这套配置在 `models.json` 里的名字；环境变量那套没有。续聊靠它把厂商认回来。 */
  profile?: string;
  /**
   * 每一轮请求的真实用量（provider 报回来的，不是估算）。
   *
   * 它是会话自己的账：界面靠它显示上下文占比与走势，压缩将来也该靠它——目前压缩按字符数估
   * （`compaction.estimateChars`），那份估算在"离模型窗口还有多远"上永远是猜。
   * 落在这里而不是壳那侧：会话元信息本来就归 harness，另存一份就是第二个真相源。
   */
  usage?: { input: number; output: number }[];
  /**
   * 子会话深度：0 / 缺省 = 用户会话，>0 = `task` 派生的子会话。
   *
   * 子会话照样落盘（调试、轨迹要能回看整条过程），但它**不是一次用户会话**——左栏列表与
   * `/sessions` 只列 depth 0 的那些。判据是结构字段，不是标题前缀，见 `isSubagentSession`。
   */
  depth?: number;
  /** 子会话的父会话 id；用户会话没有 */
  parentSessionId?: string;
  time: { created: number; updated: number };
}

/** ─── 项目 ─── */

export interface ProjectMeta {
  id: string;
  title: string;
  /** 题材（书架上的大类：都市 / 古言 / 悬疑……）。创建时就能定，之后也可以改 */
  genre?: string;
  /**
   * 频道：男频 / 女频 / 不限。
   *
   * 与 `genre` 分开存而不是拼成一个串：这两个是两个独立的决定，拼起来之后想按其一筛选就得拆串。
   * 它记的是用户在书架上的声明——用来认书、筛选，界面按它画卡片。
   *
   * `design/core.md` 的「题材 · 频道」是另一件东西：建书那一次拿这两个值当**起点**种进去，此后归企划管
   * （模型可以据此展开成更多标签，用户也可以直接改那一格）。所以**在书架上改了它不会跟着变**——
   * 那一格是定位，这个字段是分类。
   */
  channel?: string;
  createdAt: number;
  /** 角色覆盖（talemate.json agents.<id> 可覆盖 model/system/permission 等） */
  agents?: Record<string, Partial<AgentDef>>;
  /**
   * 这个项目的权限规则（配置形）——规则表的最后一层、最高优先级。
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
  /**
   * 模型刚开始生成一次工具调用（参数还没流完）。
   *
   * 写正文/写设计稿这类工具，参数本身就是几千字；`tool-call` 要等参数全部生成完才发，
   * 中间那段界面会静默。这个事件让界面能先说“正在准备 写文件…”。
   */
  | { type: "tool-call.start"; id: string; name: string }
  | { type: "tool-call"; id: string; name: string; input: string }
  | { type: "tool.result"; id: string; name: string; output: string; change?: WriteChange; ask?: AskRecord }
  | { type: "scope.open"; label: string }
  | { type: "scope.close"; label: string }
  /** 只读展示给用户的块（提案逐格清单等）——无返回值，与 confirm/askUser 的交互式提示区分 */
  | { type: "proposal"; text: string; view?: ProposalDisplay }
  /**
   * 这一次请求的用量（provider 每次都拿到 `usage`）。界面靠它显示"这个会话用了多少上下文"
   * ——`input` 就是这一次发出去的全部 token（≈当前上下文大小）。
   */
  /**
   * 这一次请求的用量。`input` 是 provider 报回的**真总数**。
   *
   * `parts` 是这次请求**各段的字符数**（系统提示词 / 工具定义 / 对话消息）。为什么是字符而不是
   * token：provider 只报总 token，没有分段 token。界面拿它**按比例分摊**那个总数，并标「~」——
   * 总量是真的，构成是分摊的，不冒充精确。
   */
  | {
      type: "usage";
      input: number;
      output: number;
      parts?: { system: number; tools: number; messages: number };
    }
  | { type: "step.start" }
  | { type: "step.end"; finish: "stop" | "tool_calls" | "error" }
  /**
   * 用户消息已落盘，带上 seq。
   *
   * 界面靠它给**实时气泡**挂上"回退到这里"：没进文件的消息不能当回退目标，
   * 因为无法从上下文里撤回一条不存在的消息。
   */
  | { type: "user.message"; seq: number; text: string; sessionId: string; agent: string }
  | { type: "session.status"; status: "busy" | "idle" };
