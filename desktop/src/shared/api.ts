/**
 * 壳的两侧（主进程 ↔ 渲染层）共用的取数形状。
 *
 * 放这里而不是两边各写一份：同一个东西的两端，两份定义迟早说两套话。只放纯类型——渲染层也会
 * 编译它，所以这里不许 import electron 或 node。
 */
import type { DocNode } from "../../../src/framework/anchor";
import type { StyleCatalog } from "../../../src/framework/prose";
import type {
  AskAnswer,
  AskQuestion,
  AskRecord,
  LLMEvent,
  StoredMessage,
  WriteChange,
} from "../../../src/core/types";

export type {
  AskAnswer,
  AskQuestion,
  AskRecord,
  DocNode,
  LLMEvent,
  StoredMessage,
  StyleCatalog,
  WriteChange,
};

/** 一轮的文件改动。消息流是唯一来源，主进程按会话聚合后交给右栏的历史视图。 */
export interface SessionTurnChanges {
  sessionId: string;
  /** 会话名（左栏那一行）——历史里用它认这是哪次会话 */
  sessionTitle: string;
  /** 这一轮的第一条用户消息（第一行，已截断） */
  user: string;
  /** 这一轮的起点（用户消息的时间） */
  ts: number;
  changes: WriteChange[];
}

/** 首屏的一张作品卡。全部现取、不缓存——真相在盘上。 */
export interface ProjectCard {
  id: string;
  title: string;
  genre?: string;
  /** 男频 / 女频 / 不限（见 shared/genres.ts） */
  channel?: string;
  /** 写到第几章了；还没有正文 = `null`（0 会被读成"第 0 章"） */
  chapter: number | null;
  /** 最后动过的时间：最新一条会话的更新时间，没有会话就用建书时间 */
  updatedAt: number;
  /** 核心设定的「一句话简介」——卡上认得出"这是哪本书"的那行；没填就没有 */
  blurb?: string;
}

/**
 * 壳自己的偏好：拖出来的宽度这类东西。不属于作品（不进 `talemate.json`）、不是会话状态，只是
 * "这台机器上这个人习惯的样子"，所以单独一个文件。
 */
export type Appearance = "light" | "dark" | "system";
/** 窗口材质：macOS vibrancy / Windows acrylic、mica / 无材质 */
export type WindowMaterial = "vibrancy" | "acrylic" | "mica" | "none";
/** 新会话默认权限：每次都问 / 工作区内免确认落盘（对应 `agent/modes.ts` 的 accept-edits） */
export type PermissionDefault = "ask" | "accept-edits";

export interface Prefs {
  /** 右栏宽度（px）；没拖过就用默认 */
  paneWidth?: number;
  /** 对话与文件内容的字号（px）；默认 14 */
  fontSize?: number;
  /** 浅色 / 深色 / 跟随系统；由主进程的 nativeTheme 统一 */
  appearance?: Appearance;
  /** 目前只有中文；这一格先把通用设置的结构立住 */
  language?: "zh";
  /** 新会话的默认权限模式 */
  permissionMode?: PermissionDefault;
}

/**
 * 一套模型的配置（作者级、跨作品）。
 *
 * 它就是 `ModelConfig` 加上一个名字——名字是给人认的（"DeepSeek 主力"、"Opus 慢想"），界面上按
 * 它选。`apiKey` 明文存在 `<talemateHome>/models.json`，与 `.env` 同级，这是一次明知的取舍：
 * 正经做法是系统钥匙串，代价是要写一段原生集成。
 */
export interface ModelProfile {
  name: string;
  provider: "anthropic" | "openai" | "mock";
  /**
   * 这套配置下可以切的模型，第一个是它的默认。
   *
   * 一个厂商配多个模型是常态（同一个 DeepSeek 端点上有快的有慢的），所以模型是一组而不是一个：
   * 状态栏切的时候选的是"哪套配置的哪个模型"。
   */
  models: string[];
  baseURL?: string;
  maxTokens: number;
  reasoning: "off" | "low" | "high" | "max";
  /** 只进不出：渲染层永远拿不到它，只拿得到 `hasKey`（见 `ProfileView`） */
  apiKey?: string;
}

/** 界面上看到的那一份：密钥不进渲染层，只说"有没有"。 */
export interface ProfileView extends Omit<ModelProfile, "apiKey"> {
  hasKey: boolean;
}

