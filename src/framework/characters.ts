/**
 * 角色卡 schema 与读写助手（framework 领域层）。
 *
 * 角色"规范"住在这里（结构化数据 + 解析/重建），character-tools 共用：
 * - 卡 = `## 角色：<名字>`，卡内按固定 5 个 `###` 小节（缺的写（待定）也要在场）。
 * - 与"文件是真相"一致：读取/重建都以 characters.md 当前内容为准，schema 只负责"怎么算一张合规的卡"。
 */
import { appendBlock, getSection, listHeadings, removeSection, replaceSection } from "./markdown";

export type CharacterFieldKey = "one_line" | "want_fear" | "idiolect" | "habit" | "function";

export interface CharacterFields {
  one_line?: string; // 一句话定位
  want_fear?: string; // 想要 · 最怕
  idiolect?: string; // 说话方式（含口头禅/声音范例）
  habit?: string; // 习惯动作
  function?: string; // 在故事中的功能
}

/** 卡片小节的规范顺序与中文标题（缺字段的占位文案）。 */
export const CHARACTER_FIELDS: { key: CharacterFieldKey; label: string; placeholder: string }[] = [
  { key: "one_line", label: "一句话定位", placeholder: "（待定：ta 在故事里是干什么的）" },
  { key: "want_fear", label: "想要 · 最怕", placeholder: "（待定：欲望与恐惧，驱动行为的钩子）" },
  { key: "idiolect", label: "说话方式", placeholder: "（待定：口头禅/拐不拐弯；给一句『声音范例』原文，别只写性格形容词）" },
  { key: "habit", label: "习惯动作", placeholder: "（待定：小动作 / 小癖好）" },
  { key: "function", label: "在故事中的功能", placeholder: "（待定：对主线的作用；与主角的关系）" },
];

const CARD_PREFIX = "角色：";

/** characters.md 尚不存在时，工具自建的初始骨架（懒建）。 */
export function charactersDocSkeleton(): string {
  return [
    "# characters · 人物层（角色总表 + 角色卡）",
    "",
    "> 每位角色一块 `## 角色：〈名字〉`；总表只放一句话定位，细节进卡。",
    "",
    "## 角色总表",
    "（待定）",
    "",
  ].join("\n");
}

export function cardTitle(name: string): string {
  return `${CARD_PREFIX}${name}`;
}

export function isCardHeading(title: string): boolean {
  return title.startsWith(CARD_PREFIX);
}

function labelOf(key: CharacterFieldKey): string {
  return CHARACTER_FIELDS.find((f) => f.key === key)!.label;
}

function keyOfLabel(label: string): CharacterFieldKey | undefined {
  return CHARACTER_FIELDS.find((f) => f.label === label)?.key;
}

/** 列出 characters.md 里所有角色卡名字（`## 角色：X`）。 */
export function listCardNames(content: string): string[] {
  return listHeadings(content, 2)
    .map((h) => h.title.trim())
    .filter(isCardHeading)
    .map((t) => t.slice(CARD_PREFIX.length).trim());
}

/** 解析一张卡的 5 个小节。卡不存在 → found:false。 */
export function parseCard(content: string, name: string): { found: boolean; fields: CharacterFields } {
  const s = getSection(content, cardTitle(name));
  if (!s.found || s.body === undefined) return { found: false, fields: {} };
  const fields: CharacterFields = {};
  const lines = s.body.split("\n");
  let cur: CharacterFieldKey | undefined;
  const acc: Record<string, string[]> = {};
  for (const line of lines) {
    const m = line.match(/^###\s+(.*)$/);
    if (m) {
      const k = keyOfLabel(m[1].trim());
      cur = k;
      if (k) acc[k] = [];
      continue;
    }
    if (cur) acc[cur].push(line);
  }
  for (const f of CHARACTER_FIELDS) {
    const parts = (acc[f.key] ?? []).map((l) => l.trim());
    fields[f.key] = parts.filter(Boolean).join("\n");
  }
  return { found: true, fields };
}

function cleanPlaceholder(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  if (!t) return undefined;
  if (/^（待定.*）$/.test(t)) return undefined;
  return t;
}

/** 生成卡片正文（不含 `## 角色：` 标题行）。缺失字段也保留小节 + （待定），保证卡完整。 */
export function buildCardBody(name: string, fields: CharacterFields): string {
  const blocks: string[] = [];
  for (const f of CHARACTER_FIELDS) {
    const v = cleanPlaceholder(fields[f.key]);
    blocks.push(`### ${f.label}\n${v ?? f.placeholder}`);
  }
  return blocks.join("\n\n");
}

/** 生成整卡 markdown（含 `## 角色：name`），供 add-character 追加。 */
export function buildCardMarkdown(name: string, fields: CharacterFields): string {
  return `## ${cardTitle(name)}\n\n${buildCardBody(name, fields)}`;
}

/** 把卡（含更新后的卡）写回 characters.md：add → append；已存在 → replace 该节。返回新全文。 */
export function upsertCard(content: string, name: string, fields: CharacterFields): { content: string; added: boolean } {
  const exists = getSection(content, cardTitle(name)).found;
  const next = exists
    ? replaceSection(content, cardTitle(name), buildCardBody(name, fields))
    : appendBlock(content, buildCardMarkdown(name, fields));
  return { content: syncTotalTable(next), added: !exists };
}

/** 按当前卡片推导并重建 `## 角色总表`（每行 `- 名字 · 一句话定位`），保证总表不漂移。 */
export function syncTotalTable(content: string): string {
  const names = listCardNames(content);
  const bullets = names.map((n) => {
    const p = parseCard(content, n);
    const one = cleanPlaceholder(p.fields.one_line);
    return `- ${n} · ${one ?? "（待定）"}`;
  });
  const body = bullets.length ? bullets.join("\n") : "（待定：还没有角色卡）";
  const table = getSection(content, "角色总表");
  if (!table.found) return appendBlock(content, `## 角色总表\n\n${body}`);
  return replaceSection(content, "角色总表", body);
}

/** 删除一张卡并重建总表。找不到 → 抛错。 */
export function removeCard(content: string, name: string): string {
  if (!getSection(content, cardTitle(name)).found) {
    throw new Error(`没有找到角色卡「${name}」。已有：${listCardNames(content).join("、") || "（无）"}`);
  }
  return syncTotalTable(removeSection(content, cardTitle(name)));
}
