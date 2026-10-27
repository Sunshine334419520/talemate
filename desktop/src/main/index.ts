/**
 * 桌面壳的主进程。
 *
 * 它做四件事：起 harness（`openSession`）、按界面的请求取数（项目 / 会话 / 历史投影）、把
 * `LLMEvent` 转发给渲染层、把确认与提问接回来。它自己没有状态——真相在盘上与 harness 里，这里是
 * 一段管道加一层薄薄的"现取"。
 *
 * 两处要点：`.env` 与资源根在进程一起来就钉死（见 `prelude.ts`，必须是第一条 import；打包后
 * `import.meta.url` 指向 bundle 内部，不钉就 prompts 读不到、skill 一个都发现不了且不报错）；
 * 渲染层不碰文件系统，它要的每一样都从这里过一道 `ipcMain.handle`，因为"什么算一份文档"的判据在
 * harness 那边只有一处，界面自己 walk 目录就会长出第二份。
 *
 * `TALEMATE_DESKTOP_SELFTEST=1` 走无窗口自检（`bun run desktop:selftest`）；`=window` 还会开一个
 * 不显示的窗口，等渲染层报"画出来了"——那是抓白屏的地方（见 `selftest`）。
 */
// 必须是第一条：下面的依赖在模块顶层就会读配置与提示词，见 prelude.ts
import "./prelude";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from "electron";
import type { ConfirmReply, ModelConfig, ProjectMeta } from "../../../src/core/types";
import { leadLine } from "../../../src/framework/markdown";
import { CORE_DOC, styleCatalog, withShelf, withStyle } from "../../../src/framework/prose";
import { readDoc } from "../../../src/storage/corpus";
import { writeProjectMeta } from "../../../src/storage/project";
import { docTree } from "../../../src/framework/anchor";
import { listTurnChanges } from "./changes";
import { resolveWindowMaterial } from "./material";
import { chapterNumberOf } from "../../../src/framework/plan";
import { openSession, renderPermissionView, type Session, type UserIO } from "../../../src/session/session";
import { buildSessionDebug, renderSessionDebug } from "../../../src/session/debug";
import { buildProjectStatus } from "../../../src/framework/report";
import { enumerateDocs } from "../../../src/storage/corpus";
import { isSubagentSession, listSessionIds, loadMessages, loadSessionMeta } from "../../../src/storage/session-store";
import { createProject, listProjects, loadProjectMeta } from "../../../src/storage/project";
import { writeIfUnchanged } from "../../../src/storage/atomic";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { DOC_ROOTS, docAbs } from "../../../src/storage/corpus";
import { projectPaths, rootAbs, sessionPaths, talemateHome } from "../../../src/core/config";
import { readFile, rm, writeFile } from "node:fs/promises";
import { webSettingsView } from "../../../src/core/web";
import { loadWebSettings, saveWebSettings } from "../../../src/storage/web_config";
import { DEFAULT_PERMISSION_MODE } from "../shared/api";
import type {
  AskReply,
  AskView,
  ColorScheme,
  DocNode,
  ModelProfile,
  ProfileView,
  OpenInfo,
  Prefs,
  ProjectCard,
  ProposalVerdict,
  RewindFilePreview,
  RewindResult,
  SessionRow,
  SessionState,
  WebSettingsPatch,
  WebSettingsView,
} from "../shared/api";
import { createAskBroker } from "./ask_broker";

const SELFTEST = process.env.TALEMATE_DESKTOP_SELFTEST ?? "";
/** 新会话的默认名；第一句话发出去时按“名字还是不是它”决定要不要命名 */
const NEW_SESSION_TITLE = "新会话";

let win: BrowserWindow | undefined;
let session: Session | undefined;
let watchers: FSWatcher[] = [];
/** 这些 watcher 盯的是哪一本。删掉一本书时，只有它才知道该不该把手上的 watcher 与会话收掉。 */
let watchedProjectId: string | undefined;

/** 等渲染层点头的审批（确认）。提问的等待在 ask_broker.ts，那里可离线测。 */
const waitingConfirms = new Map<string, (v: ConfirmReply) => void>();
/** 这一轮还在跑时收到的迟到回答：等 idle 再送达，不在同一会话上并发开两轮。 */
const answerQueue: AskReply[] = [];
let drainingAnswers = false;

const askBroker = createAskBroker({
  send: (view) => win?.webContents.send("tm:ask", view),
  sendPending: (p) => win?.webContents.send("tm:ask-pending", p),
  canAsk: () => win !== undefined && !win.isDestroyed(),
});

function askConfirm(channel: string, payload: Record<string, unknown>): Promise<ConfirmReply> {
  // 没有窗口 = 没有回答方。审批必须 fail closed：不挂死，也不替用户点头。
  if (win === undefined || win.isDestroyed()) return Promise.resolve("no");
  const id = randomUUID();
  return new Promise((resolve) => {
    waitingConfirms.set(id, resolve);
    win?.webContents.send(channel, { id, ...payload });
  });
}

/**
 * 回答只走这一条路：工具调用还开着 → resolve 原 Promise；已经 pending → 落一条用户消息并开新回合。
 * 会话正在跑时先排队——同一个 Session 不能并发开两轮。
 */
async function submitAskAnswer(reply: AskReply): Promise<"ok" | "stale" | "invalid" | "queued"> {
  const verdict = askBroker.answer(reply);
  if (verdict === "answered") return "ok";
  if (verdict === "invalid") return "invalid";
  if (session === undefined) return "stale";
  if (session.isBusy) {
    answerQueue.push(reply);
    return "queued";
  }
  const pending = await session.preparePendingAnswer(reply.callId, reply.answers);
  if (pending === "ok") {
    void session.resumeAfterAnswer().catch((err) => {
      win?.webContents.send("tm:error", err instanceof Error ? err.message : String(err));
    });
  }
  return pending;
}

