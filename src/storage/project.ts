/**
 * 项目级存储：
 * - 建/列/读/写项目元（talemate.json）
 * - AGENTS.md（项目规则）、docs/（活文档）、chapters/（成品）
 * 会话级存储见 session-store.ts。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { talemateHome, paths, projectPaths } from "../core/config";
import type { ProjectMeta } from "../core/types";
import { rand4, safeName, slugify } from "./util";

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
