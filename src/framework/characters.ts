/**
 * 角色卡 schema 与读写助手（framework 领域层）。
 *
 * 一角色一卡：每张卡是 design/characters/<名>.md 文件，`# 角色：<名>` 标题 + 固定 5 个 `###` 小节。
 * characters/_index.md 是派生总表（工具每次增删改后扫描 characters/ 重建）。
 * 与"文件是真相"一致：读取/重建都以其当前内容为准，schema 只负责"怎么算一张合规的卡"。
 */
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

/** 单卡文件的 design 相对路径。 */
export function cardPath(name: string): string {
  return `characters/${name}.md`;
}

/** 角色总表（派生文件）的 design 相对路径。 */
export const INDEX_PATH = "characters/_index.md";

/** 卡片文件标题（h1）。 */
export function cardTitle(name: string): string {
  return `${CARD_PREFIX}${name}`;
}

/** 从 characters/ 相对路径提取角色名；`_index.md` 与其它目录 → undefined。 */
export function nameFromPath(rel: string): string | undefined {
  if (!rel.startsWith("characters/") || !rel.endsWith(".md")) return undefined;
  const base = rel.slice("characters/".length, -".md".length);
  return base && base !== "_index" ? base : undefined;
}

function labelOf(key: CharacterFieldKey): string {
  return CHARACTER_FIELDS.find((f) => f.key === key)!.label;
}

function keyOfLabel(label: string): CharacterFieldKey | undefined {
  return CHARACTER_FIELDS.find((f) => f.label === label)?.key;
}

function cleanPlaceholder(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  if (!t) return undefined;
  if (/^（待定.*）$/.test(t)) return undefined;
  return t;
}

/** 生成卡片正文（不含 `# 角色：` 标题行）。缺失字段也保留小节 +（待定），保证卡完整。 */
export function buildCardBody(name: string, fields: CharacterFields): string {
  const blocks: string[] = [];
  for (const f of CHARACTER_FIELDS) {
    const v = cleanPlaceholder(fields[f.key]);
    blocks.push(`### ${f.label}\n${v ?? f.placeholder}`);
  }
  return blocks.join("\n\n");
}

/** 生成整卡 markdown（含 `# 角色：name` 标题），供 add-character 落盘。 */
export function buildCardMarkdown(name: string, fields: CharacterFields): string {
  return `# ${cardTitle(name)}\n\n${buildCardBody(name, fields)}`;
}

/** 解析单卡文件的 5 小节（`###` 起，缺的字段留空）。 */
export function parseCardBody(content: string): CharacterFields {
  const fields: CharacterFields = {};
  let cur: CharacterFieldKey | undefined;
  const acc: Record<string, string[]> = {};
  for (const line of content.split("\n")) {
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
  return fields;
}

/** 是否缺少某字段（空 /（待定））。 */
export function isMissingField(v: string | undefined): boolean {
  return cleanPlaceholder(v) === undefined;
}

/** 重建 characters/_index.md 的正文（工具扫描后传入卡片清单）。 */
export function syncIndex(cards: { name: string; one_line: string | undefined }[]): string {
  const bullets = cards.map((c) => {
    const v = cleanPlaceholder(c.one_line);
    return `- ${c.name} · ${v ?? "（待定）"}`;
  });
  const body = bullets.length ? bullets.join("\n") : "（待定：还没有角色卡）";
  return `# characters · 人物层（角色总表）\n\n> 一角色一卡 characters/<名>.md；本表由工具自动同步，勿手改。\n\n${body}\n`;
}
