/**
 * 文件系统存储层。
 * - 项目：<TALEMATE_HOME>/novels/<project-id>/（talemate.json 元信息 + docs/ + chapters/ + .talemate/）
 * - 会话：<project>/.talemate/sessions/<session-id>/{session.json,messages.jsonl}
 * - messages.jsonl 每行一条带 seq 的消息（append-only）；compaction 也是一条消息。
 */
import { mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { talemateHome, paths, projectPaths, sessionPaths } from "../core/config";
import type { ProjectMeta, SessionMeta, StoredMessage } from "../core/types";

// ─── 项目 ───

export async function createProject(opts: { title: string; genre?: string }): Promise<ProjectMeta> {
  const home = talemateHome();
  const p = paths(home);
  await mkdir(p.novelsRoot, { recursive: true });

  // project-id：拼音/英文 slug + 短随机，避免撞名
  const id = `${slugify(opts.title)}-${rand4()}`;
  const pp = projectPaths(home, id);
  await mkdir(pp.docs, { recursive: true });
  await mkdir(pp.chapters, { recursive: true });
  await mkdir(pp.skills, { recursive: true });
  await mkdir(pp.sessions, { recursive: true });

  const meta: ProjectMeta = { id, title: opts.title, genre: opts.genre, createdAt: Date.now() };
  await writeProjectMeta(meta);
  // 初始 AGENTS.md（项目规则占位，后续 editor 可扩写）
  await writeFile(
    pp.agents,
    [
      `# ${opts.title} · 项目规则`,
      "",
      "这是本小说项目的操作规范（对 agent 常驻注入）。",
      "- 设定文档在 docs/：core.md（核心/卖点）、world.md（世界观）、characters.md（角色）、outline.md（大纲）。",
      "- 写作前先读对应 docs 切片取当前版本；不引用缓存旧设定。",
      "- 成品正文存 chapters/，命名 chapter_ch<N>_v<M>.md；规划存 plan_ch<N>.md。",
      "",
    ].join("\n"),
    "utf-8",
  );
  return meta;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const home = talemateHome();
  const root = paths(home).novelsRoot;
  let entries: string[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true }).then((ds) =>
      ds.filter((d) => d.isDirectory()).map((d) => d.name),
    );
  } catch {
    return [];
  }
  const out: ProjectMeta[] = [];
  for (const id of entries) {
    try {
      out.push(await loadProjectMeta(id));
    } catch {
      /* 目录损坏则跳过 */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadProjectMeta(projectId: string): Promise<ProjectMeta> {
  const file = projectPaths(talemateHome(), projectId).meta;
  return JSON.parse(await readFile(file, "utf-8")) as ProjectMeta;
}

export async function writeProjectMeta(meta: ProjectMeta): Promise<void> {
  const file = projectPaths(talemateHome(), meta.id).meta;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(meta, null, 2), "utf-8");
}

export async function readProjectRules(projectId: string): Promise<string> {
  const file = projectPaths(talemateHome(), projectId).agents;
  try {
    return await readFile(file, "utf-8");
  } catch {
    return "";
  }
}

/** 读项目 docs/ 下某个文档（不存在返回 undefined） */
export async function readDoc(projectId: string, name: string): Promise<string | undefined> {
  const safe = safeName(name);
  if (!safe) return undefined;
  const file = join(projectPaths(talemateHome(), projectId).docs, safe);
  try {
    return await readFile(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** 写/覆盖 docs/ 下文档；返回完整路径 */
export async function writeDoc(projectId: string, name: string, content: string): Promise<string> {
  const safe = safeName(name);
  if (!safe) throw new Error(`非法文档名：${name}`);
  const pp = projectPaths(talemateHome(), projectId);
  await mkdir(pp.docs, { recursive: true });
  const file = join(pp.docs, safe);
  await writeFile(file, content, "utf-8");
  return file;
}

export async function listDocs(projectId: string): Promise<string[]> {
  const dir = projectPaths(talemateHome(), projectId).docs;
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/** 成品/规划落 chapters/（命名规约由调用方给文件名） */
export async function saveChapter(projectId: string, filename: string, content: string): Promise<string> {
  const safe = safeName(filename);
  if (!safe) throw new Error(`非法文件名：${filename}`);
  const pp = projectPaths(talemateHome(), projectId);
  await mkdir(pp.chapters, { recursive: true });
  const file = join(pp.chapters, safe);
  await writeFile(file, content, "utf-8");
  return file;
}

// ─── 会话 ───

export async function createSession(
  projectId: string,
  meta: Omit<SessionMeta, "time">,
): Promise<SessionMeta> {
  const sp = sessionPaths(talemateHome(), projectId, meta.id);
  await mkdir(sp.dir, { recursive: true });
  const full: SessionMeta = { ...meta, time: { created: Date.now(), updated: Date.now() } };
  await writeFile(sp.meta, JSON.stringify(full, null, 2), "utf-8");
  await touch(sp.messages);
  return full;
}

export async function loadSessionMeta(projectId: string, sessionId: string): Promise<SessionMeta> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  return JSON.parse(await readFile(sp.meta, "utf-8")) as SessionMeta;
}

export async function listSessionIds(projectId: string): Promise<string[]> {
  const dir = projectPaths(talemateHome(), projectId).sessions;
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 追加一条消息，返回带 seq 的完整消息。seq 单调：读当前尾 seq +1。 */
export async function appendMessage(
  projectId: string,
  sessionId: string,
  msg: Omit<StoredMessage, "seq" | "ts">,
): Promise<StoredMessage> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  await mkdir(sp.dir, { recursive: true });
  const nonEmpty = (await readLines(sp.messages)).filter((l) => l.trim());
  const lastSeq = nonEmpty.length ? (JSON.parse(nonEmpty[nonEmpty.length - 1]) as StoredMessage).seq : 0;
  const full: StoredMessage = { ...msg, seq: lastSeq + 1, ts: Date.now() };
  await writeFile(
    sp.messages,
    (nonEmpty.length ? nonEmpty.join("\n") + "\n" : "") + JSON.stringify(full) + "\n",
    "utf-8",
  );
  return full;
}

/** 读会话全部消息（保序）。无会话文件时返回 []。 */
export async function loadMessages(projectId: string, sessionId: string): Promise<StoredMessage[]> {
  const sp = sessionPaths(talemateHome(), projectId, sessionId);
  const lines = await readLines(sp.messages);
  return lines
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StoredMessage)
    .sort((a, b) => a.seq - b.seq);
}

/** 供模型上下文：compaction 消息 + 其后的全部消息（§8：上下文=最新 compaction 之后的 seq） */
export function loadModelWindow(messages: StoredMessage[]): StoredMessage[] {
  let from = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "compaction") from = i;
  }
  return messages.slice(from);
}

function readLines(file: string): Promise<string[]> {
  return readFile(file, "utf-8")
    .then((t) => (t ? t.split("\n") : []))
    .catch(() => [] as string[]);
}

async function touch(file: string): Promise<void> {
  try {
    await access(file);
  } catch {
    await writeFile(file, "", "utf-8");
  }
}

function slugify(s: string): string {
  const ascii = s
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || "novel";
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

function safeName(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop() ?? name; // 只取最后一段，防路径穿越
  return /^[\w一-鿿.\-]+$/.test(base) ? base : undefined;
}
