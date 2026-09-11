/**
 * Layer：四层企划文档的元信息（排序/路径/一句话）。
 *
 * 结构规范（每层该有哪些小节）不在预埋文件里了——见 design_spec.ts，按需读取（懒建）。
 * 文件是真相：目标文档平时不存在，用户要完善某层时由 editor 调 design-spec 拿形状再成稿落盘。
 * 目录（2026-09-07）：design/ 下 core.md 单文件；world = wiki 总纲入口 + 专题页；characters = 一角色一卡；
 * outline = 整本 + 分卷/章节细纲。RESIDENT_DESIGNS = core + wiki/world 总纲（editor 每轮常驻注入）。
 */
export type LayerId = "core" | "world" | "characters" | "outline";

export interface Layer {
  id: LayerId;
  file: string; // design/ 下相对路径（入口；characters 为目录）
  title: string; // 中文层名
  blurb: string; // 一层一句话（用于列表/锚点）
}

/** 四层元信息（排序 = 依赖序：core 最先，outline 最后）。 */
export const LAYERS: Layer[] = [
  {
    id: "core",
    file: "core.md",
    title: "核心层",
    blurb: "小说介绍：题材·频道/一句话简介/金手指·边界/基调·情绪——写作方向不变量，常驻，一切层依赖它",
  },
  {
    id: "world",
    file: "wiki/world.md",
    title: "世界层",
    blurb: "wiki/world.md 总纲入口（空间与舞台/规则与秩序/术语表）常驻；长尾设定拆 wiki/<题>.md 专题页按需读、可自由新增",
  },
  {
    id: "characters",
    file: "characters/",
    title: "人物层",
    blurb: "一角色一卡 characters/<名>.md（含说话方式/习惯动作）+ characters/_index.md 角色总表（工具自动同步）",
  },
  {
    id: "outline",
    file: "outline/outline.md",
    title: "情节层",
    blurb: "outline.md 整本（主线/开篇钩子/分卷/结局/伏笔登记）；章节细纲 plan_ch<N>.md、分卷 vol_*.md 同目录",
  },
];

/** 常驻注入 editor 的设定文档（core + world 总纲），见 framework/anchor buildResidentDesigns。 */
export const RESIDENT_DESIGNS = ["core.md", "wiki/world.md"];