async function drainAnswerQueue(): Promise<void> {
  if (drainingAnswers || session === undefined || session.isBusy) return;
  const next = answerQueue.shift();
  if (next === undefined) return;
  drainingAnswers = true;
  try {
    const verdict = await submitAskAnswer(next);
    if (verdict === "ok" || verdict === "stale") {
      win?.webContents.send("tm:ask-closed", { callId: next.callId });
    } else if (verdict === "queued") {
      answerQueue.unshift(next);
    } else if (verdict === "invalid") {
      win?.webContents.send("tm:error", "这条回答没有通过校验，请重新打开问题再答一次。");
    }
  } finally {
    drainingAnswers = false;
    if (answerQueue.length > 0) setTimeout(() => void drainAnswerQueue(), 0);
  }
}

// ─── 取数口（全部现取，不缓存） ───

/** 这本书写到第几章：数 `chapters/` 里最大的章号，复用 `plan.ts` 那条唯一的正则。 */
async function latestChapter(projectId: string): Promise<number | null> {
  const docs = await enumerateDocs(projectId, "chapters/");
  let max = 0;
  for (const path of docs) {
    const n = chapterNumberOf(path);
    if (n !== undefined && n > max) max = n;
  }
  return max === 0 ? null : max;
}

async function sessionsOf(projectId: string): Promise<SessionRow[]> {
  const ids = await listSessionIds(projectId);
  const rows = await Promise.all(
    ids.map(async (id): Promise<SessionRow | undefined> => {
      const meta = await loadSessionMeta(projectId, id).catch(() => undefined);
      // 子会话不是一次用户会话：它属于某条 `task` 调用，显示在对话/轨迹里，不进左栏。
      if (isSubagentSession(meta)) return undefined;
      return { id, title: meta?.title ?? id, updatedAt: meta?.time.updated ?? 0 };
    }),
  );
  return rows.filter((r): r is SessionRow => r !== undefined).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 顶栏那两个标记的当下值，现取——模式会在回合中间变（进/出草稿模式都是工具调用）。 */
function sessionState(): SessionState {
  return {
    mode: session?.currentMode?.title,
    pending: session?.pendingLabel,
    permissionMode: session?.permissionMode ?? "ask",
  };
}

function pushSessionState(): void {
  win?.webContents.send("tm:session-state", sessionState());
}

/**
 * 盯着作品的三个根，谁动了就通知界面一声。
 *
 * 界面不自己读盘，所以这件事也由这里做：事件只报"变了"，重取哪些、要不要重取仍由界面按状态决定
 * （正在编辑就不抢光标）。三个根各挂一个 watcher——`recursive` 只在 macOS/Windows 上管用，而树最多
 * 三层，逐个根盯刚好够且避开 `.talemate/` 的噪音（每写一行会话文件都会触发事件）。
 */
function watchDocs(projectId: string): void {
  for (const w of watchers) w.close();
  watchers = [];
  watchedProjectId = projectId;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = (): void => {
    // 合并成一次：mate 写一章会连着落好几个文件，逐条通知只是白刷
    clearTimeout(timer);
    timer = setTimeout(() => win?.webContents.send("tm:docs-changed"), 300);
  };
  for (const root of DOC_ROOTS) {
    try {
      watchers.push(watch(rootAbs(projectId, root), { recursive: true }, bump));
    } catch {
      // 那个根还不存在（懒建）——没有目录就是还没有文档，也没什么可盯的
    }
  }
}

/**
 * CLI 的"上次打开哪本书"（`<home>/current.json`）若正指向这本刚被删掉的书，就把那份指针清掉——
 * 否则 `talemate`（不带参数）下次启动会去开一个不存在的空间。
 *
 * 这个文件今天还写在 `src/cli.ts` 里、没挪进 `storage/`（见 docs/ui.md 十一.3），所以这里只做最小的
 * 一步、不做收口：收口是那一项的事，顺手长第二份判据只会让那件事更难做。
 */
async function clearCurrentIf(projectId: string): Promise<void> {
  const file = join(talemateHome(), "current.json");
  try {
    const raw = JSON.parse(await readFile(file, "utf-8")) as { id?: string };
    if (raw.id === projectId) await rm(file, { force: true });
  } catch {
    // 没有这个文件、或读不动 —— 那就没有指针要清，不是错误
  }
}

/** 壳自己的偏好文件。读失败一律当没有——偏好丢了只是回到默认值，不值得为它报错。 */
function prefsFile(): string {
  return join(talemateHome(), "desktop.json");
}

/** 读壳的偏好；读失败一律当没有——偏好丢了只是回到默认值，不值得为它报错。 */
async function readPrefs(): Promise<Prefs> {
  try {
    const stored = JSON.parse(await readFile(prefsFile(), "utf-8")) as Prefs;
    // 文件里没写 ≠ 没偏好：没写过这一格的人要拿到产品默认（工作区内修改），而不是"问不问看运气"。
    return { ...stored, permissionMode: stored.permissionMode ?? DEFAULT_PERMISSION_MODE };
  } catch {
    return { permissionMode: DEFAULT_PERMISSION_MODE };
  }
}

/**
 * 模型配置清单：`<talemateHome>/models.json`。作者级、跨作品——同一台机器上的模型清单不该跟着书走
 * （书只该说"我这本书用什么声音"，不该说"你用什么模型"）。一份都没有时一律退回环境变量，`.env`
 * 那套照旧能用、不是被替代了。
 */
async function readModels(): Promise<{ profiles: ModelProfile[]; default?: string }> {
  try {
    const raw = JSON.parse(await readFile(modelsFile(), "utf-8")) as Partial<{
      profiles: (Omit<ModelProfile, "models"> & { models?: string[]; model?: string })[];
      default: string;
    }>;
    // 老文件一套配置只装一个模型（`model`）——顺手认下来，别让它们读不出来
    const profiles = (raw.profiles ?? []).map((p): ModelProfile => {
      const { model, ...rest } = p;
      return cleanProfile({ ...rest, models: p.models ?? (model !== undefined ? [model] : []) } as ModelProfile);
    });
    return { profiles, default: raw.default };
  } catch {
    return { profiles: [] };
  }
}

/** 给界面看的那一份：密钥换成"有没有"——不该为了显示就把密钥在进程间多绕一圈。 */
function view(p: ModelProfile, isDefault: boolean): ProfileView & { isDefault?: boolean } {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: apiKey !== undefined && apiKey !== "", isDefault };
}

