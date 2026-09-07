/**
 * doc-spec：每层"结构规范"（该层目标文档该有哪些小节 + 成稿/补缺做法）。
 *
 * 设计（2026-09-06）：
 * - 懒建：目标文档平时不存在，用户要完善某层时才由 editor 调 doc-spec 拿形状，再成稿落盘。
 * - 成稿：不逐格盘问；让用户先用自己话讲 → 按小节整理一版草稿（缺的写（待定））→ 确认后整层落盘；
 *   之后只更新仍（待定）/要改的那一小节（edit-doc），补细节时给建议/选项。
 * - 结构与内容分离：这里只定义"长什么样"；文档文件一旦建立即内容与真相。
 */
import { DOC_KINDS, type DocId } from "./dockind";

export interface DocSection {
  heading: string;
  hint?: string;
}

export interface DocSpec {
  id: DocId;
  file: string;
  title: string;
  sections: DocSection[];
  guide: string; // 成稿/补缺做法（给模型看的工作法）
}

const WORK_METHOD = [
  "工作法：",
  "1) 先让用户用自己的话讲（他往往会给一整段，别逐格盘问）；",
  "2) 把他的话按上面小节整理成一版草稿，没讲到的写（待定），保留用户原话里的细节与味道；",
  "3) 整篇写进该文件前先经用户确认（write-doc 会请你确认）；",
  "4) 之后只更新仍（待定）/要改的那一小节（edit-doc 按小节标题改），补细节时给建议或选项、一次可答多个；",
  "5) 文档文件一旦建立，后续以文件当前内容为准（先 read-doc 再动）。",
].join("\n");

