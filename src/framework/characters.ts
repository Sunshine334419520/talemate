/**
 * 角色卡 schema 与读助手（framework 领域层）。
 *
 * 一角色一卡：每张卡是 design/characters/<名>.md，`# 角色：<名>` 标题 + 若干 `###` 小节，分两部分：
 *   必有格 —— 5 格（见 CHARACTER_FIELDS），整篇提案缺一即拒（见 missingSkeletonSections）
 *   自由长尾 —— 用户提出要加什么就加什么；工具**原样保留**，不催、不校验
 *
 * **角色卡没有任何专用写工具**：创建与修改一律走 `propose-design`（两段式，用户看过才落盘）
 * → `apply-design`。本文件只提供"怎么算一张合规的卡"的**读**侧判定——骨架齐不齐、必有格空不空、
 * 名单行取哪一行。**角色专用工具一个都没有**——建卡改卡走 `propose-design` / `edit`，删卡走 `delete`。
 *
 * **分层的旧账**：曾经有 resident/ondemand/managed 三层与 12 格型录。按需格从来没有被按需加载过
 * （没有任何切片 API），managed 的「当前」其写入方（章末回写）从未实现——两者都已删除。
 * 「当前」那类状态归后续的 `design/state/`，不再进卡。
 *
 * **没有派生总表**：名单（有哪些人 + 每人必有格齐没齐）由 `list` **每次现算**，
 * 数据源只有卡本身。曾经有过一个 `characters/_index.md`，它是卡的副本——副本会脱节
 * （走 propose-design 落卡就不更新），现算不会。
 *
 * **卡是长期动态维护的活文档**——完整设计见 `docs/characters.md`。与"文件是真相"一致：
 * 读取/改动都以其当前内容为准，schema 只负责"怎么算一张合规的卡"。
 *
 * 硬约束：卡上只许 `###`（`# 角色：<名>` 是 H1）。理由见 rejectShallowHeading。
 */
import { getSection, isFiller, isPendingLine, leadLine, listHeadings, matchesLevel2Heading } from "./markdown";

export type CharacterFieldKey = "profile" | "contradiction" | "want_fear" | "bottom_line" | "idiolect";

/** 一张卡里**必有格**的内容（自由长尾的小节不进这里，也不会被改动）。 */
export type CharacterFields = Partial<Record<CharacterFieldKey, string>>;

export interface CharacterField {
  key: CharacterFieldKey;
  /** `###` 标题——既是锚点也是"格"的名字（提案按标题寻址、骨架校验按它判齐） */
  label: string;
}

/**
 * 必有格（顺序 = 规范顺序）。
 *
 * 这张表是**骨架的单一真相源**：`missingSkeletonSections` 判齐、`design_spec` 的 guide 由它派生、
 * 名单行的「待补」由它算。加一格就在这里加一行，别在别处再抄一份。
 */
export const CHARACTER_FIELDS: CharacterField[] = [
  { key: "profile", label: "基本档案" },
  { key: "contradiction", label: "性格与矛盾" },
  { key: "want_fear", label: "想要 · 最怕" },
  { key: "bottom_line", label: "底线 · 绝不做" },
  { key: "idiolect", label: "说话方式" },
];

/**
 * 「基本档案」的书写格式：**逐行「键：值」**。
 * 它不是把格子拆开（仍是一格），而是给这一格一个可扫描的形状——一眼看得出缺哪一项，
 * 待定也能落到单项上（`职业：（待定）`），而不是整段散文里混着解释。
 *
 * 性格 / 想要·最怕 / 底线 / 说话方式**不在这里**：它们要写成有写法的段落（「既…又…」的矛盾、
 * 一句范例原文），塞进「键：值」的一行会撑破这张表的可扫描性——所以各自成节。
 */
