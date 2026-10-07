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
import { app, BrowserWindow, ipcMain } from "electron";
import type { ConfirmReply, ModelConfig, ProjectMeta } from "../../../src/core/types";
import { leadLine } from "../../../src/framework/markdown";
import { readDoc } from "../../../src/storage/corpus";
import { writeProjectMeta } from "../../../src/storage/project";
import { docTree } from "../../../src/framework/anchor";
import { chapterNumberOf } from "../../../src/framework/plan";
import { openSession, type Session, type UserIO } from "../../../src/session/session";
import { enumerateDocs } from "../../../src/storage/corpus";
import { listSessionIds, loadMessages, loadSessionMeta } from "../../../src/storage/session-store";
import { createProject, listProjects, loadProjectMeta } from "../../../src/storage/project";
import { writeIfUnchanged } from "../../../src/storage/atomic";
import { watch, type FSWatcher } from "node:fs";
import { DOC_ROOTS, docAbs } from "../../../src/storage/corpus";
import { rootAbs, talemateHome } from "../../../src/core/config";
import { readFile, writeFile } from "node:fs/promises";
import { loadModelConfig } from "../../../src/core/config";
import type {
  DocNode,
  ModelProfile,
  ProfileView,
  OpenInfo,
  Prefs,
  ProjectCard,
  SessionRow,
  SessionState,
} from "../shared/api";

const SELFTEST = process.env.TALEMATE_DESKTOP_SELFTEST ?? "";

let win: BrowserWindow | undefined;
let session: Session | undefined;
let watchers: FSWatcher[] = [];
/** 这一次开的是新会话——第一句话发出去时用它命名，只做一次 */
let freshSession = false;

/** 等渲染层回答的请求（确认、提问）：一条一个 id，答完即删。 */
const waiting = new Map<string, (value: string) => void>();

