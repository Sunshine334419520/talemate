/**
 * 派生锚点 + 设计段判定 + 文档索引。
 *
 * 锚点设计（06 §3.1 / 6.x）：框架"精髓常驻"但全文不常驻——
 * 组装上下文时**现读** core.md（小、最稳、一切依赖它）作为常驻块 + 写作进度 + 文档索引，
 * 而不是维护一个缓存文件（永不陈旧，天然替代"写后刷新锚点"钩子）。
 */
import { readDoc, listDocs, listChapters, loadProjectMeta } from "../storage/project";
import { listHeadings } from "./markdown";
import { DOC_KINDS } from "./dockind";

/** 每个文档的一级小节 + 是否仍带"待定"占位（用于列表一眼看出填充度）。 */
export async function buildDocIndex(projectId: string): Promise<string> {
  const docs = await listDocs(projectId);
  const lines: string[] = ["docs/"];
  for (const f of docs) {
    const content = await readDoc(projectId, f);
    if (content === undefined) {
      lines.push(`  ${f}（缺）`);
      continue;
    }
    const heads = listHeadings(content, 2);
    if (!heads.length) {
      lines.push(`  ${f}（空/无小节）`);
      continue;
    }
    lines.push(`  ${f}:`);
    for (const h of heads) lines.push(`    - ${h.title}`);
  }
  if (!docs.length) lines.push("  （空）");
  return lines.join("\n");
}

/** 写作进度：chapters/ 下的 plan_/chapter_ 文件名（有则列出，无则提示）。 */
export async function buildProgress(projectId: string): Promise<string> {
  const names = await listChapters(projectId);
  if (!names.length) return "（尚无正文/规划落盘）";
  const plans = names.filter((n) => n.startsWith("plan_"));
  const chapters = names.filter((n) => n.startsWith("chapter_"));
  const lines: string[] = [];
  if (chapters.length) lines.push(`已落章 ${chapters.length} 篇：${chapters.slice(-3).join("、")}${chapters.length > 3 ? " …" : ""}`);
  if (plans.length) lines.push(`已有规划：${plans.join("、")}`);
  if (!lines.length) lines.push(`chapters/：${names.join("、")}`);
  return lines.join("\n");
}

/** 组装 <nvl-state> 常驻块。core.md 全文 + 进度 + 索引；core 缺失则给占位。 */
export async function buildAnchor(projectId: string): Promise<string> {
  const meta = await loadProjectMeta(projectId).catch(() => undefined);
  const core = (await readDoc(projectId, "core.md")) ?? "（core.md 尚未建立）";
  const progress = await buildProgress(projectId);
  const index = await buildDocIndex(projectId);
  const genre = meta?.genre ? `｜${meta.genre}` : "";
  return [
    "<nvl-state>",
    `作品：${meta?.title ?? projectId}${genre}`,
    "",
    "── 核心层 docs/core.md（最高优先依据，全文常驻；其余层按需 read-doc/search-docs）──",
    core,
    "",
    "── 写作进度 ──",
    progress,
    "",
    "── 文档索引 ──",
    index,
    "</nvl-state>",
  ].join("\n");
}

/** 设计段判定：outline.md 还是空骨架/仅占位 → 认为处于"框架设计"阶段（editor 注入设计协议）。 */
export async function designActive(projectId: string): Promise<boolean> {
  const outline = await readDoc(projectId, "outline.md");
  if (outline === undefined) return true;
  return isOnlySkeleton(outline);
}

/** 极简骨架判定：去掉 heading / 注释 / 待定占位 / 引用引导后没剩内容。 */
function isOnlySkeleton(content: string): boolean {
  const meaningful = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#") && !l.startsWith("<!--") && !l.startsWith("-->") && !l.startsWith(">"))
    .join(" ")
    .replace(/（待定[^）]*）/g, "")
    .trim();
  return meaningful.length === 0;
}

export { DOC_KINDS };