function modelsFile(): string {
  return join(talemateHome(), "models.json");
}

/** 只落库这七个字段：ProfileView 的 hasKey/isDefault 不该被回写到 models.json。 */
function cleanProfile(p: ModelProfile): ModelProfile {
  return {
    name: p.name,
    provider: p.provider,
    models: p.models,
    ...(p.baseURL === undefined || p.baseURL === "" ? {} : { baseURL: p.baseURL }),
    maxTokens: p.maxTokens,
    reasoning: p.reasoning,
    ...(p.apiKey === undefined || p.apiKey === "" ? {} : { apiKey: p.apiKey }),
  };
}

async function writeModels(next: { profiles: ModelProfile[]; default?: string }): Promise<void> {
  await writeFile(
    modelsFile(),
    JSON.stringify({ ...next, profiles: next.profiles.map(cleanProfile) }, null, 2),
    "utf-8",
  );
}

function toModelConfig(p: ModelProfile, model?: string): ModelConfig {
  return {
    provider: p.provider,
    model: model ?? p.models[0] ?? "",
    apiKey: p.apiKey,
    baseURL: p.baseURL,
    maxTokens: p.maxTokens,
    reasoning: p.reasoning,
  };
}

/**
 * 新建会话用哪套：默认那套，没有就退回环境变量。
 * 名字一并带出来——`describeMissingKey` 要靠它把话说清楚（"哪一套没密钥"）。
 */
async function modelForNewSession(): Promise<{ name: string; cfg: ModelConfig } | undefined> {
  const { profiles, default: name } = await readModels();
  const picked = profiles.find((p) => p.name === name) ?? profiles[0];
  return picked === undefined ? undefined : { name: picked.name, cfg: toModelConfig(picked) };
}

/**
 * 这套配置缺密钥时的提醒文案；不缺就 undefined。
 *
 * **只报，不补。** 静默拿 `.env` 的密钥顶上会把"其实没配好"藏起来（而且 env 换了 key，两处
 * 就分家了）——这条路径真的踩过：从 `.env` 那条伪配置"借来改"存成具名配置时，密钥不会跟着
 * 走（伪配置按设计不带密钥），存出来的就是一套没有密钥的配置，而它在界面上和配好的长得一样。
 *
 * 两种不算缺：`mock` 本来就不要密钥；provider 自己的环境变量在的话，SDK 会去读它。
 */
function describeMissingKey(name: string | undefined, cfg: ModelConfig): string | undefined {
  if (cfg.provider === "mock" || cfg.apiKey) return undefined;
  const fromEnv = cfg.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (fromEnv) return undefined;
  // 一条配置都没有时，`.env` 是开发自用的退路，不该出现在给用户的提示里——直接让他去配一套
  return name === undefined
    ? "还没有配置模型。去设置里加一套、填好密钥，再新建会话。"
    : `「${name}」这套配置还没有密钥，调模型会失败。去设置里给它填一个。`;
}

