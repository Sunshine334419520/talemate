/**
 * 壳的两侧（主进程 ↔ 渲染层）共用的**取数形状**。
 *
 * 放这里而不是两边各写一份：这是同一个东西的两端，两份定义迟早说两套话。**只放纯类型**——
 * 渲染层也会编译它，所以这里不许 import electron 或 node。
 */
import type { DocNode } from "../../../src/framework/anchor";
import type { LLMEvent, StoredMessage } from "../../../src/core/types";

export type { DocNode, LLMEvent, StoredMessage };

/** 首屏的一张作品卡。**全部现取、不缓存**——真相在盘上。 */
export interface ProjectCard {
  id: string;
  title: string;
  genre?: string;
  /** 频道：男频 / 女频 / 不限（见 shared/genres.ts） */
  channel?: string;
  /** 写到第几章了；还没有正文 = `null`（不是 0：那会被读成"第 0 章"） */
  chapter: number | null;
  /** 这本书最后动过的时间：取最新一条会话的更新时间，没有会话就用建书时间 */
  updatedAt: number;
  /** 核心设定里的「一句话简介」——卡上那行让人认得出"这是哪本书"的话。没填就没有 */
  blurb?: string;
}

/**
 * 壳自己的偏好：**拖出来的宽度这类东西**。它不属于作品（不进 `talemate.json`），也不是会话的状态，
 * 只是"这台机器上这个人习惯的样子"，所以单独一个文件（`~/.talemate/desktop.json`）。
 */
export interface Prefs {
  /** 右栏宽度（px）。拖过分隔缝就是这个数；没拖过用默认 */
  paneWidth?: number;
}

/** 顶栏那两个标记：当前模式、有没有等你拍板的东西。 */
export interface SessionState {
  /** 「草稿模式」/「免确认落盘」…没有就是普通模式 */
  mode?: string;
  /** 等你拍板的那份东西的名字（`pendingLabel`） */
  pending?: string;
}

/** 左栏一条会话。 */
export interface SessionRow {
  id: string;
  title: string;
  updatedAt: number;
}

/** 开会话（续聊或新建）之后回给界面的一行。 */
export interface OpenInfo {
  sessionId: string;
  book: string;
  agent: string;
  model: string;
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
 * 渲染层能碰到的**全部**东西（preload 把它挂成 `window.tm`）。
 *
 * 它长得就是一份"取数 + 发话"的清单，没有一条是"操作文件系统"：渲染层不该知道路径，
 * 也不该自己 walk 目录——"什么算一份文档"的判据在 harness 那边只有一处。
 */
export interface TmApi {
  listProjects(): Promise<ProjectCard[]>;
  createProject(title: string, channel: string, genre: string): Promise<{ id: string }>;
  /** 改书名 / 题材。书名是会被改的——卡上直接改，不经模型 */
  updateProject(id: string, patch: { title?: string; channel?: string; genre?: string }): Promise<void>;
  listSessions(projectId: string): Promise<SessionRow[]>;
  docsTree(projectId: string): Promise<DocNode[]>;
  /**
   * 保存一份文档（用户在右栏手改）。
   *
   * 回 `stale` = 这份文件在你打开它之后被别处改过（mate 落了新稿）——**不能盖掉**，
   * 让用户先看一眼新的是什么样。这条判据在 harness 的 `storage/atomic.ts` 里（CAS），
   * 界面只是把它翻译成人话。
   */
  saveDoc(projectId: string, path: string, text: string): Promise<"ok" | "stale">;
  /** 会话当下是什么模式、有没有等着拍板的东西（顶栏那两个标记） */
  sessionState(projectId: string): Promise<SessionState>;
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
  /** 画完第一屏之后回一句给主进程——**白屏唯一的探针**（见主进程的 `selftestWindow`） */
  reportRendered(summary: string): void;
}
