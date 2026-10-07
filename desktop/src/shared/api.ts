/**
 * 壳的两侧（主进程 ↔ 渲染层）共用的取数形状。
 *
 * 放这里而不是两边各写一份：同一个东西的两端，两份定义迟早说两套话。只放纯类型——渲染层也会
 * 编译它，所以这里不许 import electron 或 node。
 */
import type { DocNode } from "../../../src/framework/anchor";
import type { LLMEvent, StoredMessage } from "../../../src/core/types";

export type { DocNode, LLMEvent, StoredMessage };

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
export interface Prefs {
  /** 右栏宽度（px）；没拖过就用默认 */
  paneWidth?: number;
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
  /** 「草稿模式」/「免确认落盘」…没有就是普通模式 */
  mode?: string;
  /** 等你拍板的那份东西的名字（`pendingLabel`） */
  pending?: string;
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
  /** 推理强度（off/low/high/max）——状态栏显示，也是将来切换器的入口 */
  effort: string;
}

export interface ConfirmRequest {
  id: string;
  action: string;
  summary: string;
}

export interface AskRequest {
  id: string;
  question: string;
  options: string[];
}

/**
 * 渲染层能碰到的全部东西（preload 把它挂成 `window.tm`）。
 *
 * 它长得就是一份"取数 + 发话"的清单，没有一条是"操作文件系统"：渲染层不该知道路径，也不该
 * 自己 walk 目录——"什么算一份文档"的判据在 harness 那边只有一处。
 */
export interface TmApi {
  listProjects(): Promise<ProjectCard[]>;
  createProject(title: string, channel: string, genre: string): Promise<{ id: string }>;
  /** 改书名 / 题材——卡上直接改，不经模型 */
  updateProject(id: string, patch: { title?: string; channel?: string; genre?: string }): Promise<void>;
  listSessions(projectId: string): Promise<SessionRow[]>;
  docsTree(projectId: string): Promise<DocNode[]>;
  /**
   * 保存一份文档（用户在右栏手改）。
   *
   * 回 `stale` = 这份文件在打开之后被别处改过（mate 落了新稿），不能盖掉，让用户先看一眼新的。
   * 判据在 harness 的 `storage/atomic.ts`（CAS），界面只是把它翻译成人话。
   */
  saveDoc(projectId: string, path: string, text: string): Promise<"ok" | "stale">;
  /** 会话当下是什么模式、有没有等着拍板的东西 */
  sessionState(projectId: string): Promise<SessionState>;
  /** 改当前这个会话的推理强度（off/low/high/max），不动全局默认 */
  setEffort(effort: string): Promise<void>;
  models(): Promise<{ profiles: ProfileView[]; default?: string; env: ProfileView }>;
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
  openSession(projectId: string, sessionId?: string): Promise<OpenInfo>;
  onEvent(cb: (e: LLMEvent) => void): void;
  onConfirm(cb: (req: ConfirmRequest) => void): void;
  onAsk(cb: (req: AskRequest) => void): void;
  onError(cb: (msg: string) => void): void;
  prompt(text: string): void;
  stop(): void;
  reply(id: string, value: string): void;
  /** 画完第一屏之后回一句给主进程——白屏唯一的探针（见主进程的 `selftestWindow`） */
  reportRendered(summary: string): void;
}