export const DOC_SPECS: Record<DocId, DocSpec> = {
  // core：核心层 = 小说介绍（写作方向不变量）——常驻，一切层依赖它。2026-09-06 收敛：
  // - 一句话卖点并入一句话简介；主角只以"身份词"留在简介前提句，其内核(想要/最怕/为什么是他)下放 characters 主角卡；
  // - 爽感承诺收敛为基调·情绪（写哪章都不许破坏的情绪，不是爽点排布——排布归 outline/技法）；
  // - 目标读者移出（非写作不变量，与"定位"的关系未定）。
  // - 世界观是 wiki/world.md 自己的活（三格：空间与舞台/规则与秩序/术语表），不并入 core；总纲随 core 常驻（buildResidentDocs），长尾拆 wiki/<题>.md 专题页按需读。
  core: {
    id: "core",
    file: "core.md",
    title: "核心层（小说介绍）",
    sections: [
      { heading: "题材 · 频道", hint: "男频/女频/双频 + 题材标签——货架与读者预期契约" },
      { heading: "一句话简介", hint: "谁（身份+处境）× 想达成什么 × 挡路的是什么；能被一句话复述" },
      { heading: "金手指 / 超常设定", hint: "有外挂→一句+硬边界；无→写「真实系」，边界=仍受什么约束（写手据此不越界）" },
      { heading: "基调 · 情绪", hint: "这本书读起来像什么；每章写作不许破坏的情绪（一句话，不是爽点排布）" },
    ],
    guide: WORK_METHOD,
  },
  // world：世界层 = 这本书"当下"的静态舞台与规则。2026-09-06 收敛（与 core 同轮）：
  // - 六格收窄为三格：空间与舞台 / 规则与秩序 / 术语表。
  // - 删「世界观一句话」（世界性质并进空间与舞台第一行）；删「势力与人物群像」（势力=会"想要"的 actor，
  //   归属 characters 组织卡 / 独立关系网 待定，见 06 §8）；删「历史痕迹与秘密」独立格（仍生效的过去
  //   作为成因/遗迹写进相关空间/规则描述；悬念/未解之谜归 outline「伏笔与回收登记」）。
  world: {
    id: "world",
    file: "wiki/world.md",
    title: "世界层（舞台与规则 · wiki）",
    sections: [
      { heading: "空间与舞台", hint: "世界性质（现实都市/高魔/克苏鲁/古代…）+ 主要舞台 + 时代与科技水平 + 地图怎么流动；过去只在仍生效时作为成因/遗迹写进相关描述" },
      { heading: "规则与秩序", hint: "约束每一场成立的规则：力量体系/社会规则/资源约束 + 硬边界（上限/代价/不可逆）+ 世界当前总体状况（若整个世界悬着什么硬事实，写作每章都别忘）" },
      { heading: "术语表", hint: "生造词/专名解释（暂集中收在此层，长大再拆行）" },
    ],
    guide: [
      "工作法：",
      "1) 总纲入口是 wiki/world.md（以上三格），常驻注入、写在它里面；",
      "2) 长尾设定（地理/势力/历史/专名展开等）拆成 wiki/<题>.md 专题页，world.md 里留一行指引——专题页按需读、不常驻；",
      "3) 先让用户用自己的话讲 → 按小节整理成草稿（没讲到的写（待定））→ write-doc 整层落盘 confirm；",
      "4) 之后只 edit-doc 还待定/要改的那一格，补细节给建议/选项、一次可答多个；",
      "5) 文档文件一旦建立，后续以文件当前内容为准（先 read-doc 再动）。",
    ].join("\n"),
  },
  characters: {
    id: "characters",
    file: "characters/",
    title: "人物层（角色总表 + 一角色一卡）",
    sections: [
      { heading: "角色总表", hint: "characters/_index.md，每行一位：名字 · 一句话定位——由工具自动同步" },
    ],
    guide: [
      "工作法：",
      "1) 加角色用 add-character：自动生成 characters/<名>.md 规范卡（一句话定位/想要·最怕/说话方式(给声音范例原文)/习惯动作/在故事中的功能，缺格会提示补），并同步 characters/_index.md 角色总表；",
      "2) 想了解/完善某角色先 read-doc 看 characters/<名>.md 当前卡，update-character 只改你传的格；",
      "3) 一角色一卡；_index.md 由工具自动同步，不用手改；删角色用 remove-character。",
    ].join("\n"),
  },
  outline: {
    id: "outline",
    file: "outline/outline.md",
    title: "情节层（主线到章节）",
    sections: [
      { heading: "一句话主线", hint: "从开场到结局要完成什么、代价是什么" },
      { heading: "开篇钩子（前 3 章）", hint: "每章一个钩子" },
      { heading: "分卷方向", hint: "每卷：目标/冲突升级/卷末" },
      { heading: "结局方向", hint: "止于什么；可暂留余地" },
      { heading: "伏笔与回收登记", hint: "埋点 | 章节 | 状态：埋/已回收/放弃" },
    ],
    guide: [
      "工作法：",
      "1) 整本结构写 outline/outline.md（本节五格）；章节细纲 plan_ch<N>.md、分卷细纲 vol_*.md 与它同目录；",
      "2) 先让用户用自己的话讲 → 按小节整理成草稿（没讲到的写（待定））→ write-doc 整层落盘 confirm；",
      "3) 之后只 edit-doc 还待定/要改的那一格，补细节给建议/选项、一次可答多个；",
      "4) 文档文件一旦建立，后续以文件当前内容为准（先 read-doc 再动）。",
    ].join("\n"),
  },
};

/** 渲染成给模型的规范文本（doc-spec 工具返回用）。 */
export function renderDocSpec(id: DocId): string {
  const spec = DOC_SPECS[id];
  const head = spec.sections.map((s) => `  ## ${s.heading}${s.hint ? `（${s.hint}）` : ""}`).join("\n");
  const target = spec.file.endsWith("/") ? `design/${spec.file}` : `design/${spec.file}`;
  return [
    `【${spec.title} · 目标 ${target}】`,
    "该层文档应含以下小节（每个 ## 即一格，后续可单独 edit-doc 那一格）：",
    head,
    "",
    spec.guide,
  ].join("\n");
}

export { DOC_KINDS };
