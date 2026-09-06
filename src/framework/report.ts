/**
 * 项目四层"现状报告"（进入空间时给用户看的状态卡片）。
 *
 * 设计（2026-09-06）：只展示现状 + 提示"想完善就说什么"，不自动驱动——
 * 具体干什么由用户决定，editor 在用户点名后才用工具去动那一层。
 * 真值 = docs/ 文件（有没有、填没填都读出来）。
 */
import { loadProjectMeta, readDoc } from "../storage/project";
import { getSection } from "./markdown";
import { listCardNames } from "./characters";

/** 取一个小节正文的第一句有效内容（去掉（待定…）占位与空行），用于"简要输出"。 */
function firstLine(content: string | undefined, heading: string): string | undefined {
  if (content === undefined) return undefined;
  const s = getSection(content, heading);
  if (!s.found) return undefined;
  const line = (s.body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("### ") && !l.startsWith(">") && !l.startsWith("<!--") && !/^（待定.*）$/.test(l));
  return line ? (line.length > 60 ? `${line.slice(0, 60)}…` : line) : undefined;
}

function briefOf(v: string | undefined, emptyNote: string): string {
  return v ? v : emptyNote;
}

/** 生成四层现状文本（给 CLI 进入空间 / 或会话内 /status 复用）。 */
export async function buildProjectStatus(projectId: string): Promise<string> {
  const meta = await loadProjectMeta(projectId).catch(() => undefined);
  const [core, world, characters, outline] = await Promise.all([
    readDoc(projectId, "core.md"),
    readDoc(projectId, "world.md"),
    readDoc(projectId, "characters.md"),
    readDoc(projectId, "outline.md"),
  ]);

  const intro = firstLine(core, "一句话简介");
  const stage = firstLine(world, "空间与舞台");
  const mainLine = firstLine(outline, "一句话主线");

  const cardNames = characters ? listCardNames(characters) : [];
  const charBrief = cardNames.length
    ? `${cardNames.length} 位：${cardNames.slice(0, 6).join("、")}${cardNames.length > 6 ? "…" : ""}`
    : "还没有角色";

  const lines: string[] = [];
  lines.push(`作品：${meta?.title ?? projectId}${meta?.genre ? `（${meta.genre}）` : ""}`);
  lines.push("");
  lines.push(`◇ 核心设定  ${core === undefined ? "（尚无 docs/core.md）" : `✓ ${briefOf(intro, "已有 core.md，核心格待完善")}`}`);
  lines.push(`◇ 世界观    ${world === undefined ? "（尚无 docs/world.md）" : `✓ ${briefOf(stage, "已有 world.md，世界格待完善")}`}`);
  lines.push(`◇ 角色现状  ${charBrief}`);
  lines.push(`◇ 大纲现状  ${mainLine ? `✓ ${mainLine}` : "无大纲"}`);
  lines.push("");
  lines.push("想完善哪个，直接说，例如：『完善核心设定』『加个角色：林晚』『把世界观铺开』『给第 1 章排大纲』。");
  return lines.join("\n");
}