/** 顶栏那两个标记：当前模式、有没有等你拍板的东西。 */
export interface SessionState {
  /** 「草稿模式」/「工作区内修改」…没有就是普通模式 */
  mode?: string;
  /** 等你拍板的那份东西的名字（`pendingLabel`） */
  pending?: string;
  /** 当前会话的写文件权限：工作区内免确认 / 每次询问 */
  permissionMode?: PermissionDefault;
}

export interface SessionRow {
  id: string;
  title: string;
  updatedAt: number;
}

export interface OpenInfo {
  sessionId: string;
  book: string;
  agent: string;
  model: string;
  /** 推理强度（off/low/high/max）——输入框那一格显示 */
  effort: string;
  /** 这套配置在 `models.json` 里的名字；环境变量那套没有。模型菜单只列这个厂商的模型。 */
  profile?: string;
  /**
   * 这一次请求三段的字符数（系统提示词 / 工具定义 / 对话消息）。
   * 一行正文都还没写时，界面靠它显示上下文基线——那时显示 0% 是错的。
   */
  contextParts?: { system: number; tools: number; messages: number };
  /** 在用的这套配置缺密钥时的中文提醒；不缺就没有这个字段 */
  modelWarning?: string;
  /** 重开/刷新后仍然开着的提问；没有就不带 */
  ask?: AskView;
}

export interface ConfirmRequest {
  id: string;
  action: string;
  summary: string;
}

/** 提问为什么变成 pending：决定卡片上那句话，不决定能不能答。 */
export type AskPendingReason = "timeout" | "deferred" | "interrupted" | "restarted";

/**
 * 渲染层看到的提问。`pending` 不是结束：卡片仍然可答，只是这个回合已经停了。
 * `deadline` 由主进程持有；渲染层只按它显示倒计时，不自己决定超时。
 */
export interface AskView {
  callId: string;
  questions: AskQuestion[];
  /** epoch ms；undefined = 不限时（已暂停/慢慢回答） */
  deadline?: number;
  pending: boolean;
  reason?: AskPendingReason;
}

/** 回答一个提问：同一回合的等待走原请求，已 pending 的走一条新用户消息。 */
export interface AskReply {
  callId: string;
  answers: AskAnswer[];
}

/**
 * 渲染层能碰到的全部东西（preload 把它挂成 `window.tm`）。
 *
 * 它长得就是一份"取数 + 发话"的清单，没有一条是"操作文件系统"：渲染层不该知道路径，也不该
 * 自己 walk 目录——"什么算一份文档"的判据在 harness 那边只有一处。
 */