function registerHandlers(): void {
  ipcMain.handle("projects:list", async (): Promise<ProjectCard[]> => {
    const projects = await listProjects();
    return Promise.all(
      projects.map(async (p): Promise<ProjectCard> => {
        const sessions = await sessionsOf(p.id);
        // 卡上那行简介取自核心设定的「一句话简介」——现读、不缓存：用户改了设定，卡上就该跟着变
        const core = await readDoc(p.id, "design/core.md");
        return {
          id: p.id,
          title: p.title,
          genre: p.genre,
          channel: p.channel,
          chapter: await latestChapter(p.id),
          updatedAt: sessions[0]?.updatedAt ?? p.createdAt,
          blurb: core === undefined ? undefined : leadLine(core, "一句话简介", 64),
        };
      }),
    );
  });

  ipcMain.handle(
    "projects:create",
    async (_e, p: { title: string; channel: string; genre: string }) => {
      const meta = await createProject({
        title: p.title.trim(),
        channel: p.channel.trim() || undefined,
        genre: p.genre.trim() || undefined,
      });
      // 建完就把书架声明种进核心设定的「题材 · 频道」格。同 `style:set` 那一类：值是用户在表单里
      // 从封闭集合挑的，没有可生成的东西，所以不经模型、不走两阶段。mate 每轮常驻注入 core.md，
      // 于是它第一轮就知道这本书的赛道，不会从零问起（见 docs/ui.md 的「首屏」）。
      const core = docAbs(meta.id, CORE_DOC);
      const seeded = withShelf(undefined, meta.channel, meta.genre);
      if (core !== undefined && seeded !== undefined) {
        // 期望"还不存在"：这是刚建出来的项目，这个文件此刻必然没有
        await writeIfUnchanged({ abs: core, expected: null, content: seeded });
      }
      return { id: meta.id };
    },
  );

  /**
   * 从书架上删掉一本书：整个项目目录移进系统回收站。
   *
   * **不是 `rm -rf`**：一本书是几年心血，回收站是唯一合理的默认（找得回来）。移不动就照实抛回去，
   * 不退回静默删除——那会把"删不掉"变成"已经删了，找不回来了"。
   */
  ipcMain.handle("projects:delete", async (_e, projectId: string): Promise<"ok" | "missing"> => {
    const root = projectPaths(talemateHome(), projectId).root;
    if (!existsSync(root)) return "missing"; // 已经不在书架上：目标已达成，不必报错
    // 先把挂在它上面的东西收掉：目录没了之后 watcher 还会继续报事件，会话也没了容身之处
    if (watchedProjectId === projectId) {
      for (const w of watchers) w.close();
      watchers = [];
      watchedProjectId = undefined;
      session = undefined;
    }
    await shell.trashItem(root);
    await clearCurrentIf(projectId);
    return "ok";
  });

  /** `/status`：四层现状。只读，与 CLI 那条命令调的是同一个函数。 */
  ipcMain.handle("projects:status", (_e, projectId: string) => buildProjectStatus(projectId));

  /**
   * `/permissions`：当前这个会话的规则表。渲染也在 harness（`renderPermissionView`），与 CLI 一份。
   * 还没有会话时回一句话而不是抛——命令面板打得开，只是还没有能谈权限的会话。
   */
  ipcMain.handle("session:permissions", (): string =>
    session === undefined ? "（还没有打开会话）" : renderPermissionView(session.permissionView()),
  );

  ipcMain.handle("session:debug", async (): Promise<string> => {
    if (session === undefined) return "（还没有打开会话）";
    return renderSessionDebug(await buildSessionDebug(session));
  });

  /** 改书名 / 题材。书名不是作品文档（在 talemate.json 里），所以不经模型、不问权限。 */
  ipcMain.handle(
    "projects:update",
    async (_e, p: { id: string; title?: string; channel?: string; genre?: string }) => {
      const meta = await loadProjectMeta(p.id);
      const next: ProjectMeta = { ...meta };
      if (p.title !== undefined && p.title.trim()) next.title = p.title.trim();
      if (p.channel !== undefined) next.channel = p.channel.trim() || undefined;
      if (p.genre !== undefined) next.genre = p.genre.trim() || undefined;
      await writeProjectMeta(next);
    },
  );

  ipcMain.handle("sessions:list", (_e, projectId: string) => sessionsOf(projectId));

  /** 文档树：`enumerateDocs` 只认 `DOC_ROOTS` 那三个根、`docTree` 定次序——两处判据都在 harness 里。 */
  ipcMain.handle("docs:tree", async (_e, projectId: string): Promise<DocNode[]> =>
    docTree(await enumerateDocs(projectId, "")),
  );

  ipcMain.handle("docs:text", (_e, p: { projectId: string; path: string }) =>
    readDoc(p.projectId, p.path),
  );

  /**
   * 用户在右栏手改之后落盘。
   *
   * 不走 `write_ops`：那条路上的 diff 与"问用户"是为模型改稿准备的——由谁改、谁点头是同一件事的
   * 两半，而这里用户自己就是那个点头的人。所以只保留它在意的两样：原子写，以及 CAS（打开之后文件
   * 被别处改过就拒，别把 mate 刚落的稿子盖掉）。
   */
  ipcMain.handle(
    "docs:save",
    async (_e, p: { projectId: string; path: string; text: string }): Promise<"ok" | "stale"> => {
      const abs = docAbs(p.projectId, p.path);
      if (abs === undefined) return "stale"; // 路径不合法：当作"变了"，让界面重来一次
      const before = await readDoc(p.projectId, p.path);
      try {
        await writeIfUnchanged({ abs, expected: before ?? null, content: p.text });
        return "ok";
      } catch {
        return "stale";
      }
    },
  );

  ipcMain.handle("style:list", (_e, projectId: string) => styleCatalog(projectId));

  /**
   * 状态栏选定文风 → 直接写核心设定的「文风」格。
   *
   * 同 `docs:save` 那一类：**用户自己就是那个点头的人**，所以不走两阶段、不经模型。这里尤其
   * 没有可生成的东西——值是库里一个卡名。库里没有这个名字就**不写**（回 `unknown`），
   * 别把界面传来的一串字直接落进作品。
   *
   * 不需要手动广播刷新：`watchDocs` 盯着 `DOC_ROOTS`，这次写盘会和别的写盘一样被它带出去。
   */
  ipcMain.handle(
    "style:set",
    async (_e, p: { projectId: string; name: string }): Promise<"ok" | "stale" | "unknown"> => {
      const { cards } = await styleCatalog(p.projectId);
      if (!cards.some((c) => c.name === p.name)) return "unknown";
      const abs = docAbs(p.projectId, CORE_DOC);
      if (abs === undefined) return "stale";
      const before = await readDoc(p.projectId, CORE_DOC);
      try {
        await writeIfUnchanged({ abs, expected: before ?? null, content: withStyle(before, p.name) });
        return "ok";
      } catch {
        return "stale";
      }
    },
  );

  ipcMain.handle("session:state", (): SessionState => sessionState());

  /** 用量由 harness 记在会话元信息里（`SessionMeta.usage`）——重启也还在，壳只读。 */
  ipcMain.handle("session:usage", async (_e, p: { projectId: string; sessionId: string }) =>
    (await loadSessionMeta(p.projectId, p.sessionId).catch(() => undefined))?.usage ?? [],
  );

  ipcMain.handle("models:list", async () => {
    const { profiles, default: d } = await readModels();
    return {
      profiles: profiles.map((p) => view(p, p.name === d)),
      default: d,
    };
  });

  ipcMain.handle(
    "models:save",
    async (_e, p: Omit<ModelProfile, "apiKey"> & { apiKey?: string }): Promise<void> => {
      const now = await readModels();
      const before = now.profiles.find((x) => x.name === p.name);
      // 表单里没重填密钥 = 沿用旧的（界面看不到密钥，没法重发）
      const next: ModelProfile = { ...p, apiKey: p.apiKey ?? before?.apiKey };
      await writeModels({
        ...now,
        profiles: [...now.profiles.filter((x) => x.name !== p.name), next],
        default: now.default ?? p.name,
      });
      // 当前会话如果正在用这套配置，立刻补上刚保存的 baseURL/密钥，不必重启或切会话。
      if (session !== undefined && session.profile === p.name) {
        session.model = {
          ...session.model,
          ...(next.baseURL === undefined || next.baseURL === "" ? {} : { baseURL: next.baseURL }),
          ...(next.apiKey === undefined ? {} : { apiKey: next.apiKey }),
        };
      }
    },
  );

  ipcMain.handle("models:delete", async (_e, name: string): Promise<void> => {
    const now = await readModels();
    const profiles = now.profiles.filter((x) => x.name !== name);
    // 默认那套被删了就顺位给第一个——留一个指向不存在名字的 default 只会让人以为选了没用
    await writeModels({ profiles, default: now.default === name ? profiles[0]?.name : now.default });
  });

  ipcMain.handle("models:default", async (_e, name: string): Promise<void> => {
    await writeModels({ ...(await readModels()), default: name });
  });

  /** 换当前这个会话用哪套：会话对象上的 `model` 是活的，下一轮请求就按新的发。 */
  ipcMain.handle("session:use-model", async (_e, p: { name: string; model: string }): Promise<void> => {
    const picked = (await readModels()).profiles.find((x) => x.name === p.name);
    if (picked !== undefined && session !== undefined) session.model = toModelConfig(picked, p.model);
  });

  /** 换这个会话的推理强度。 */
  ipcMain.handle("session:effort", (_e, effort: string): void => {
    if (session === undefined) return;
    session.model = { ...session.model, reasoning: effort as ModelConfig["reasoning"] };
  });

  ipcMain.handle("prefs:get", (): Promise<Prefs> => readPrefs());

  ipcMain.handle("prefs:save", async (_e, patch: Prefs): Promise<void> => {
    const now = await readPrefs();
    await writeFile(prefsFile(), JSON.stringify({ ...now, ...patch }, null, 2), "utf-8");
    // 外观是原生主题的一部分：改完立刻让标题栏、渲染层与页面一起换
    if (patch.appearance !== undefined) {
      nativeTheme.themeSource = patch.appearance;
      syncWindowTheme(win);
      win?.webContents.send("tm:theme", currentTheme());
    }
    // 权限偏好同时作用于当前会话：对话框左侧那一格和设置里的这一格是同一个开关
    if (patch.permissionMode !== undefined) {
      session?.setMode(patch.permissionMode === "accept-edits" ? "accept-edits" : undefined);
      pushSessionState();
    }
  });

  /** 历史投影：进会话先拉这一次，之后靠事件增量（`architecture.md` 给薄 TUI 写下的那条）。 */
  ipcMain.handle("sessions:history", (_e, p: { projectId: string; sessionId: string }) =>
    loadMessages(p.projectId, p.sessionId),
  );

  /**
   * 就地回退到某条用户消息之前。界面在忙碌/有待批/有待答时不会给按钮，主进程再守一道空闲检查。
   */
  ipcMain.handle(
    "session:rewind",
    async (_e, p: { seq: number; restoreFiles?: boolean }): Promise<RewindResult> => {
      if (session === undefined) throw new Error("会话没有打开。");
      const result = await session.rewindTo(p.seq, { restoreFiles: p.restoreFiles === true });
      pushSessionState();
      return result;
    },
  );

  ipcMain.handle("session:rewind-preview", async (_e, seq: number): Promise<RewindFilePreview> => {
    if (session === undefined) throw new Error("会话没有打开。");
    return session.rewindPreview(seq);
  });

  /**
   * 结构化拍板：按钮不再把“没问题 / 不行”写进对话。
   * 接受后先标 approved 并推一次界面状态，再跑执行回合；拒绝到此为止。
   */
  ipcMain.handle(
    "session:proposal",
    async (_e, p: { verdict: ProposalVerdict; text?: string }): Promise<void> => {
      if (session === undefined) throw new Error("会话没有打开。");
      if (p.verdict === "refine") {
        await session.refineProposal(p.text ?? "");
        return;
      }
      if (p.verdict === "reject") {
        session.decideProposal("reject");
        pushSessionState();
        return;
      }
      // 文档提案由 harness 直接落盘（不再多一轮模型）；规划提案回到模型执行。
      const result = await session.acceptProposal();
      pushSessionState();
      if (result.kind === "plan") {
        const where = result.chapter === undefined ? "the chapter" : `chapter ${result.chapter}`;
        await session.resumeAfterAnswer(
          `The user accepted the plan for ${where}. Carry it out in the order of 产物（按序）: ` +
            "if it names a new character card or a world fact, create it first with propose-design " +
            "and stop for the user's review. Do not write the chapter before those prerequisites " +
            "are landed, and do not skip a step.",
        );
      } else if (session.planExecutionChapter !== undefined) {
        // 规划执行中，某个前置文档刚被接受并落盘：接着走规划，不要停在半路。
        const where =
          session.planExecutionChapter === undefined ? "the chapter" : `chapter ${session.planExecutionChapter}`;
        await session.resumeAfterAnswer(
          `Continue the approved plan for ${where} in 产物（按序）. ` +
            "If the next prerequisite is a character card or a world fact, propose it now; " +
            "otherwise write the chapter. Do not skip a prerequisite.",
        );
      }
    },
  );

  ipcMain.handle("web:settings", async (): Promise<WebSettingsView> => webSettingsView(await loadWebSettings()));

  /**
   * 存联网设置。密钥沿用"留空不改"：表单里没重填就保留已存的那一把（同模型配置），
   * `clearKey` 才是显式清除。空 baseURL 同样表示"回到官方地址"，不是写一个空串。
   */
  ipcMain.handle("web:save", async (_e, patch: WebSettingsPatch): Promise<WebSettingsView> => {
    const current = await loadWebSettings();
    const deepseek = { ...current.deepseek };
    if (patch.clearKey === true) delete deepseek.apiKey;
    if (patch.apiKey !== undefined && patch.apiKey.trim() !== "") deepseek.apiKey = patch.apiKey.trim();
    if (patch.baseURL !== undefined) {
      const base = patch.baseURL.trim();
      if (base === "") delete deepseek.baseURL;
      else deepseek.baseURL = base;
    }
    if (patch.count !== undefined) {
      // 越界或非整数就丢掉这一格（回到默认 10），不把坏值写进设置文件
      if (Number.isInteger(patch.count) && patch.count >= 1 && patch.count <= 50) deepseek.count = patch.count;
      else delete deepseek.count;
    }
    const next = { ...current, deepseek };
    await saveWebSettings(next);
    return webSettingsView(next);
  });

  /** 改动记录：所有会话按时序聚合；历史视图按会话/全书筛。 */
  ipcMain.handle("sessions:changes", (_e, projectId: string) => listTurnChanges(projectId));

  ipcMain.handle(
    "session:open",
    async (_e, p: { projectId: string; sessionId?: string }): Promise<OpenInfo> => {
      // 同一个会话的重连（渲染层刷新/重开同一本）不要 abort：那会把正在等待的提问打断。
      // 只有真的换会话/新建才收掉上一轮。
      const same =
        session !== undefined &&
        p.sessionId !== undefined &&
        session.projectId === p.projectId &&
        session.sessionId === p.sessionId;
      if (!same) {
        session?.abortCurrent();
        // 换会话：上一轮的审批一律拒绝（fail closed），排队中的迟到回答属于旧会话，丢掉；
        // 旧会话里 pending 的提问仍在 journal / tool part 里，切回去还能答。
        askBroker.pendingAll("interrupted");
        for (const [id, resolve] of [...waitingConfirms]) {
          waitingConfirms.delete(id);
          resolve("no");
        }
        answerQueue.length = 0;
        const chosen = p.sessionId === undefined ? await modelForNewSession() : undefined;
        // 旧会话可能只存了 provider/model/key，没存 baseURL（早期创建/先建会话后补配置）。
        // 缺了就按同名 profile 补回来；否则 SDK 会去 api.openai.com，DeepSeek 用户只会看到 timeout。
        const stored = p.sessionId === undefined
          ? undefined
          : await loadSessionMeta(p.projectId, p.sessionId).catch(() => undefined);
        const storedProfile = stored?.profile === undefined
          ? undefined
          : (await readModels()).profiles.find((x) => x.name === stored.profile);
        const resumed = stored?.model === undefined
          ? undefined
          : {
              ...stored.model,
              ...(stored.model.baseURL === undefined || stored.model.baseURL === ""
                ? storedProfile?.baseURL === undefined ? {} : { baseURL: storedProfile.baseURL }
                : {}),
              ...(stored.model.apiKey === undefined || stored.model.apiKey === ""
                ? storedProfile?.apiKey === undefined ? {} : { apiKey: storedProfile.apiKey }
                : {}),
            };
        session = await openSession({
          projectId: p.projectId,
          sessionId: p.sessionId,
          // 续聊由 `openSession` 从会话元里读回自己那套；新建才取默认那套
          model: chosen?.cfg ?? resumed,
          profile: chosen?.name ?? stored?.profile,
          // 新会话先叫「新会话」，第一句话发出去之后按那句话命名（见 tm:prompt）——
          // 都叫"桌面端"的话列表里分不出哪条是哪条
          title: p.sessionId === undefined ? NEW_SESSION_TITLE : undefined,
          io: makeIO(),
        });
        // 默认权限：设置里选了「工作区内修改」（默认）就带着 accept-edits 起步。
        // 模式不落盘，所以每次打开会话都按这里的默认值重新应用，而不是读回上一次的模式。
        const prefs = await readPrefs();
        if ((prefs.permissionMode ?? DEFAULT_PERMISSION_MODE) === "accept-edits") session.setMode("accept-edits");
        watchDocs(p.projectId);
        pushSessionState();
      } else if (session !== undefined && session.currentMode === undefined) {
        // 同一个会话重新进入：没有模式时才按设置补默认值。draft 等模式不覆盖——
        // 否则会把正在审阅的提案踢出草稿；而模式丢了（如旧代码退出草稿）则在这里自愈。
        const prefs = await readPrefs();
        if ((prefs.permissionMode ?? DEFAULT_PERMISSION_MODE) === "accept-edits") session.setMode("accept-edits");
      }
      const active = session;
      if (active === undefined) throw new Error("会话没有打开");
      const meta = await loadProjectMeta(p.projectId);
      // 上下文基线：一行正文都没写时，系统提示词和工具定义也已经占着窗口了，界面不该显示 0%
      const contextParts = await active.requestSizes().catch(() => undefined);
      // 拿实际在用的那份配置判，不是拿"用户选的那套"判——续聊读的是会话元里那套
      const warn = describeMissingKey(active.profile, active.model);

      // 重开后把还开着的提问带回去：journal 里有的是“提问已开始、助手消息还没提交”的那条；
      // 消息投影里的是已经 pending 的那条。取最早的一条，其余由界面从历史里点开。
      const open = await active.openAskViews();
      const first = open[0];
      const live = first === undefined ? undefined : askBroker.view(first.callId);
      const ask: AskView | undefined =
        first === undefined
          ? undefined
          : live !== undefined
            ? live
            : { callId: first.callId, questions: first.questions, pending: true, reason: "restarted" };

      return {
        sessionId: active.sessionId,
        book: meta.title,
        agent: active.agent.name,
        model: active.model.model,
        effort: active.model.reasoning,
        ...(active.profile === undefined ? {} : { profile: active.profile }),
        ...(contextParts === undefined ? {} : { contextParts }),
        ...(warn === undefined ? {} : { modelWarning: warn }),
        ...(ask === undefined ? {} : { ask }),
        sessionDir: sessionPaths(talemateHome(), active.projectId, active.sessionId).dir,
        messagesPath: sessionPaths(talemateHome(), active.projectId, active.sessionId).messages,
      };
    },
  );

  ipcMain.on("tm:reply", (_e, msg: { id: string; value: string }) => {
    const resolve = waitingConfirms.get(msg.id);
    if (resolve === undefined) return;
    waitingConfirms.delete(msg.id);
    resolve(msg.value as ConfirmReply);
  });

  ipcMain.handle("ask:answer", (_e, reply: AskReply) => submitAskAnswer(reply));

  ipcMain.on(
    "ask:hold",
    (_e, msg: { callId: string; mode: "pause" | "resume" | "hold" | "defer" }) => {
      askBroker.hold(msg.callId, msg.mode);
    },
  );

  ipcMain.on("tm:prompt", async (_e, text: string) => {
    try {
      if (session !== undefined) {
        // 会话名只在还叫默认「新会话」时更新：取第一行、截断。
        // 不靠一个内存 flag——重启或切走再回来时，那个 flag 早就没了，名字会永远停在「新会话」。
        const line = text.split("\n")[0]?.trim() ?? "";
        if (line) {
          const meta = await loadSessionMeta(session.projectId, session.sessionId).catch(() => undefined);
          if (meta === undefined || meta.title === NEW_SESSION_TITLE) {
            await session.saveMeta(line.length > 24 ? `${line.slice(0, 24)}…` : line);
            win?.webContents.send("tm:docs-changed");
          }
        }
      }
      await session?.post(text);
    } catch (err) {
      win?.webContents.send("tm:error", err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.on("tm:stop", () => session?.abortCurrent());
}

function makeIO(): UserIO {
  return {
    onEvent: (e) => {
      win?.webContents.send("tm:event", e);
      // 模式/待落盘会在回合中间变（进草稿模式就是一次工具调用）——每步之后重报一次，代价是一次取值
      if (e.type === "tool.result" || e.type === "step.end") pushSessionState();
      // idle 发生在 runLoop 的 finally 里，而 session.running 要到 runTurn 的 finally 才落；
      // 延到下一个微任务再排空，才不会把“刚结束的这一轮”误判成还在忙。
      if (e.type === "session.status" && e.status === "idle") queueMicrotask(() => void drainAnswerQueue());
    },
    confirm: (action, summary) => askConfirm("tm:confirm", { action, summary }),
    askUser: (req) => askBroker.wait(req),
  };
}

/**
 * 窗口外观按系统分区（渲染层用 `tm.platform` 画对应的 chrome）：
 *
 * - **macOS**：没有标题栏，红绿灯由系统内嵌在最左（`hiddenInset`）；
 *   渲染层在左栏顶行给它们留位置，收起/展开靠那一行的右缘。
 * - **Windows**：一整行标题栏。最小化/最大化/关闭由 `titleBarOverlay` 画在右上，
 *   位置、悬停、双击最大化全由系统保证——自绘只会多出一堆要维护的边界情况。
 * - **其余（Linux）**：保留系统默认边框。overlay 在那边不保证，不做自绘。
 *
 * `titleBarOverlay` 的颜色不跟主题走的话，切深色后标题栏会留一条浅色，所以监听 `nativeTheme`。
 */
const PLATFORM = process.platform;
/** 材质在开窗前定死（平台与系统版本决定，运行中不变）。 */
const WINDOW_MATERIAL = resolveWindowMaterial();
/** 主题监听只挂一次（窗口可能重建，回调里现取 `win`）。 */
let themeWired = false;

/** 实际生效的配色。Windows 上 prefers-color-scheme 不可靠，统一由主进程推给渲染层。 */
function currentTheme(): ColorScheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

/** Windows 标题栏按钮区：有材质时透明；没有材质时用实色。 */
function overlayConfig() {
  const dark = nativeTheme.shouldUseDarkColors;
  const clear = WINDOW_MATERIAL !== "none";
  return {
    color: clear ? "#00000000" : dark ? "#181920" : "#f2f3f9",
    symbolColor: dark ? "#e9e8e3" : "#1e1d1a",
    height: 44,
  };
}

function windowChrome(): Electron.BrowserWindowConstructorOptions {
  if (PLATFORM === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 15 },
      ...(WINDOW_MATERIAL === "vibrancy"
        ? { vibrancy: "sidebar" as const, visualEffectState: "active" as const }
        : {}),
    };
  }
  if (PLATFORM === "win32") {
    return {
      // 菜单栏本身没有应用动作，但 Edit 菜单的 Ctrl+C/V 加速键必须留着；隐藏菜单栏，快捷键照常。
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: overlayConfig(),
      ...(WINDOW_MATERIAL === "acrylic" || WINDOW_MATERIAL === "mica"
        ? { backgroundMaterial: WINDOW_MATERIAL }
        : {}),
    };
  }
  return { autoHideMenuBar: true };
}

/** Windows 标题栏的颜色要跟着系统主题走（`titleBarOverlay` 不会自己变）。 */
function syncTitleBarOverlay(w: BrowserWindow | undefined): void {
  if (PLATFORM !== "win32" || w === undefined) return;
  w.setTitleBarOverlay(overlayConfig());
}

/** 无材质时窗口底色也要跟主题；否则切深色后窗口边缘/加载瞬间会留浅色。 */
function syncWindowTheme(w: BrowserWindow | undefined): void {
  if (w === undefined) return;
  syncTitleBarOverlay(w);
  if (PLATFORM === "win32" && WINDOW_MATERIAL === "none") {
    w.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#151513" : "#f6f6f3");
  }
}

async function openWindow(show: boolean): Promise<BrowserWindow> {
  const dark = nativeTheme.shouldUseDarkColors;
  const w = new BrowserWindow({
    ...windowChrome(),
    width: 1357, // 1180 × 1.15：两块面板并排之后中栏才够读
    height: 780,
    show: false,
    title: "Talemate",
    // 有材质时窗口必须透明，否则材质被盖住；没材质时给实底，否则黑窗
    backgroundColor: WINDOW_MATERIAL === "none" ? (dark ? "#151513" : "#f6f6f3") : "#00000000",
    webPreferences: {
      // 预加载是 CJS（沙箱下必须是），产物由 electron-vite 按包类型决定
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 首帧前让 preload 拿到材质与配色；Windows 上不能只等 prefers-color-scheme。
      additionalArguments: [`--app-material=${WINDOW_MATERIAL}`, `--app-theme=${currentTheme()}`],
    },
  });
  // 必须挂到模块级：事件、确认、提问、报错全都经 `win` 发出去，漏了 `win?.webContents.send(...)`
  // 就变成静默空操作——界面照常打开、照常能发话，但一个实时回复都看不到，而且不报错。
  win = w;
  // 主题切换：标题栏颜色与渲染层的 data-theme 一起换。只挂一次；`win` 可能换，回调里现取。
  syncWindowTheme(w);
  if (!themeWired) {
    themeWired = true;
    nativeTheme.on("updated", () => {
      syncWindowTheme(win);
      win?.webContents.send("tm:theme", currentTheme());
    });
  }
  w.on("closed", () => {
    if (win === w) win = undefined;
    // 没有窗口就没有回答方：审批一律拒绝（fail closed）；提问转 pending，
    // journal 与 tool part 会留着，重开之后还能回答。
    askBroker.pendingAll("interrupted");
    for (const resolve of waitingConfirms.values()) resolve("no");
    waitingConfirms.clear();
  });
  w.once("ready-to-show", () => w.setTitle("Talemate") ?? (show && w.show()));
  await w.loadFile(join(__dirname, "../renderer/index.html"));
  // 首帧用 additionalArguments 已经落好；这里再推一次，覆盖加载期间发生的系统主题变化。
  w.webContents.send("tm:theme", currentTheme());
  return w;
}

/** 无窗口自检：走一遍真 harness，看它在 Electron 的 Node 里跑不跑得通。 */
async function selftest(): Promise<void> {
  const projects = await listProjects();
  const book = projects[0] ?? (await createProject({ title: "桌面端试验" }));
  const text: string[] = [];
  const tools: string[] = [];
  const io: UserIO = {
    onEvent: (e) => {
      if (e.type === "text.delta") text.push(e.text);
      if (e.type === "tool-call") tools.push(e.name);
    },
    confirm: async () => "once",
    askUser: async () => ({ kind: "cancelled", reason: "no-answerer" }),
  };

  const s = await openSession({ projectId: book.id, io, title: "自检" });
  await s.post("自检：随便说一句。");
  console.log(`[selftest] node=${process.versions.node} electron=${process.versions.electron}`);
  console.log(`[selftest] 资源根=${process.env.TALEMATE_RESOURCES ?? "（未设置）"}`);
  const n = await latestChapter(book.id);
  console.log(`[selftest] 取数口：${(await sessionsOf(book.id)).length} 条会话 · ${n === null ? "还没有正文" : `写到第 ${n} 章`}`);
  console.log(`[selftest] 工具调用=${tools.join(",") || "（无）"}`);
  console.log(text.length > 0 ? "✔ harness 在 Electron 里跑通了" : "✘ 一个字的文本都没收到");
  app.exit(text.length > 0 ? 0 : 1);
}

/**
 * 带窗口的自检：开一个不显示的窗口，等渲染层报"画面出来了"。
 *
 * 这是唯一能抓到"白屏"的地方——产物缺个 js、路径不对、渲染层一上来就抛异常，全都表现为一片空白
 * 而控制台什么都没有。所以渲染层画完第一屏会回一句话，这里等它。
 */
/** 等渲染层下一句话（超时也算一句话，好让失败看得见原因）。 */
function nextRendererReport(): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("超时：15 秒内没收到渲染层的消息"), 15000);
    ipcMain.once("tm:rendered", (_e, summary: string) => {
      clearTimeout(timer);
      resolve(summary);
    });
  });
}

