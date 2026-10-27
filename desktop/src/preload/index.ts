/**
 * 预加载：渲染层能碰到的全部东西就是下面这些。
 *
 * 渲染层拿不到 Node、拿不到 `ipcRenderer` 本身——这是 Electron 安全模型里唯一要紧的一条，
 * 而它在这里格外便宜：壳要暴露的能力本来就少，而且没有一条是"操作文件系统"。取数一律走
 * `ipcMain.handle`（invoke/response），推送走事件。
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  AskPendingReason,
  AskReply,
  AskView,
  ColorScheme,
  ConfirmRequest,
  DocNode,
  LLMEvent,
  ModelProfile,
  OpenInfo,
  ProfileView,
  Prefs,
  ProjectCard,
  RewindFilePreview,
  RewindResult,
  SessionRow,
  SessionState,
  SessionTurnChanges,
  StoredMessage,
  StyleCatalog,
  TmApi,
  WebSettingsPatch,
  WebSettingsView,
  WindowMaterial,
} from "../shared/api";

/**
 * 材质由主进程经 `additionalArguments` 同步带进来；`index.html` 的内联脚本会把它
 * 写进 `data-material`，赶在样式与 React 之前，避免首帧闪一下实色底。
 */
const MATERIAL_FLAG = "--app-material=";
const material: WindowMaterial =
  (process.argv.find((arg) => arg.startsWith(MATERIAL_FLAG))?.slice(MATERIAL_FLAG.length) as
    | WindowMaterial
    | undefined) ?? "none";
const THEME_FLAG = "--app-theme=";
const theme: ColorScheme =
  (process.argv.find((arg) => arg.startsWith(THEME_FLAG))?.slice(THEME_FLAG.length) as
    | ColorScheme
    | undefined) ?? "light";

const api: TmApi = {
  platform: process.platform,
  material,
  theme,
  listProjects: () => ipcRenderer.invoke("projects:list") as Promise<ProjectCard[]>,
  createProject: (title, channel, genre) =>
    ipcRenderer.invoke("projects:create", { title, channel, genre }) as Promise<{ id: string }>,
  updateProject: (id, patch) => ipcRenderer.invoke("projects:update", { id, ...patch }) as Promise<void>,
  deleteProject: (id) => ipcRenderer.invoke("projects:delete", id) as Promise<"ok" | "missing">,
  projectStatus: (projectId) => ipcRenderer.invoke("projects:status", projectId) as Promise<string>,
  permissions: () => ipcRenderer.invoke("session:permissions") as Promise<string>,
  sessionDebug: () => ipcRenderer.invoke("session:debug") as Promise<string>,
  listSessions: (projectId) => ipcRenderer.invoke("sessions:list", projectId) as Promise<SessionRow[]>,
  docsTree: (projectId) => ipcRenderer.invoke("docs:tree", projectId) as Promise<DocNode[]>,
  docText: (projectId, path) =>
    ipcRenderer.invoke("docs:text", { projectId, path }) as Promise<string | undefined>,
  saveDoc: (projectId, path, text) =>
    ipcRenderer.invoke("docs:save", { projectId, path, text }) as Promise<"ok" | "stale">,
  styleCatalog: (projectId) => ipcRenderer.invoke("style:list", projectId) as Promise<StyleCatalog>,
  setStyle: (projectId, name) =>
    ipcRenderer.invoke("style:set", { projectId, name }) as Promise<"ok" | "stale" | "unknown">,
  sessionState: (projectId) => ipcRenderer.invoke("session:state", projectId) as Promise<SessionState>,
  setEffort: (effort) => ipcRenderer.invoke("session:effort", effort) as Promise<void>,
  models: () =>
    ipcRenderer.invoke("models:list") as Promise<{ profiles: ProfileView[]; default?: string; env: ProfileView }>,
  saveProfile: (p) => ipcRenderer.invoke("models:save", p) as Promise<void>,
  deleteProfile: (name) => ipcRenderer.invoke("models:delete", name) as Promise<void>,
  setDefaultProfile: (name) => ipcRenderer.invoke("models:default", name) as Promise<void>,
  sessionUsage: (projectId, sessionId) =>
    ipcRenderer.invoke("session:usage", { projectId, sessionId }) as Promise<
      { input: number; output: number }[]
    >,
  useProfile: (name, model) => ipcRenderer.invoke("session:use-model", { name, model }) as Promise<void>,
  prefs: () => ipcRenderer.invoke("prefs:get") as Promise<Prefs>,
  savePrefs: (patch) => ipcRenderer.invoke("prefs:save", patch) as Promise<void>,
  webSettings: () => ipcRenderer.invoke("web:settings") as Promise<WebSettingsView>,
  saveWebSettings: (patch: WebSettingsPatch) =>
    ipcRenderer.invoke("web:save", patch) as Promise<WebSettingsView>,
  onTheme: (cb) => ipcRenderer.on("tm:theme", (_e, t: ColorScheme) => cb(t)),
  onDocsChanged: (cb) => ipcRenderer.on("tm:docs-changed", () => cb()),
  onSessionState: (cb) => ipcRenderer.on("tm:session-state", (_e, s: SessionState) => cb(s)),
  history: (projectId, sessionId) =>
    ipcRenderer.invoke("sessions:history", { projectId, sessionId }) as Promise<StoredMessage[]>,
  rewind: (seq, opts) =>
    ipcRenderer.invoke("session:rewind", { seq, ...opts }) as Promise<RewindResult>,
  rewindPreview: (seq) => ipcRenderer.invoke("session:rewind-preview", seq) as Promise<RewindFilePreview>,
  resolveProposal: (req) => ipcRenderer.invoke("session:proposal", req) as Promise<void>,
  changes: (projectId) =>
    ipcRenderer.invoke("sessions:changes", projectId) as Promise<SessionTurnChanges[]>,
  openSession: (projectId, sessionId) =>
    ipcRenderer.invoke("session:open", { projectId, sessionId }) as Promise<OpenInfo>,

  onEvent: (cb) => ipcRenderer.on("tm:event", (_e, evt: LLMEvent) => cb(evt)),
  onConfirm: (cb) => ipcRenderer.on("tm:confirm", (_e, req: ConfirmRequest) => cb(req)),
  onAsk: (cb) => ipcRenderer.on("tm:ask", (_e, view: AskView) => cb(view)),
  onAskPending: (cb) =>
    ipcRenderer.on("tm:ask-pending", (_e, p: { callId: string; reason: AskPendingReason }) => cb(p)),
  onAskClosed: (cb) => ipcRenderer.on("tm:ask-closed", (_e, p: { callId: string }) => cb(p)),
  answerAsk: (reply: AskReply) =>
    ipcRenderer.invoke("ask:answer", reply) as Promise<"ok" | "stale" | "invalid" | "queued">,
  holdAsk: (callId, mode) => ipcRenderer.send("ask:hold", { callId, mode }),
  onError: (cb) => ipcRenderer.on("tm:error", (_e, msg: string) => cb(msg)),

  prompt: (text) => ipcRenderer.send("tm:prompt", text),
  stop: () => ipcRenderer.send("tm:stop"),
  reply: (id, value) => ipcRenderer.send("tm:reply", { id, value }),
  reportRendered: (summary) => ipcRenderer.send("tm:rendered", summary),
};

contextBridge.exposeInMainWorld("tm", api);
