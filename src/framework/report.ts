/**
 * 项目四层"现状报告"：进入空间时的状态卡片，与 `/status` 复用。
 * 真值 = design/ 文件（有没有、填没填都读出来）。
 * 卡片只出现层名与格名——文件名/路径属内部维护，不进用户视野。
 */
import { loadProjectMeta } from "../storage/project";
import { enumerateDocs, readDoc } from "../storage/corpus";
import { specFor } from "./design_spec";
import { getSection, isFiller, leadLine } from "./markdown";
import { nameFromPath } from "./characters";

/** 状态卡上这两格各读哪份文档——**路径就是判据**，不再经过层 id。路径是项目相对口径。 */
const CORE_DOC = "design/core.md";
const WORLD_DOC = "design/wiki/world.md";

// isFiller 已挪到 markdown.ts（characters 也要用，而本文件 → characters 已有依赖）。
// 这里 re-export 保住原有调用点（proposal.ts 从本文件引它）。
export { isFiller };

/** 取一个小节正文的第一句有效内容（跳过占位与空行），用于"简要输出"。 */
function firstLine(content: string | undefined, heading: string): string | undefined {
  return content === undefined ? undefined : leadLine(content, heading);
}

/** 该小节填了没（小节存在 + 有非占位正文）。 */
function sectionFilled(content: string | undefined, heading: string): boolean {
  if (content === undefined) return false;
  const s = getSection(content, heading);
  if (!s.found) return false;
  return (s.body ?? "").split("\n").some((l) => !isFiller(l));
}

/** 这份文档还差哪几个格（按规范的节顺序；文档不存在 → 全部算缺）。 */
function missingSections(content: string | undefined, name: string): string[] {
  const sections = specFor(name)?.sections ?? [];
  return sections.filter((s) => !sectionFilled(content, s.heading)).map((s) => s.heading);
}

/** 状态行右侧：文档不存在 →（空）；有内容 → ✓ 首句；存在但没写出首句 → fallback。 */
function layerBrief(exists: boolean, lead: string | undefined, fallback: string): string {
  if (!exists) return "（空）";
  return lead ? `✓ ${lead}` : fallback;
}

/** 引导语：只覆盖 core 与 world，只指向第一个还不齐的那一格所属的层；两层都齐 → 不引导。 */
function buildGuidance(core: string | undefined, world: string | undefined): string | undefined {
  if (core === undefined && world === undefined) {
    return "想写个什么样的故事？直接讲给我听，我们边聊边把这些记下来。";
  }
  const layers: { label: string; missing: string[] }[] = [
    { label: "核心设定", missing: missingSections(core, CORE_DOC) },
    { label: "世界观", missing: missingSections(world, WORLD_DOC) },
  ];
  const first = layers.find((l) => l.missing.length);
  if (!first) return undefined;
  return `${first.label}还差${first.missing.map((h) => `「${h}」`).join("、")}——现在聊聊，还是先记着？`;
}

/** 卷号：`design/outline/vol_<N>.md` → N；不是卷纲就 undefined。 */
function volumeNumber(rel: string): number | undefined {
  const m = rel.match(/^design\/outline\/vol_(\d+)\.md$/);
  return m ? Number(m[1]) : undefined;
}

/**
 * 大纲现状：**现算**。情节层没有"整本大纲"这个文档（见 `docs/outline.md`），能报的是走到哪一卷——
 * 卷号从已有的文件列表里挑，再读最新那卷的「本卷在全局的位置」首句。
 * 卡片仍只出现层名与格名，不出现路径。
 */
async function outlineBrief(projectId: string, designPaths: string[]): Promise<string> {
  const volumes = designPaths
    .map(volumeNumber)
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  const latest = volumes[volumes.length - 1];
  if (latest === undefined) return "（空）";
  const seqs = designPaths.filter((p) => p.startsWith(`design/outline/vol_${latest}/`)).length;
  const doc = await readDoc(projectId, `design/outline/vol_${latest}.md`);
  const lead = firstLine(doc, "本卷在全局的位置");
  return `✓ 第 ${latest} 卷 / 共 ${volumes.length} 卷${seqs ? ` · ${seqs} 个序列` : ""}：${lead ?? "（已有一版）"}`;
}

/** 生成四层现状文本（给 CLI 进入空间 / 或会话内 /status 复用）。 */
export async function buildProjectStatus(projectId: string): Promise<string> {
  const meta = await loadProjectMeta(projectId).catch(() => undefined);
  const [core, world, designPaths] = await Promise.all([
    readDoc(projectId, CORE_DOC),
    readDoc(projectId, WORLD_DOC),
    enumerateDocs(projectId, "design/"),
  ]);

  const cardNames = designPaths.map((rel) => nameFromPath(rel)).filter((n): n is string => !!n);
  const charBrief = cardNames.length
    ? `${cardNames.length} 位：${cardNames.slice(0, 6).join("、")}${cardNames.length > 6 ? "…" : ""}`
    : "（空）";

  const lines: string[] = [];
  lines.push(`作品：${meta?.title ?? projectId}${meta?.genre ? `（${meta.genre}）` : ""}`);
  lines.push("");
  lines.push(`◇ 核心设定  ${layerBrief(core !== undefined, firstLine(core, "一句话简介"), "（已有一版）")}`);
  lines.push(`◇ 世界观    ${layerBrief(world !== undefined, firstLine(world, "空间与舞台"), "（已有一版）")}`);
  lines.push(`◇ 角色现状  ${charBrief}`);
  lines.push(`◇ 大纲现状  ${await outlineBrief(projectId, designPaths)}`);

  const guidance = buildGuidance(core, world);
  if (guidance) {
    lines.push("");
    lines.push(guidance);
  }
  return lines.join("\n");
}
