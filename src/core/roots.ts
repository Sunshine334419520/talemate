/**
 * 语料根注册表：一本书里哪些目录算"文档语料"，以及每个根能读、能写、能搜。
 *
 * 这张表是**项目级**的：默认值由建书时写进 `talemate.json` 的 `corpusRoots`，用户可以加一个根
 * （如 `notes/`）、把某个根设为只读、或不让它进搜索。读口（`corpus.enumerateDocs`）、写口
 * （`write_ops`）、搜索与将来的 UI 都从同一份表取数——**工具层永远不认识根的名字**。
 *
 * 三个不变式：
 *   1. `write` 蕴含 `read`（写之前必须读得到，否则 CAS 无从谈起）；
 *   2. 至少有一个 `read` 根，否则这本书什么也读不到；
 *   3. `dir` 是项目相对目录，不许绝对路径、不许 `..`、不许空段。
 *
 * 边界：只做数据与校验，不碰磁盘、不拼绝对路径（那在 `core/config.ts` 的 `corpusRootAbs`）。
 */

export interface CorpusRoot {
  /** 稳定 id，用来拼权限 pattern 与给人看；不要与 `dir` 混用（dir 可以带斜杠，id 不行） */
  id: string;
  /** 项目相对目录，如 `design` / `chapters` / `notes`；不带首尾斜杠 */
  dir: string;
  read: boolean;
  write: boolean;
  search: boolean;
  /** 左栏/状态卡的分组名；不填 = 不主动显示（仍可被 glob 找到） */
  section?: string;
}

/** 建书时种下的默认根。顺序即 UI 的分组顺序。 */
export const DEFAULT_CORPUS_ROOTS: readonly CorpusRoot[] = [
  { id: "design", dir: "design", read: true, write: true, search: true, section: "设计" },
  { id: "chapters", dir: "chapters", read: true, write: true, search: true, section: "正文" },
  { id: "state", dir: "state", read: true, write: true, search: true, section: "现状" },
];

const ID_RE = /^[a-z][a-z0-9-]*$/;

/** 项目相对目录：每段非空、不是 `.`/`..`、不是绝对路径。允许点开头（如 `.talemate/plans`）。 */
export function safeCorpusDir(dir: string): string | undefined {
  const clean = dir.replace(/\\/g, "/").trim();
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) return undefined;
  const segs = clean.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") return undefined;
  }
  return segs.join("/");
}

/**
 * 把项目元数据里的 `corpusRoots` 规整成可用的表。
 *
 * 坏条目被丢掉而不是让整本书读不出来；一个合法条目都没有 → 回默认三根（老项目没有这个字段
 * 时也走这里）。`write` 而没有 `read` 的条目会被补上 `read`——它表达的是"能写"，而写一定要能读。
 */
export function normalizeCorpusRoots(input: unknown): CorpusRoot[] {
  if (!Array.isArray(input)) return [...DEFAULT_CORPUS_ROOTS];
  const out: CorpusRoot[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const dir = typeof raw.dir === "string" ? safeCorpusDir(raw.dir) : undefined;
    if (!ID_RE.test(id) || dir === undefined) continue;
    if (out.some((r) => r.id === id || r.dir === dir)) continue;
    const read = raw.read === undefined ? true : raw.read === true;
    const write = raw.write === true;
    const search = raw.search === undefined ? true : raw.search === true;
    if (!read && !write && !search) continue;
    const section = typeof raw.section === "string" && raw.section.trim() !== "" ? raw.section : undefined;
    out.push({ id, dir, read: read || write, write, search, ...(section === undefined ? {} : { section }) });
  }
  if (!out.some((r) => r.read)) return [...DEFAULT_CORPUS_ROOTS];
  return out;
}

/** 可读的根（写也一定可读）。 */
export function readableCorpusRoots(roots: readonly CorpusRoot[]): CorpusRoot[] {
  return roots.filter((r) => r.read);
}

/** 可写的根：`write_ops` 的边界。 */
export function writableCorpusRoots(roots: readonly CorpusRoot[]): CorpusRoot[] {
  return roots.filter((r) => r.write);
}

/** 可搜索的根：`glob` / `grep` 的候选集。 */
export function searchableCorpusRoots(roots: readonly CorpusRoot[]): CorpusRoot[] {
  return roots.filter((r) => r.search && r.read);
}