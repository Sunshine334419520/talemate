/**
 * 角色卡 schema 与读写助手（framework 领域层）。
 *
 * 一角色一卡：每张卡是 design/characters/<名>.md，`# 角色：<名>` 标题 + 若干 `###` 小节，分三层：
 *   resident 常驻带 —— 写这个角色的**任何一场戏**都要带（4 格，先填这些）
 *   ondemand 按需格 —— 按场景切片；按戏份决定填几格，不填**不是缺陷**
 *   managed  工具托管 —— 「当前」（点形快变状态），普通更新一律不碰（见 applyCardEdits）
 * 规范之外的 `###` 小节 = **开放长尾**（世界特有的格，如「回响」），工具原样保留。
 * characters/_index.md 是派生总表（工具每次增删改后扫描 characters/ 重建，取「基本档案」首句）。
 *
 * **卡是长期动态维护的活文档**——完整设计（好卡的标尺 / 点与边 / 维护模型 / 章末回写）见
 * `09-character-layer-design.md`。与"文件是真相"一致：读取/改动都以其当前内容为准，
 * schema 只负责"怎么算一张合规的卡"。
 *
 * 硬约束：卡上只许 `###`（`# 角色：<名>` 是 H1）。理由见 rejectShallowHeading。
 */
import { appendBlock, getSection, leadLine, listHeadings, matchesLevel2Heading, replaceSection } from "./markdown";

export type CharacterTier = "resident" | "ondemand" | "managed";

export type CharacterFieldKey =
  // 常驻带
  | "profile"
  | "want_fear"
  | "bottom_line"
  | "idiolect"
  // 按需格
  | "contradiction"
  | "origin"
  | "quotes"
  | "body_habit"
  | "relations"
  | "ability"
  | "arc"
  | "function"
  // 工具托管
  | "current";

/** 一张卡的内容（只含已知格；规范外的自定义小节不进这里，也不会被改动）。 */
export type CharacterFields = Partial<Record<CharacterFieldKey, string>>;

export interface CharacterField {
  key: CharacterFieldKey;
  /** `###` 标题（既是锚点也是键——工具按它寻址） */
  label: string;
  placeholder: string;
  tier: CharacterTier;
  /** 旧卡的同义标题：读时认，写时写回**原格**（不产生重复小节）。 */
  aliases?: string[];
}

/** 卡片骨架（顺序 = 规范顺序，也是插入新格时的定位依据）。 */
export const CHARACTER_FIELDS: CharacterField[] = [
  // ── 常驻带：写这个角色的任何一场戏都要带 ──
  {
    key: "profile",
    label: "基本档案",
    tier: "resident",
    placeholder: "（待定：首行写身份/所属——角色总表取这一行；其后性别/年龄段/外貌/出身）",
  },
  {
    key: "want_fear",
    label: "想要 · 最怕",
    tier: "resident",
    placeholder: "（待定：欲望与恐惧，驱动行为的钩子）",
  },
  {
    key: "bottom_line",
    label: "底线 · 绝不做",
    tier: "resident",
    placeholder: "（待定：ta 宁可付出什么也不做的事；要能被剧情逼到墙角的那种）",
  },
  {
    key: "idiolect",
    label: "说话方式",
    tier: "resident",
    placeholder: "（待定：口头禅/拐不拐弯；给一句『声音范例』原文，别只写性格形容词）",
  },
  // ── 按需格：按场景切片，按戏份决定填几格 ──
  {
    key: "contradiction",
    label: "性格与矛盾",
    tier: "ondemand",
    placeholder: "（待定：写成「既…又…」的矛盾，不是形容词堆）",
  },
  {
    key: "origin",
    label: "来历 · 成因",
    tier: "ondemand",
    placeholder: "（待定：只写「造成他现在这样的那几件事」，不写履历）",
  },
  { key: "quotes", label: "语录", tier: "ondemand", placeholder: "（待定：原话，不是转述——它是可验伪的声音锚）" },
  {
    key: "body_habit",
    label: "身体 · 习惯",
    tier: "ondemand",
    aliases: ["习惯动作"],
    placeholder: "（待定：习惯动作 / 身体记号——写成能被用到的道具）",
  },
  {
    key: "relations",
    label: "关联角色",
    tier: "ondemand",
    placeholder: "（待定：ta 欠谁什么 / ta 怎么看谁；与对方卡不对称为常态，不是 bug）",
  },
  {
    key: "ability",
    label: "能力 · 机制",
    tier: "ondemand",
    placeholder: "（待定：触发条件尽量由性格导出；与核心层「金手指·边界」对齐）",
  },
  {
    key: "arc",
    label: "转变 · 走向",
    tier: "ondemand",
    placeholder: "（待定：静态终点与框架判断；逐章进度归细纲）",
  },
  {
    key: "function",
    label: "在故事中的功能",
    tier: "ondemand",
    placeholder: "（待定：对主线的作用；与主角的关系）",
  },
  // ── 工具托管：章末回写维护 ──
  {
    key: "current",
    label: "当前",
    tier: "managed",
    placeholder: "（待定：在场/已故 + 此刻处境。章末回写更新，勿手改）",
  },
];

/** 常驻带：写这个角色的任何一场戏都要带（也只有这些格会被催着补）。 */
export const RESIDENT_FIELDS = CHARACTER_FIELDS.filter((f) => f.tier === "resident");
/** 可由 add/update-character 入参设置的格（工具托管的「当前」除外）。 */
export const EDITABLE_FIELDS = CHARACTER_FIELDS.filter((f) => f.tier !== "managed");

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

function fieldByKey(key: CharacterFieldKey): CharacterField {
  return CHARACTER_FIELDS.find((f) => f.key === key)!;
}

