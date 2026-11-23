/**
 * 角色卡：路径与名单助手。卡的内容不再有“必有格/骨架校验”——形状由 `design_guides.ts` 的指南
 * 引导，工具只负责“这张卡叫什么、名单里怎么占一行”。
 *
 * 一角色一卡 `design/characters/<名>.md`；建卡/整篇重写走 `propose-design`，改一处走 `edit`，
 * 删卡走 `delete`。当前状态与知识边界不在卡上（见 `docs/information-model.md`）。
 */
import { isFiller, isPendingLine } from "./markdown";

/** 角色卡所在目录（项目相对，带尾斜杠）。指南与摘要器都从这里取，不各抄一份。 */
export const CARD_DIR = "design/characters/";

/** 从卡的项目相对路径提取角色名；其它目录（含 `_index.md`）→ undefined。 */
export function nameFromPath(rel: string): string | undefined {
  if (!rel.startsWith(CARD_DIR) || !rel.endsWith(".md")) return undefined;
  const base = rel.slice(CARD_DIR.length, -".md".length);
  return base && base !== "_index" ? base : undefined;
}

const KEYED_LINE = /^([^:：]{1,12})[:：]\s*(.*)$/;

/**
 * 名单里的那一句：第一个有内容的非标题行；若是「键：值」，取值。
 * 跳过与卡名相同的值（旧卡的「姓名：林晚」）——名单前已经有名字，不必重复。
 * 这只是展示启发，不是必填字段。
 */
export function cardIdentity(content: string, name?: string): string | undefined {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || isFiller(line) || isPendingLine(line)) continue;
    const m = line.match(KEYED_LINE);
    const value = (m ? m[2] : line).trim();
    if (!value || isPendingLine(value)) continue;
    if (name !== undefined && value === name) continue;
    return value.length > 60 ? `${value.slice(0, 60)}…` : value;
  }
  return undefined;
}

/**
 * 角色卡在名单里的那一行：`- 名 · 一句身份`。没有可读的首句 →「（待定）」。
 * 不显示“必有齐/待补”，也不列自由小节——卡没有必填格。
 */
export function characterLine(content: string, name: string): string {
  return cardIdentity(content, name) ?? "（待定）";
}
