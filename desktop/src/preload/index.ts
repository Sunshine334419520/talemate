/**
 * 预加载：渲染层能碰到的**全部**东西就是下面这些。
 *
 * 渲染层拿不到 Node、拿不到 `ipcRenderer` 本身——这是 Electron 安全模型里唯一要紧的一条，
 * 而它在这里格外便宜：壳要暴露的能力本来就少，而且**没有一条是"操作文件系统"**。
 * 取数一律走 `ipcMain.handle`（invoke/response），推送走事件。
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  AskRequest,
  ConfirmRequest,
  DocNode,
  LLMEvent,
  ModelProfile,
  OpenInfo,
  ProfileView,
  Prefs,
  ProjectCard,
  SessionRow,
  SessionState,
  StoredMessage,
  TmApi,
} from "../shared/api";

const api: TmApi = {
  listProjects: () => ipcRenderer.invoke("projects:list") as Promise<ProjectCard[]>,
  createProject: (title, channel, genre) =>
    ipcRenderer.invoke("projects:create", { title, channel, genre }) as Promise<{ id: string }>,
  updateProject: (id, patch) => ipcRenderer.invoke("projects:update", { id, ...patch }) as Promise<void>,
  listSessions: (projectId) => ipcRenderer.invoke("sessions:list", projectId) as Promise<SessionRow[]>,
  docsTree: (projectId) => ipcRenderer.invoke("docs:tree", projectId) as Promise<DocNode[]>,
  docText: (projectId, path) =>
    ipcRenderer.invoke("docs:text", { projectId, path }) as Promise<string | undefined>,
  saveDoc: (projectId, path, text) =>
    ipcRenderer.invoke("docs:save", { projectId, path, text }) as Promise<"ok" | "stale">,
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
  onDocsChanged: (cb) => ipcRenderer.on("tm:docs-changed", () => cb()),
  onSessionState: (cb) => ipcRenderer.on("tm:session-state", (_e, s: SessionState) => cb(s)),
  history: (projectId, sessionId) =>
    ipcRenderer.invoke("sessions:history", { projectId, sessionId }) as Promise<StoredMessage[]>,
  openSession: (projectId, sessionId) =>
    ipcRenderer.invoke("session:open", { projectId, sessionId }) as Promise<OpenInfo>,

  onEvent: (cb) => ipcRenderer.on("tm:event", (_e, evt: LLMEvent) => cb(evt)),
  onConfirm: (cb) => ipcRenderer.on("tm:confirm", (_e, req: ConfirmRequest) => cb(req)),
  onAsk: (cb) => ipcRenderer.on("tm:ask", (_e, req: AskRequest) => cb(req)),
  onError: (cb) => ipcRenderer.on("tm:error", (_e, msg: string) => cb(msg)),

  prompt: (text) => ipcRenderer.send("tm:prompt", text),
  stop: () => ipcRenderer.send("tm:stop"),
  reply: (id, value) => ipcRenderer.send("tm:reply", { id, value }),
  reportRendered: (summary) => ipcRenderer.send("tm:rendered", summary),
};

contextBridge.exposeInMainWorld("tm", api);