export interface TmApi {
  /**
   * 这个壳跑在哪个系统上（`darwin` / `win32` / `linux`）——窗口外观按系统分区：
   * macOS 没标题栏（红绿灯在最左），Windows 有一整行标题栏（系统按钮在最右）。
   */
  readonly platform: string;
  /** 侧栏材质：由主进程在开窗前定好，首帧前写进 `data-material` */
  readonly material: WindowMaterial;
  listProjects(): Promise<ProjectCard[]>;
  createProject(title: string, channel: string, genre: string): Promise<{ id: string }>;
  /** 改书名 / 题材——卡上直接改，不经模型 */
  updateProject(id: string, patch: { title?: string; channel?: string; genre?: string }): Promise<void>;
  /**
   * 把一本书移出书架：整个项目目录进系统回收站（**不是永久删除**，找得回来）。
   *
   * `missing` = 盘上已经没有它了（别人删过、或目录是坏的）。那不是失败，是目标已达成。
   * 真删不动（回收站不可用）会抛，界面照实把原因显示出来，不假装删掉了。
   */
  deleteProject(id: string): Promise<"ok" | "missing">;
  /**
   * `/status` 的那段文本：四层现状（核心设定 / 世界观 / 角色 / 大纲）+ 一句下一步。
   *
   * 与 CLI 的 `/status` 调的是同一个 `buildProjectStatus`——同一条命令在两个外壳里说两套话，
   * 是这类界面最典型的烂法。
   */
  projectStatus(projectId: string): Promise<string>;
  /**
   * `/permissions` 的那段文本：当前生效的规则表（每类动作是什么、是哪一层定的、各层贡献了什么）。
   *
   * 无参：规则表属于**当前这个会话**（模式与会话级已批准都挂在会话上），而会话在主进程手里。
   * 渲染同样在 harness（`renderPermissionView`），与 CLI 共用一份。
   */
  permissions(): Promise<string>;
  listSessions(projectId: string): Promise<SessionRow[]>;
  docsTree(projectId: string): Promise<DocNode[]>;
  /**
   * 保存一份文档（用户在右栏手改）。
   *
   * 回 `stale` = 这份文件在打开之后被别处改过（mate 落了新稿），不能盖掉，让用户先看一眼新的。
   * 判据在 harness 的 `storage/atomic.ts`（CAS），界面只是把它翻译成人话。
   */
  saveDoc(projectId: string, path: string, text: string): Promise<"ok" | "stale">;
  /** 当前这本书用的文风，以及库里可选的文风卡 */
  styleCatalog(projectId: string): Promise<StyleCatalog>;
  /**
   * 选定一种文风，直接写进 `design/core.md` 的「文风」格——不经模型、不走两阶段。
   *
   * 这里没有可生成的东西：值是库里的一个卡名，来自封闭集合。让模型经手只会多出"它改写了你没看过
   * 的字节"这个风险，而两阶段存在的全部意义就是防后者；用户自己就是那个点头的人（同 `saveDoc`）。
   *
   * `unknown` = 库里没有这个名字（没写）；`stale` = 文件被别处改过，让用户看一眼再来。
   */
  setStyle(projectId: string, name: string): Promise<"ok" | "stale" | "unknown">;
  /** 会话当下是什么模式、有没有等着拍板的东西 */
  sessionState(projectId: string): Promise<SessionState>;
  /** 改当前这个会话的推理强度（off/low/high/max），不动全局默认 */
  setEffort(effort: string): Promise<void>;
  models(): Promise<{ profiles: ProfileView[]; default?: string }>;
  /** `apiKey` 省略 = 沿用已存的那一份（表单里没重填就别动它） */
  saveProfile(p: Omit<ModelProfile, "apiKey"> & { apiKey?: string }): Promise<void>;
  deleteProfile(name: string): Promise<void>;
  setDefaultProfile(name: string): Promise<void>;
  /** 某个会话的用量序列（每一轮一条）——切回去时把走势也带回来 */
  sessionUsage(projectId: string, sessionId: string): Promise<{ input: number; output: number }[]>;
  /** 让当前这个会话改用某套配置里的某个模型，不动默认 */
  useProfile(name: string, model: string): Promise<void>;
  prefs(): Promise<Prefs>;
  savePrefs(patch: Prefs): Promise<void>;
  /** 盘上有人动了作品文档（mate 落了稿，或你在别处改了）——开着的右栏与目录树据此更新 */
  onDocsChanged(cb: () => void): void;
  onSessionState(cb: (s: SessionState) => void): void;
  /** 读一份文档的全文；读不到（路径不合法或文件不在）回 `undefined` */
  docText(projectId: string, path: string): Promise<string | undefined>;
  history(projectId: string, sessionId: string): Promise<StoredMessage[]>;
  /** 每个会话每一轮的文件改动，最新在前——历史视图按会话/全书筛选 */
  changes(projectId: string): Promise<SessionTurnChanges[]>;
  openSession(projectId: string, sessionId?: string): Promise<OpenInfo>;
  onEvent(cb: (e: LLMEvent) => void): void;
  onConfirm(cb: (req: ConfirmRequest) => void): void;
  onAsk(cb: (view: AskView) => void): void;
  /** 主进程的计时器到点/用户稍后/中断：卡片翻成 pending，但仍可回答 */
  onAskPending(cb: (p: { callId: string; reason: AskPendingReason }) => void): void;
  /** 问题已经结束（取消、或排队中的迟到回答已送达）：卡片可以收起 */
  onAskClosed(cb: (p: { callId: string }) => void): void;
  /** `queued` = 这一轮还在跑，回答先记着，结束之后自动送达 */
  answerAsk(reply: AskReply): Promise<"ok" | "stale" | "invalid" | "queued">;
  /** 倒计时控制：聚焦暂停 / 移开恢复 / 首次编辑转不限时 / 稍后回答 */
  holdAsk(callId: string, mode: "pause" | "resume" | "hold" | "defer"): void;
  onError(cb: (msg: string) => void): void;
  prompt(text: string): void;
  stop(): void;
  reply(id: string, value: string): void;
  /** 画完第一屏之后回一句给主进程——白屏唯一的探针（见主进程的 `selftestWindow`） */
  reportRendered(summary: string): void;
}