export const PROFILE_KEYS = ["姓名", "性别", "年龄段", "籍贯", "职业", "身份 · 所属", "相貌"] as const;
/** 名单取这一行——它才是"这个人是谁"。回退链见 cardIdentity。 */
export const IDENTITY_KEY = "身份 · 所属";

const KEYED_LINE = /^([^:：]{1,12})[:：]\s*(.*)$/;

/**
 * 角色卡所在目录（**项目相对**，带尾斜杠）。
 *
 * `design_spec` 里那条规范与 `summaries` 里那条摘要器都指同一个地方，所以从**这里**取，
 * 不各抄一份——这个仓库被"副本会脱节"烧过两次。
 */
export const CARD_DIR = "design/characters/";

/** 从卡的项目相对路径提取角色名；其它目录 → undefined。（`_index.md` 是历史遗留文件，也排除） */
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
 * 值算不算"还没定"：空、或**每一行**都是待定占位（含 `姓名：（待定）` 这种键值写法）。
 * 部分填了就把原样保留——未定的那几行（`出身：（待定）`）要留在卡上，用户才知道还差哪一项。
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

/** 卡上出现了 `##`（比 `###` 更浅）→ 返回那个标题；没有则 undefined。 */
export function rejectShallowHeading(content: string): string | undefined {
  return matchesLevel2Heading(content);
}

/**
 * 这张卡的骨架还缺哪几格（必有五格）。整篇提案用：缺了不许落盘——否则会出现半身卡。
 *
 * **不自动补格**：自动补会让"用户看过的"≠"落盘的"，那正是提案渲染存在的理由。
 * 注意这只是"标题在不在"；**内容空不空**由 `pendingRequiredLabels`（名单行的「待补」）判——
 * 写个空标题能过骨架校验，但会在名单里显示为待补。
 */
export function missingSkeletonSections(content: string): string[] {
  const have = new Set(listHeadings(content, 3).map((h) => h.title));
  return CHARACTER_FIELDS.filter((f) => !have.has(f.label)).map((f) => f.label);
}

/** 这张卡还缺哪些**必有格的内容**。名单行用（「待补：…」）。 */
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
 * 名单（`list` 的角色段）取这一行：「基本档案」里「身份 · 所属」的值。
 *
 * 回退链（都是为了手写/旧卡不炸）：没有该键 → 第一条键值行的值 → 第一行正文（自由散文的老写法）
 * →「一句话定位」（更老的卡）。
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

/** 「另有」最多列几个自由小节标题——超出截断，免得一行吃掉整个名单。 */
const TAIL_LIMIT = 5;

/**
 * 角色卡在名单里的那一行，三段全**现算**：
 *   `身份（必有齐）` / `身份（待补：底线 · 绝不做）`，有自由长尾时再缀「另有：回响、能力 · 机制」。
 *
 * 「另有」是 2026-09-19 加的。从前每张卡都铺同样的 12 个固定小节，列出来是纯噪音，
 * 所以那时的规矩是"不铺小节标题"。现在长尾**每张卡都不同**——它才是信号：
 * 不把卡读进上下文，也能看出"这张卡上除了必有格还有什么"。
 * 目录要廉价，正文才昂贵；这一行是目录那一半。
 *
 * 住在 `characters.ts` 而不是索引那一侧：它拼的是**卡**的三个领域事实（身份 / 必有齐没齐 / 自由长尾），
 * 索引只负责把它摆进目录（见 `framework/summaries.ts` 的注册表）。
 */
export function characterLine(content: string): string {
  const identity = cardIdentity(content) ?? "（待定）";
  const missing = pendingRequiredLabels(content);
  const status = missing.length ? `待补：${missing.join("、")}` : "必有齐";
  const tail = tailSections(content);
  const extra = tail.length
    ? `；另有：${tail.slice(0, TAIL_LIMIT).join("、")}${tail.length > TAIL_LIMIT ? "…" : ""}`
    : "";
  return `${identity}（${status}${extra}）`;
}