/** 格的中文标题（工具文案用）。 */
export function labelOf(key: CharacterFieldKey): string {
  return fieldByKey(key).label;
}

/** 标题 → 格；认规范 label，也认别名（老卡的「习惯动作」）。 */
function fieldByLabel(label: string): CharacterField | undefined {
  const t = label.trim();
  return CHARACTER_FIELDS.find((f) => f.label === t || (f.aliases ?? []).includes(t));
}

function cleanPlaceholder(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  if (!t) return undefined;
  if (/^（待定.*）$/.test(t)) return undefined;
  return t;
}

/**
 * 生成卡片正文（不含 `# 角色：` 标题行）。
 * 常驻 4 格 + 「当前」**恒定输出**（缺的写占位）：常驻带是契约，空格子要看得见；
 * 「当前」恒定建出来，是因为章末回写要用小节级 `edit`，而小节缺失时 `edit` 直接失败。
 * 按需格**给了才写**——新卡是 5 节，不是 13 节空架子（按需 = 按戏份填）。
 */
export function buildCardBody(fields: CharacterFields): string {
  const blocks: string[] = [];
  for (const f of CHARACTER_FIELDS) {
    const v = cleanPlaceholder(fields[f.key]);
    if (!v && f.tier === "ondemand") continue;
    // 标题后留一个空行：与 markdown.replaceSection 写出来的形状一致，免得"改过的格"和"没改的格"排版不同
    blocks.push(`### ${f.label}\n\n${v ?? f.placeholder}`);
  }
  return blocks.join("\n\n");
}

/** 生成整卡 markdown（含 `# 角色：name` 标题），供 add-character 落盘。 */
export function buildCardMarkdown(name: string, fields: CharacterFields): string {
  return `# ${cardTitle(name)}\n\n${buildCardBody(fields)}`;
}

/** 解析单卡的已知格（`###` 起，缺的留空）。规范外的小节不在这里——它们由 applyCardEdits 原样保留。 */
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
 * 入参正文里不许带标题行。返回错误文案；null = 通过。
 *
 * 这不是风格洁癖：proposal.ts 的 `ownItems` 取**最浅**标题层——卡上冒出任意一个 `##`，
 * 全部 `###` 就都从提案审阅里消失，用户没看过的字节直接落盘（正是那套渲染要治的病）。
 */
export function rejectHeadings(body: string): string | null {
  const m = body.match(/^#{1,6}\s+(.*)$/m);
  if (!m) return null;
  return `正文里不要带标题行（收到「${m[1].trim()}」）——标题由工具按规范写，只给正文即可。`;
}

/** 卡上出现了 `##`（比 `###` 更浅）→ 返回那个标题；没有则 undefined。见 rejectHeadings。 */
export function rejectShallowHeading(content: string): string | undefined {
  return matchesLevel2Heading(content);
}

/**
 * 把改动**外科**落进卡片正文：逐格 `replaceSection`，规范外的小节**原样保留**。
 *
 * 这里是修掉"静默丢数据"的地方：旧实现走 `parseCardBody → buildCardMarkdown` 整卡重建，
 * 任何规范外的小节（世界特有的「回响」、经 append-design 加的块）会被无声抹掉，
 * 而 confirm 文案还写着"其余保留"。现在：别名命中写回**原格**（老卡的「习惯动作」
 * 不会被复制成新格）；缺的格按规范顺序插入；managed 格（「当前」）一律跳过。
 */
export function applyCardEdits(content: string, incoming: CharacterFields): string {
  let out = content;
  for (const f of CHARACTER_FIELDS) {
    if (f.tier === "managed") continue;
    const v = incoming[f.key];
    if (v === undefined) continue;
    const body = v.trim();
    const target = getSection(out, f.label).found
      ? f.label
      : (f.aliases ?? []).find((a) => getSection(out, a).found);
    out = target ? replaceSection(out, target, body) : insertSectionInOrder(out, f, body);
  }
  return out;
}

/** 按规范顺序把缺的小节插进去（插在第一个"规范序更靠后"的已知格之前）；没有就追加到末尾。 */
function insertSectionInOrder(content: string, field: CharacterField, body: string): string {
  const order = CHARACTER_FIELDS.map((f) => f.label);
  const mine = order.indexOf(field.label);
  const anchor = listHeadings(content, 3).find((h) => {
    const i = order.indexOf(h.title);
    return i !== -1 && i > mine;
  });
  const block = `### ${field.label}\n${body || field.placeholder}`;
  if (!anchor) return appendBlock(content, block);
  const lines = content.split("\n");
  const head = lines.slice(0, anchor.line).join("\n").trimEnd();
  const tail = lines.slice(anchor.line).join("\n");
  return `${head}\n\n${block}\n\n${tail}`;
}

/**
 * 角色总表取这一行：「基本档案」首句。
 * 回退到「一句话定位」是为了 P1 之前建的卡——不让老项目的总表一夜之间全变（待定）。
 */
export function cardIdentity(content: string): string | undefined {
  return leadLine(content, "基本档案") ?? leadLine(content, "一句话定位");
}

/** 重建 characters/_index.md 的正文（工具扫描后传入卡片清单）。 */
export function syncIndex(cards: { name: string; identity: string | undefined }[]): string {
  const bullets = cards.map((c) => `- ${c.name} · ${c.identity ?? "（待定）"}`);
  const body = bullets.length ? bullets.join("\n") : "（待定：还没有角色卡）";
  return `# characters · 人物层（角色总表）\n\n> 一角色一卡 characters/<名>.md；本表由工具自动同步，勿手改。\n\n${body}\n`;
}
