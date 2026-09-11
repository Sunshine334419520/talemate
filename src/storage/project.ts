/**
 * 项目级存储：
 * - 建/列/读/写项目元（talemate.json）
 * - AGENTS.md（项目规则）、design/（活文档）、chapters/（成品）
 * 会话级存储见 session-store.ts。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { talemateHome, paths, projectPaths } from "../core/config";
import type { ProjectMeta } from "../core/types";
import { rand4, safeName, safeRelPath, slugify } from "./util";

export async function createProject(opts: { title: string; genre?: string }): Promise<ProjectMeta> {
  const home = talemateHome();
  const p = paths(home);
  await mkdir(p.novelsRoot, { recursive: true });

  // project-id：拼音/英文 slug + 短随机，避免撞名
  const id = `${slugify(opts.title)}-${rand4()}`;
  const pp = projectPaths(home, id);
  await mkdir(pp.design, { recursive: true });
  await mkdir(pp.wiki, { recursive: true });
  await mkdir(pp.characters, { recursive: true });
  await mkdir(pp.outline, { recursive: true });
  await mkdir(pp.chapters, { recursive: true });
  await mkdir(pp.skills, { recursive: true });
  await mkdir(pp.sessions, { recursive: true });

  const meta: ProjectMeta = { id, title: opts.title, genre: opts.genre, createdAt: Date.now() };
  await writeProjectMeta(meta);
  // 建项目不预种任何文件：
  // - design/ 懒建——用户要完善某层时由 editor 调 design-spec 拿形状再成稿落盘；
  // - AGENTS.md 是**用户自己的**项目规矩（06 §6.3：等同 CLAUDE.md——项目级、用户管理、默认可空）。
  //   系统只提供"每轮注入该文件"的能力（readProjectRules → context/assemble）：文件不存在 →
  //   readProjectRules 返回 "" → assemble 整块跳过，什么都不注入。用户建了才加载。
  //   editor 的写接口被限定在 design/ 下（safeRelPath 挡 ".."），结构上碰不到它。
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

/** 读 design/ 下某个文档（相对路径，可含子目录如 wiki/地理.md；不存在返回 undefined） */
export async function readDesign(projectId: string, name: string): Promise<string | undefined> {
  const safe = safeRelPath(name);
  if (!safe) return undefined;
  const file = join(projectPaths(talemateHome(), projectId).design, safe);
  try {
    return await readFile(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** 写/覆盖 design/ 下文档（相对路径，可含子目录）；返回完整路径 */
export async function writeDesign(projectId: string, name: string, content: string): Promise<string> {
  const safe = safeRelPath(name);
  if (!safe) throw new Error(`非法文档名：${name}`);
  const pp = projectPaths(talemateHome(), projectId);
  const file = join(pp.design, safe);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf-8");
  return file;
}

/** 删 design/ 下单个文档（不存在静默）；角色卡删除等用 */
export async function removeDesign(projectId: string, name: string): Promise<void> {
  const safe = safeRelPath(name);
  if (!safe) return;
  const file = join(projectPaths(talemateHome(), projectId).design, safe);
  try {
    await rm(file);
  } catch {
    /* 不存在则忽略 */
  }
}

/** 递归列 design/ 下所有 .md 文档（返回相对路径，保序排序）；目录不存在 → [] */
export async function listDesigns(projectId: string): Promise<string[]> {
  const dir = projectPaths(talemateHome(), projectId).design;
  const out: string[] = [];
  await walkDir(dir, "", out);
  return out.sort();
}

async function walkDir(dir: string, prefix: string, acc: string[]): Promise<void> {
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true }).then((ds) =>
      ds.map((d) => ({ name: d.name, isDir: d.isDirectory() })),
    );
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDir) await walkDir(join(dir, e.name), rel, acc);
    else if (e.name.endsWith(".md")) acc.push(rel);
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

/** 列 chapters/ 下已有文件（正文/规划/其他），排序返回；目录不存在返回 []。 */
export async function listChapters(projectId: string): Promise<string[]> {
  const dir = projectPaths(talemateHome(), projectId).chapters;
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}
