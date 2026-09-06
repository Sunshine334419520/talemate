/**
 * DocKind：四层企划文档的元信息（排序/文件/一句话）。
 *
 * 结构规范（每层该有哪些小节）不在预埋文件里了——见 doc_spec.ts，按需读取（懒建）。
 * 文件是真相：目标文档平时不存在，用户要完善某层时由 editor 调 doc-spec 拿形状再成稿落盘。
 */
export type DocId = "core" | "world" | "characters" | "outline";

export interface DocKind {
  id: DocId;
  file: string; // core.md …
  title: string; // 中文层名
  blurb: string; // 一层一句话（用于列表/锚点）
}

/** 四层元信息（排序 = 依赖序：core 最先，outline 最后）。 */
export const DOC_KINDS: DocKind[] = [
  {
    id: "core",
    file: "core.md",
    title: "核心层",
    blurb: "卖点/题材/主角内核/金手指边界/爽感承诺——最稳，一切层依赖它",
  },
  {
    id: "world",
    file: "world.md",
    title: "世界层",
    blurb: "舞台与秩序/势力/秘密——慢变、追加为主",
  },
  {
    id: "characters",
    file: "characters.md",
    title: "人物层",
    blurb: "角色总表 + 每角色卡（含说话方式/习惯动作）",
  },
  {
    id: "outline",
    file: "outline.md",
    title: "情节层",
    blurb: "主线/开篇钩子/分卷/伏笔登记——快变、最局部",
  },
];

export const DOC_FILES = DOC_KINDS.map((k) => k.file);
