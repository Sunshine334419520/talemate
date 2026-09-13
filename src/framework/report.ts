/**
 * 项目四层"现状报告"：进入空间时的状态卡片，与 `/status` 复用。
 * 真值 = design/ 文件（有没有、填没填都读出来）。
 * 卡片只出现层名与格名——文件名/路径属内部维护，不进用户视野。
 */
import { listDesigns, loadProjectMeta, readDesign } from "../storage/project";
import type { LayerId } from "./layers";
import { DESIGN_SPECS } from "./design_spec";
import { getSection } from "./markdown";
import { nameFromPath } from "./characters";

/** 空行 / 说明行 / （待定…）占位 —— 都不算"填了"。（导出：proposal.ts 判"这格还没填"复用同一份） */
export function isFiller(line: string): boolean {
  const t = line.trim();
  return !t || t.startsWith("### ") || t.startsWith(">") || t.startsWith("<!--") || /^（待定.*）$/.test(t);
}

/** 取一个小节正文的第一句有效内容（跳过占位与空行），用于"简要输出"。 */
function firstLine(content: string | undefined, heading: string): string | undefined {
  if (content === undefined) return undefined;
  const s = getSection(content, heading);
  if (!s.found) return undefined;
  const line = (s.body ?? "").split("\n").find((l) => !isFiller(l))?.trim();
  return line ? (line.length > 60 ? `${line.slice(0, 60)}…` : line) : undefined;
}

/** 该小节填了没（小节存在 + 有非占位正文）。 */
function sectionFilled(content: string | undefined, heading: string): boolean {
  if (content === undefined) return false;
  const s = getSection(content, heading);
  if (!s.found) return false;
  return (s.body ?? "").split("\n").some((l) => !isFiller(l));
}

/** 该层还差哪几个格（按 design-spec 的小节顺序；文档不存在 → 全部算缺）。 */
function missingSections(content: string | undefined, id: LayerId): string[] {
  return DESIGN_SPECS[id].sections.filter((s) => !sectionFilled(content, s.heading)).map((s) => s.heading);
}

/** 状态行右侧：文档不存在 →（空）；有内容 → ✓ 首句；存在但没写出首句 → fallback。 */
function layerBrief(exists: boolean, lead: string | undefined, fallback: string): string {
  if (!exists) return "（空）";
  return lead ? `✓ ${lead}` : fallback;
}

/** 引导语：只覆盖 core 与 world，只指向第一个还不齐的层；两层都齐 → 不引导。 */
function buildGuidance(core: string | undefined, world: string | undefined): string | undefined {
  if (core === undefined && world === undefined) {
    return "想写个什么样的故事？直接讲给我听，我们边聊边把这些记下来。";
  }
  const layers: { label: string; missing: string[] }[] = [
    { label: "核心设定", missing: missingSections(core, "core") },
    { label: "世界观", missing: missingSections(world, "world") },
  ];
  const first = layers.find((l) => l.missing.length);
  if (!first) return undefined;
  return `${first.label}还差${first.missing.map((h) => `「${h}」`).join("、")}——现在聊聊，还是先记着？`;
}

/** 生成四层现状文本（给 CLI 进入空间 / 或会话内 /status 复用）。 */
export async function buildProjectStatus(projectId: string): Promise<string> {
  const meta = await loadProjectMeta(projectId).catch(() => undefined);
  const [core, world, outline, designPaths] = await Promise.all([
    readDesign(projectId, "core.md"),
    readDesign(projectId, "wiki/world.md"),
    readDesign(projectId, "outline/outline.md"),
    listDesigns(projectId),
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
  lines.push(`◇ 大纲现状  ${layerBrief(outline !== undefined, firstLine(outline, "一句话主线"), "（已有一版）")}`);

  const guidance = buildGuidance(core, world);
  if (guidance) {
    lines.push("");
    lines.push(guidance);
  }
  return lines.join("\n");
}