function ask(channel: string, payload: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    win?.webContents.send(channel, { id, ...payload });
  });
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
    ids.map(async (id): Promise<SessionRow> => {
      const meta = await loadSessionMeta(projectId, id).catch(() => undefined);
      return { id, title: meta?.title ?? id, updatedAt: meta?.time.updated ?? 0 };
    }),
  );
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 顶栏那两个标记的当下值，现取——模式会在回合中间变（进/出草稿模式都是工具调用）。 */
function sessionState(): SessionState {
  return { mode: session?.currentMode?.title, pending: session?.pendingLabel };
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

/** 壳自己的偏好文件。读失败一律当没有——偏好丢了只是回到默认值，不值得为它报错。 */
function prefsFile(): string {
  return join(talemateHome(), "desktop.json");
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
      return { ...rest, models: p.models ?? (model !== undefined ? [model] : []) } as ModelProfile;
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

/** 环境变量那套（`.env`）——一份配置都没有时实际在用的就是它，界面上要看得见。 */
function envProfile(): ProfileView {
  const cfg = loadModelConfig();
  return {
    name: "当前（.env）",
    provider: cfg.provider,
    models: [cfg.model],
    baseURL: cfg.baseURL,
    maxTokens: cfg.maxTokens,
    reasoning: cfg.reasoning,
    hasKey: Boolean(cfg.apiKey ?? process.env.ANTHROPIC_API_KEY),
  };
}

function modelsFile(): string {
  return join(talemateHome(), "models.json");
}

async function writeModels(next: { profiles: ModelProfile[]; default?: string }): Promise<void> {
  await writeFile(modelsFile(), JSON.stringify(next, null, 2), "utf-8");
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

/** 新建会话用哪套：默认那套，没有就退回环境变量。 */
async function modelForNewSession(): Promise<ModelConfig | undefined> {
  const { profiles, default: name } = await readModels();
  const picked = profiles.find((p) => p.name === name) ?? profiles[0];
  return picked === undefined ? undefined : toModelConfig(picked);
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
      return { id: meta.id };
    },
  );

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
      env: envProfile(),
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

  ipcMain.handle("prefs:get", async (): Promise<Prefs> => {
    try {
      return JSON.parse(await readFile(prefsFile(), "utf-8")) as Prefs;
    } catch {
      return {};
    }
  });

  ipcMain.handle("prefs:save", async (_e, patch: Prefs): Promise<void> => {
    const now = await (async (): Promise<Prefs> => {
      try {
        return JSON.parse(await readFile(prefsFile(), "utf-8")) as Prefs;
      } catch {
        return {};
      }
    })();
    await writeFile(prefsFile(), JSON.stringify({ ...now, ...patch }, null, 2), "utf-8");
  });

  /** 历史投影：进会话先拉这一次，之后靠事件增量（`architecture.md` 给薄 TUI 写下的那条）。 */
  ipcMain.handle("sessions:history", (_e, p: { projectId: string; sessionId: string }) =>
    loadMessages(p.projectId, p.sessionId),
  );

  ipcMain.handle(
    "session:open",
    async (_e, p: { projectId: string; sessionId?: string }): Promise<OpenInfo> => {
      session?.abortCurrent();
      session = await openSession({
        projectId: p.projectId,
        sessionId: p.sessionId,
        // 续聊用会话自己记的那套（`talemate.json` 的 agents / 会话元），新建才取默认那套
        model: p.sessionId === undefined ? await modelForNewSession() : undefined,
        // 新会话先叫「新会话」，第一句话发出去之后按那句话命名（见 tm:prompt）——
        // 都叫"桌面端"的话列表里分不出哪条是哪条
        title: p.sessionId === undefined ? "新会话" : undefined,
        io: makeIO(),
      });
      freshSession = p.sessionId === undefined;
      watchDocs(p.projectId);
      pushSessionState();
      const meta = await loadProjectMeta(p.projectId);
      return {
        sessionId: session.sessionId,
        book: meta.title,
        agent: session.agent.name,
        model: session.model.model,
        effort: session.model.reasoning,
      };
    },
  );

  ipcMain.on("tm:reply", (_e, msg: { id: string; value: string }) => {
    const resolve = waiting.get(msg.id);
    if (resolve) {
      waiting.delete(msg.id);
      resolve(msg.value);
    }
  });

  ipcMain.on("tm:prompt", async (_e, text: string) => {
    try {
      if (freshSession && session !== undefined) {
        freshSession = false;
        // 用第一句话当会话名：取第一行、截断；命名只做一次，否则列表里的名字会一直跳
        const line = text.split("\n")[0]?.trim() ?? "";
        if (line) await session.saveMeta(line.length > 24 ? `${line.slice(0, 24)}…` : line);
        win?.webContents.send("tm:docs-changed");
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
    },
    confirm: (action, summary) => ask("tm:confirm", { action, summary }) as Promise<ConfirmReply>,
    askUser: (question, options) => ask("tm:ask", { question, options: options ?? [] }),
  };
}

async function openWindow(show: boolean): Promise<BrowserWindow> {
  const w = new BrowserWindow({
    width: 1357, // 1180 × 1.15：两块面板并排之后中栏才够读
    height: 780,
    show: false,
    title: "talemate",
    backgroundColor: "#f6f5f2",
    webPreferences: {
      // 预加载是 CJS（沙箱下必须是），产物由 electron-vite 按包类型决定
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 必须挂到模块级：事件、确认、提问、报错全都经 `win` 发出去，漏了 `win?.webContents.send(...)`
  // 就变成静默空操作——界面照常打开、照常能发话，但一个实时回复都看不到，而且不报错。
  win = w;
  w.on("closed", () => {
    if (win === w) win = undefined;
  });
  w.once("ready-to-show", () => w.setTitle("talemate") ?? (show && w.show()));
  await w.loadFile(join(__dirname, "../renderer/index.html"));
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
    askUser: async (q) => `（自动答复：${q}）`,
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

app.whenReady().then(() => {
  registerHandlers();
  if (SELFTEST === "window") return selftestWindow();
  if (SELFTEST === "1") return selftest();
  void openWindow(true);
});

app.on("window-all-closed", () => app.quit());
