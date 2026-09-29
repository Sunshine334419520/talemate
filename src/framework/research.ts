/**
 * 考据本：**题目规则、匹配与全部文案**。不碰文件系统——IO 在 `storage/notes.ts`（分层守卫）。
 *
 * ## 它要解决什么
 *
 * `researcher` 查回来的东西本来活不过一次压缩：它是 tool 结果，而 `compaction` 只留 assistant 的
 * `text` part，于是同一个问题换个会话就得重查一遍。这本账把结论留下来，让下一次**先翻本地、再上网**。
 *
 * ## 三条判据，写在这里免得下次被"顺手改好"
 *
 * 1. **命中是线索，不是答案。** 每条命中都带着「查于」日期与出处，就是为了让研究员能判"这条还作不作数"。
 *    缓存压制重查是这个设计**明知**兑换出去的代价——它换的是一次白跑的上网（这个功能的全部意义）。
 * 2. **未命中回已有题目清单**，那是恢复回路不是错误：措辞对不上是常态，词法匹配桥不过同义词，
 *    也没有相似度阈值——那层判断归研究员，它读得到题目。
 * 3. **命中返回全文，不做 top-N**。库小是设计出来的（一条 = 一次"以后还会再问"的判断），
 *    而漏一条的代价是重查。真要给上限，得先有"库大到会撑爆上下文"的实测。
 */
import { MAX_NOTE_NAME, listNoteNames, noteAbs, readNote, safeNoteName, writeNote } from "../storage/notes";
import { readText } from "../storage/atomic";
import { findInContent } from "./markdown";

export interface Note {
  name: string;
  /** 查于（YYYY-MM-DD）；读不出就是空串——旧笔记或手写的都可能没有这一行 */
  date: string;
  body: string;
}

/**
 * 今天（本地时区）。**由工具盖章，不问模型**——模型不知道今天几号，而"这条查于何时"正是
 * 研究员判断要不要重查的唯一依据。用本地日期而不是 `toISOString()`：那是 UTC，跨一个时区就差一天。
 */
export function todayISO(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 笔记的落盘形状。第 2 行的日期是刻意的：每次 `recall` 命中都得看得见它。 */
export function renderNote(name: string, date: string, body: string): string {
  return `# ${name}\n查于 ${date}\n\n${body.trim()}\n`;
}

/** 从笔记原文里读回题目与日期——覆盖时要点名"原查于 X"，靠的就是这一行。 */
export function parseNote(name: string, raw: string): Note {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith("查于"));
  const date = at >= 0 ? lines[at].trimStart().slice("查于".length).trim() : "";
  const body = lines
    .filter((_, i) => i !== 0 && i !== at)
    .join("\n")
    .trim();
  return { name, date, body };
}

/**
 * 关键词命中：题目与正文一起过一遍，用的是 `search` 那一套（`markdown.findInContent`）。
 * 判据是"这一行里有没有这个词"——**词法匹配，不是语义匹配**，同义词桥不过去，这是明说的代价。
 */
export function matchNotes(notes: Note[], query: string): Note[] {
  const q = query.trim();
  if (!q) return notes;
  return notes.filter((n) => findInContent(`${n.name}\n${n.body}`, q).length > 0);
}

// ─── 文案 ───

/** 命中：每条原样交出去（含题目与日期），研究员据此判断它还作不作数。 */
export function hitText(hits: Note[]): string {
  const blocks = hits.map((h) => renderNote(h.name, h.date || "（无日期）", h.body).trim());
  return `命中 ${hits.length} 条研究笔记：\n\n${blocks.join("\n\n")}`;
}

/** 要目录（没带 query）。 */
export function indexText(names: string[]): string {
  return `研究笔记（${names.length} 条）：\n${names.join("\n")}\n\n用 recall 带上 query 取某一条的正文。`;
}

/**
 * 未命中。**这是恢复回路**：把已有的题目列出来，研究员看着清单换个词再试。
 * 空库时换一句——建库的第一步不该读起来像失败。
 */
export function missText(query: string, names: string[]): string {
  if (!names.length) {
    return `没有找到研究笔记「${query}」。这里还一条都没有——查到「以后还会再问」的结论后，用 remember 记一条。`;
  }
  return `没有找到研究笔记「${query}」。已有：\n${names.join("\n")}`;
}

