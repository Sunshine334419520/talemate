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
import { docAbs } from "./corpus";
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
  // - design/ 懒建——用户要完善某层时由 mate 调 design-spec 拿形状再成稿落盘；
  // - AGENTS.md 是**用户自己的**项目规矩（等同 CLAUDE.md：项目级、用户管理、默认可空）。
  //   系统只提供"每轮注入该文件"的能力（readProjectRules → context/assemble）：文件不存在 →
  //   readProjectRules 返回 "" → assemble 整块跳过，什么都不注入。用户建了才加载。
  //   mate 的写接口被限定在 design/ 下（safeRelPath 挡 ".."），结构上碰不到它。
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

// ── 文档语料的读写在 `storage/corpus.ts`（`readDoc` / `enumerateDocs` / `scanDocs`）──
// 这里曾经还挂着 design/ 相对的 `readDesign` / `listDesigns` / `listChapters` 三个适配器，
// 外加"读回一份文档"的第二条实现。路径口径统一成项目相对之后它们全没了：项目相对才是唯一的
// 口径，所以调用方直接用 corpus，不需要任何一层转前缀的中间人。

/**
 * 按**项目相对路径**写/覆盖一份文档；返回完整路径。
 *
 * **生产里没有调用方**——改文件只能走 `framework/write_ops.ts` 那条唯一路径（类型上 `ToolContext`
 * 只有一个写口）。留在这里是因为**测试要播种字节**：造夹具得能绕过权限弹窗与 CAS 直接把文件放好，
 * 否则每个用例都要先演一遍完整落盘流程。别在 `src/` 里用它。
 *
 * 它只挑得出 `design/` 与 `chapters/` 两个根之下的路径——与 `corpus.DOC_ROOTS`、`write_ops.WRITE_ROOTS`
 * 同一套，绝对路径也由 `corpus.docAbs` 一处算（夹具与读口不会各走各的）。
 */
export async function writeDoc(projectId: string, path: string, content: string): Promise<string> {
  const abs = docAbs(projectId, path);
  if (abs === undefined) throw new Error(`非法文档路径：${path}`);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
  return abs;
}

/** 删一份文档（不存在静默）。同 `writeDoc`：**仅测试夹具用**，删除走通用 `delete`。 */
export async function removeDoc(projectId: string, path: string): Promise<void> {
  const abs = docAbs(projectId, path);
  if (abs === undefined) return;
  try {
    await rm(abs);
  } catch {
    /* 不存在则忽略 */
  }
}
