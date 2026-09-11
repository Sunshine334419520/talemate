/**
 * 项目四层"现状报告"（进入空间时给用户看的状态卡片）。
 *
 * 设计（2026-09-06）：只展示现状 + 提示"想完善就说什么"，不自动驱动——
 * 具体干什么由用户决定，editor 在用户点名后才用工具去动那一层。
 * 真值 = design/ 文件（有没有、填没填都读出来）。
 *
 * 设计（2026-09-11）：层名照常展示（世界观/大纲/角色本就是作者懂的创作概念），改的是**引导语**：
 * - 全空 → 引向"讲想法"，不谈层；
 * - core/world 有缺格 → 只指向**第一个**不齐的层（排在后面的角色/大纲因此天然不会被指向），并列出缺的格名；
 * - 都齐 → 不引导。
 * 文件名/路径属内部维护，一律不出现在卡片上（卡片只出现层名与格名）。
 */
import { listDesigns, loadProjectMeta, readDesign } from "../storage/project";
import type { LayerId } from "./layers";
import { DESIGN_SPECS } from "./design_spec";
import { getSection } from "./markdown";
import { nameFromPath } from "./characters";

/** 空行 / 说明行 / （待定…）占位 —— 都不算"填了"。 */
function isFiller(line: string): boolean {
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

/**
 * 引导语：只指向第一个还不齐的层（core → world）。
 * 角色/大纲排在后面，因此天然不会被指向——它们该随写作进程自然生长，不催。
 * 两层都齐 → 返回 undefined（卡片只剩状态）。
 */
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