async function selftestWindow(): Promise<void> {
  // 不要在调用处赋值：`win` 只能由 `openWindow` 内部挂上，否则自检这条路就绕开了「生产那条路
  // 挂没挂」这个判据，守卫会一直是绿的。
  await openWindow(false);
  const painted = await nextRendererReport();
  console.log(`[selftest:window] 画出来了：${painted}`);

  /*
   * 第二关：事件到底有没有送到渲染层。光看"画出来了"不够——`win` 没挂上时界面照开、能发话，
   * 却收不到任何实时回复（见 `openWindow`）。所以走一遍真链路：起会话、发一句话，等渲染层回
   * 一句"收到事件"。
   */
  const projects = await listProjects();
  const book = projects[0] ?? (await createProject({ title: "桌面端试验" }));
  session = await openSession({ projectId: book.id, io: makeIO(), title: "自检" });
  const heard = nextRendererReport();
  await session.post("自检：随便说一句。");
  const events = await heard;
  console.log(`[selftest:window] 事件：${events}`);

  const ok = painted.startsWith("✓") && events.startsWith("✓");
  console.log(ok ? "✔ 窗口、渲染层、事件流都通了" : "✘ 有一关没过（白屏 或 事件没送到渲染层）");
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(async () => {
  // 外观偏好要在开窗之前落到 nativeTheme：窗口底色与 Windows 标题栏都按它取色
  nativeTheme.themeSource = (await readPrefs()).appearance ?? "system";
  // Windows/Linux 的 Edit 菜单不是装饰：去掉整个菜单，Ctrl+C/V 的加速键也会一起消失。
  // 菜单栏用 autoHideMenuBar 藏起来，只保留编辑快捷键。macOS 用系统默认菜单。
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "编辑",
          submenu: [
            { role: "undo", label: "撤销" },
            { role: "redo", label: "重做" },
            { type: "separator" },
            { role: "cut", label: "剪切" },
            { role: "copy", label: "复制" },
            { role: "paste", label: "粘贴" },
            { role: "selectAll", label: "全选" },
          ],
        },
      ]),
    );
  }
  registerHandlers();
  if (SELFTEST === "window") return selftestWindow();
  if (SELFTEST === "1") return selftest();
  void openWindow(true);
});

app.on("window-all-closed", () => app.quit());
