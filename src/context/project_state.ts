/**
 * 项目状态快照：折叠时从文件现取的 `<project>` / `<promises>` / 常驻 rev。
 *
 * 这些块是复制不是生成（D1）：位置、未回收承诺、常驻设定都在磁盘上，职责是给出坐标，
 * 而不是让摘要再写一份 canon。取不到就是没有，不猜、不补。
 *
 * 边界：只读 `storage/corpus.ts` 与 `framework/markdown.ts`；不写文件、不认识 Session。
 */
import type { CompactionRecord } from "../core/types";
import { hashText } from "../core/hash";
import { getSection, listHeadings } from "../framework/markdown";
import { RESIDENT_DOCS } from "../framework/anchor";
import { readDoc } from "../storage/corpus";

export interface PinnedSnapshot {
  project?: string;
  promises?: string;
  resident: Array<{ path: string; rev: string }>;
}

const PROGRESS_DOC = "state/progress.md";
const FORESHADOWING_DOC = "state/foreshadowing.md";

/** 常驻文件超预算时在 `list`/启动检查里提示；这里只取 rev，不重复正文。 */
function revOf(content: string): string {
  return hashText(content).slice(0, 6);
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`;
}

/** 最后 N 个小节（`progress.md` 是一章一节；取最近 7 章）。 */
export function lastSections(content: string, count: number): string | undefined {
  const heads = listHeadings(content, 2).filter((h) => h.level === 2);
  if (heads.length === 0) return content.trim() === "" ? undefined : clamp(content.trim(), 6000);
  const recent = heads.slice(-count);
  const start = recent[0].line;
  return clamp(content.slice(start).trim(), 6000);
}

/**
 * 未回收的承诺：去掉状态为"已回收 / 放弃"的小节。
 *
 * `foreshadowing.md` 是软约定、没有 schema，所以判据只能落在"这一节里有没有写这两类终态"上，
 * 拿不到状态就保留——漏一条未回收承诺比多带一条已了结的账更贵。
 */
export function openPromises(content: string): string | undefined {
  const heads = listHeadings(content, 2).filter((h) => h.level === 2);
  if (heads.length === 0) {
    return /已回收|放弃/.test(content) ? undefined : clamp(content.trim(), 4000);
  }
  const kept: string[] = [];
  for (const h of heads) {
    const block = getSection(content, h.title, 2);
    const body = block.body ?? "";
    if (/已回收|放弃/.test(body)) continue;
    kept.push(`${h.title}\n${body}`.trim());
  }
  if (kept.length === 0) return undefined;
  return clamp(kept.join("\n\n"), 4000);
}

/** 折叠时现取一份 pinned 快照。规划由调用方（Session）按当前 pending 另给。 */
export async function buildPinned(projectId: string): Promise<PinnedSnapshot> {
  const resident: PinnedSnapshot["resident"] = [];
  for (const path of RESIDENT_DOCS) {
    const content = await readDoc(projectId, path);
    if (content === undefined) continue;
    resident.push({ path, rev: revOf(content) });
  }

  const progress = await readDoc(projectId, PROGRESS_DOC);
  const project = progress === undefined ? undefined : lastSections(progress, 7);

  const foreshadowing = await readDoc(projectId, FORESHADOWING_DOC);
  const promises = foreshadowing === undefined ? undefined : openPromises(foreshadowing);

  return {
    ...(project === undefined ? {} : { project }),
    ...(promises === undefined ? {} : { promises }),
    resident,
  };
}

/** 记录里 pinned 块的渲染（`<context-state>` 与摘要输入共用一份形状）。 */
export function renderPinned(pinned: CompactionRecord["pinned"]): string {
  const out: string[] = [];
  if (pinned.project !== undefined) out.push(`<project>\n${pinned.project}\n</project>`);
  if (pinned.promises !== undefined) out.push(`<promises>\n${pinned.promises}\n</promises>`);
  if (pinned.plan !== undefined) {
    out.push(`<plan chapter="${pinned.plan.chapter}" path="${pinned.plan.path}" hash="${pinned.plan.hash}" />`);
  }
  if (pinned.resident.length) {
    out.push(
      `<resident>\n${pinned.resident.map((r) => `${r.path} @${r.rev}`).join("\n")}\n</resident>`,
    );
  }
  return out.join("\n");
}