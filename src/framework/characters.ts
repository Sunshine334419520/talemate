/**
 * 角色卡读助手（framework 领域层）：一角色一卡，`design/characters/<名>.md`。
 *
 * 这里只做**读侧**判定：要不要显示「身份」、缺哪些常见字段（「待补」是提示，不是通行证）、
 * 自由长尾有哪些。正文长什么样不在这里校验——模板是建议，卡片可以只写一段话。
 *
 * 角色卡没有专用写工具：建卡改卡走 `write` / `edit`，删卡走 `delete`。
 * 没有派生总表：名单由 `glob` / `read` 每次现算，数据源只有卡本身。
 */
import { getSection, isFiller, isPendingLine, leadLine, listHeadings } from "./markdown";

export type CharacterFieldKey = "profile" | "contradiction" | "want_fear" | "bottom_line" | "idiolect";

/** 一张卡里必有格的内容；自由长尾的小节不进这里，也不会被改动。 */
export type CharacterFields = Partial<Record<CharacterFieldKey, string>>;

export interface CharacterField {
  key: CharacterFieldKey;
  /** `###` 标题——既是锚点也是"格"的名字（提案按标题寻址、骨架校验按它判齐）。 */
  label: string;
}

/**
 * 常见格，顺序即展示顺序。它是「待补」提示的单一真相源——加一格只在这里加，别处不再抄一份。
 * 不齐不拦落盘：用户想写一段散文、或者只写三格，都行。
 */
export const CHARACTER_FIELDS: CharacterField[] = [
  { key: "profile", label: "基本档案" },
  { key: "contradiction", label: "性格与矛盾" },
  { key: "want_fear", label: "想要 · 最怕" },
  { key: "bottom_line", label: "底线 · 绝不做" },
  { key: "idiolect", label: "说话方式" },
];

/**
 * 「基本档案」写成逐行「键：值」：仍是一格，但一眼看得出缺哪一项，待定也能落到单项上
 * （`职业：（待定）`），而不是整段散文里混着解释。性格 / 想要·最怕 / 底线 / 说话方式不在这里——
 * 它们要写成有写法的段落（「既…又…」的矛盾、一句范例原文），塞进一行会撑破可扫描性，所以各自成节。
 */
export const PROFILE_KEYS = ["姓名", "性别", "年龄段", "籍贯", "职业", "身份 · 所属", "相貌"] as const;
/** 名单取这一行——它才是"这个人是谁"。回退链见 cardIdentity。 */
export const IDENTITY_KEY = "身份 · 所属";

const KEYED_LINE = /^([^:：]{1,12})[:：]\s*(.*)$/;

/** 角色卡所在目录（项目相对，带尾斜杠）。`design_spec` 的规范与 `summaries` 的摘要器都从这里取，不各抄一份。 */
export const CARD_DIR = "design/characters/";

/** 从卡的项目相对路径提取角色名；其它目录（含 `_index.md`）→ undefined。 */
export function nameFromPath(rel: string): string | undefined {
  if (!rel.startsWith(CARD_DIR) || !rel.endsWith(".md")) return undefined;
  const base = rel.slice(CARD_DIR.length, -".md".length);
  return base && base !== "_index" ? base : undefined;
}

/** 标题 → 必有格。只认规范 label——老卡上的旧标题（如「习惯动作」）算自由长尾小节。 */
function fieldByLabel(label: string): CharacterField | undefined {
  const t = label.trim();
  return CHARACTER_FIELDS.find((f) => f.label === t);
}

/**
 * 值算不算"还没定"：空，或每一行都是待定占位（含 `姓名：（待定）` 这种键值写法）。部分填了原样保留——
 * 未定的那几行（`出身：（待定）`）要留在卡上，用户才知道还差哪一项。
 */
function cleanPlaceholder(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  if (!t) return undefined;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length && lines.every(isPendingLine) ? undefined : t;
}

/** 解析单卡的必有格（`###` 起，缺的留空）。自由长尾的小节不在这里——它们由写入通道原样保留。 */
export function parseCardBody(content: string): CharacterFields {
  const fields: CharacterFields = {};
  let cur: CharacterFieldKey | undefined;
  const acc: Record<string, string[]> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^###\s+(.*)$/);
    if (m) {
      cur = fieldByLabel(m[1])?.key;
      if (cur) acc[cur] = [];
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

/**
 * 这张卡还缺哪些常见格的内容。名单行用（「待补：…」）——提示，不是门槛。
 */
export function pendingRequiredLabels(content: string): string[] {
  const fields = parseCardBody(content);
  return CHARACTER_FIELDS.filter((f) => isMissingField(fields[f.key])).map((f) => f.label);
}

/** 自由长尾：卡上除必有五格之外的小节标题，按出现顺序。名单行的「另有」用。 */
export function tailSections(content: string): string[] {
  const required = new Set(CHARACTER_FIELDS.map((f) => f.label));
  return listHeadings(content, 3)
    .map((h) => h.title)
    .filter((t) => !required.has(t));
}

/**
 * 名单（目录索引的角色段）取这一行：「基本档案」里「身份 · 所属」的值。回退链（为的是手写 / 旧卡不炸）：
 * 没有该键 → 第一条键值行的值 → 第一行正文（自由散文的老写法）→「一句话定位」（更老的卡）。
 */
export function cardIdentity(content: string): string | undefined {
  const body = getSection(content, "基本档案").body;
  if (body) {
    const entries = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !isFiller(l))
      .map((l) => {
        const m = l.match(KEYED_LINE);
        return m ? { key: m[1].trim(), value: m[2].trim() } : { key: "", value: l };
      })
      .filter((e) => e.value && !/^（待定/.test(e.value));
    const hit = entries.find((e) => e.key === IDENTITY_KEY) ?? entries[0];
    if (hit) return hit.value.length > 60 ? `${hit.value.slice(0, 60)}…` : hit.value;
  }
  return leadLine(content, "一句话定位");
}

/** 「另有」最多列几个自由小节标题——超出截断，否则这一行会撑满整个名单。 */
const TAIL_LIMIT = 5;

/**
 * 角色卡在名单里的那一行，三段全现算：`身份（必有齐）` / `身份（待补：底线 · 绝不做）`，
 * 有自由长尾时再缀「另有：回响、能力 · 机制」。长尾每张卡都不同，它才是信号——不把卡读进上下文，
 * 也能看出这张卡上除了必有格还有什么；目录要廉价，正文才昂贵。
 *
 * 住在 `characters.ts` 而不是索引那一侧：它拼的是卡的三个领域事实（身份 / 必有齐没齐 / 自由长尾），
 * 索引只把它放进目录（见 `framework/summaries.ts` 的注册表）。
 */
export function characterLine(content: string): string {
  const identity = cardIdentity(content) ?? "（待定）";
  const missing = pendingRequiredLabels(content);
  const status = missing.length ? `待补：${missing.join("、")}` : "常见格齐";
  const tail = tailSections(content);
  const extra = tail.length
    ? `；另有：${tail.slice(0, TAIL_LIMIT).join("、")}${tail.length > TAIL_LIMIT ? "…" : ""}`
    : "";
  return `${identity}（${status}${extra}）`;
}