/** 空库 + 没带 query。 */
export function emptyIndexText(): string {
  return "研究笔记还是一条都没有。查到「以后还会再问」的结论时，用 remember 记一条。";
}

/** 没带出处的自愈文案——结论一进缓存，正文里就再也看不到它从哪来了。 */
export function sourceProblem(): string {
  return "这条笔记没有出处——把来源 URL 一并写进 content 再调一次。（结论一进缓存，正文里就再也看不到它从哪来的。）";
}

/**
 * 题目合法 → 归一后的题目；不合法 → 一句能让模型自己改的话。**两者互斥**，调用方不必再判。
 *
 * 三条失败分开报，因为它们要的修法不一样：带了分隔符（多半想写成路径）、太长、字符不合法。
 * 判据在 `storage/notes.safeNoteName`，这里只负责把"为什么不行"说清楚。
 */
export function noteName(raw: string): { name: string } | { problem: string } {
  const name = safeNoteName(raw ?? "");
  if (name) return { name };
  const shown = JSON.stringify(raw ?? null).slice(0, 200);
  if (/[\\/]/.test(raw ?? "")) {
    return { problem: `题目里不能有「/」（收到：${shown}）——它是一句话，不是路径。去掉分隔符重新调用。` };
  }
  if ((raw ?? "").trim().replace(/\.md$/i, "").startsWith(".")) {
    return { problem: `题目不能以点开头（收到：${shown}）——请用一句话作题目重新调用。` };
  }
  if ((raw ?? "").trim().replace(/\.md$/i, "").length > MAX_NOTE_NAME) {
    return { problem: `这个题目太长（上限 ${MAX_NOTE_NAME} 字）——请缩成一句话重新调用。` };
  }
  return {
    problem: `这个题目里有不能用作文件名的字符（收到：${shown}）——只能用中英文、数字、下划线、点和短横，别带空格和标点。换一个题目重新调用。`,
  };
}

/** 正文里至少一个 URL。研究员的契约就是"每条结论都带出处"，而缓存是结论唯一进入正文的路径。 */
export function hasSource(content: string): boolean {
  return /https?:\/\//i.test(content);
}

// ─── 带 IO 的三步（工具直接调用） ───

/**
 * 读全本。**它是 recall 的唯一数据源**：目录、命中、未命中清单都从这一份出，
 * 所以"列得出来却读不回来"这种不一致从结构上不存在。
 */
export async function loadNotes(projectId: string): Promise<Note[]> {
  const names = await listNoteNames(projectId);
  const out: Note[] = [];
  for (const name of names) {
    const raw = await readNote(projectId, name);
    if (raw !== undefined) out.push(parseNote(name, raw));
  }
  return out;
}

/** `recall` 的全部产出：带 query 走命中（未命中回清单），不带 query 要目录。 */
export async function recallText(projectId: string, query?: string): Promise<string> {
  const q = (query ?? "").trim();
  const notes = await loadNotes(projectId);
  if (!q) return notes.length ? indexText(notes.map((n) => n.name)) : emptyIndexText();
  const hits = matchNotes(notes, q);
  return hits.length ? hitText(hits) : missText(q, notes.map((n) => n.name));
}

/** 这个题目上已经有一条了吗？有就把日期带回来——覆盖时要说清换掉的是哪一版。 */
export async function existingNoteDate(projectId: string, name: string): Promise<string | undefined> {
  const raw = await readText(noteAbs(projectId, name));
  if (raw === undefined) return undefined;
  return parseNote(name, raw).date || "（无日期）";
}

/** 落一条笔记：盖章 + 写盘。同名覆盖是功能（重查后换掉旧结论），回来时告诉调用方换掉的是哪一版。 */
export async function saveNote(
  projectId: string,
  name: string,
  body: string,
  now: Date = new Date(),
): Promise<{ date: string; replaced?: string }> {
  const replaced = await existingNoteDate(projectId, name);
  const date = todayISO(now);
  await writeNote(projectId, name, renderNote(name, date, body));
  return { date, replaced };
}
