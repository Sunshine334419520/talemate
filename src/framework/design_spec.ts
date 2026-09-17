/**
 * design-spec：每层"结构规范"——该层目标文档该有哪些小节、每格装什么、成稿做法。
 *
 * - 懒建：目标文档平时不存在，用户要完善某层时才取规范、成稿落盘。
 * - 结构与内容分离：这里只定义"长什么样"；文档文件一旦建立即内容与真相。
 */
import { LAYERS, type LayerId } from "./layers";

/**
 * 一个小节（"格"）的**内容规范**，三件：
 *   write  该装什么
 *   avoid  不许装什么（越界线）
 *   form   写成什么样（形制与口气）
 * 只进 design-spec 的返回（给模型看），不进用户看到的提案。
 */
export interface DesignSection {
  heading: string;
  write: string;
  avoid?: string;
  form?: string;
}

/** 通篇形制要求（core / world / outline 共用；characters 是一角色一卡、不套这条）。 */
const DOC_STYLE =
  '通篇：断言式、条目优先。不写剧情事件、不写台词、不写抒情和解释性铺陈，不出现自我评价（「极具张力」「令人震撼」这类）。这是给写手当约束用的，不是给读者看的简介。';

export interface DesignSpec {
  id: LayerId;
  file: string;
  title: string;
  sections: DesignSection[];
  /** 通篇形制（见 DOC_STYLE）；只有"文档型"的层有 */
  style?: string;
  guide: string; // 成稿/补缺做法（给模型看的工作法）
}

const WORK_METHOD = [
  "工作法：",
  "1) 先让用户用自己的话讲（他往往会给一整段，别逐格盘问）；",
  "2) 把他的话按上面小节整理成一版草稿，没讲到的写（待定），保留用户原话里的细节与味道；",
  "3) 用 propose-design 把草稿摆给用户看——**这一步不写盘**，本回合到此为止，等他回话：",
  "   他说没问题 → apply-design 落盘；他要改 → 按他的话改完再 propose-design 一次（改了内容必须重新提案）；",
  "4) 之后只更新仍（待定）/要改的那一小节（propose-design 带 section，按小节标题改），补细节时给建议或选项、一次可答多个；",
  "5) 文档文件一旦建立，后续以文件当前内容为准（先 read-design 再动）。",
].join("\n");

export const DESIGN_SPECS: Record<LayerId, DesignSpec> = {
  // core：小说介绍（写作方向不变量），常驻、一切层依赖它。
  // 主角内核（想要/最怕/为什么是他）归 characters 主角卡；爽点排布归 outline；世界观归 wiki/world.md，均不并入本层。
  core: {
    id: "core",
    file: "core.md",
    title: "核心层（小说介绍）",
    sections: [
      {
        heading: "题材 · 频道",
        write: "频道（男频/女频/双频）+ 题材标签，用货架上能搜到的词。",
        avoid: "读者会得到什么的承诺、定位分析、与别的作品比较。",
        form: "先频道、后标签，各一行；只写名词，不造句。",
      },
      {
        heading: "一句话简介",
        write: "谁（身份+处境）× 他要什么 × 挡着他的是什么。可带一个最锋利的设定点。",
        avoid: "结局、主题升华、第二个句子；专名只留必要的。",
        form: "一句，一口气能读完，能被复述。",
      },
      {
        heading: "金手指 / 超常设定",
        write:
          "能力是什么（一句）+ 硬边界（上限 / 代价 / 不可逆 / 触发条件）。没有超常就写「真实系」+ 受什么约束。",
        avoid:
          "它为什么存在、「为什么偏偏是他」这类主线底牌（那归大纲的伏笔登记）；不写它会怎么被用来破案。",
        form: "先一句能力，再逐条列边界；每条一行、`- ` 开头，读完能当约束用。",
      },
      {
        heading: "基调 · 情绪",
        write: "这本书读起来像什么（可给一个具体意象）+ 每章都不许破坏的情绪。",
        avoid: "爽点排布、节奏安排、读者反应预测。不堆形容词。",
        form: "先一句感觉锚点，再列「不许破坏」的那几条。",
      },
    ],
    style: DOC_STYLE,
    guide: WORK_METHOD,
  },
  // world：这本书"当下"的静态舞台与规则（总纲常驻注入；长尾拆 wiki/<题>.md 专题页按需读）。
  // 势力归 characters；悬念/未解之谜归 outline「伏笔与回收登记」。
  world: {
    id: "world",
    file: "wiki/world.md",
    title: "世界层（舞台与规则 · wiki）",
    sections: [
      {
        heading: "空间与舞台",
        write:
          "世界性质（一句）+ 主要舞台（具体到能走进去）+ 时代与科技水平 + 空间怎么流动（人怎么从 A 到 B）。",
        avoid: "某一场戏怎么演、房间怎么布置、编年史。过去只在「仍生效」时作为成因/遗迹写进相关描述。",
        form: "条目式。地形地名用名词，不展开故事。没定的标（待定）。",
      },
      {
        heading: "规则与秩序",
        write:
          "每一场都成立的规则（力量体系 / 社会规则 / 资源约束）+ 硬边界（上限·代价·不可逆）+ 世界此刻悬着的硬事实（只留最要紧的那条：它约束的是读者从第几章起知道什么，多了就成了情节）。",
        avoid: "具体案件、谁在掩盖什么（那是情节）；不写规则怎么被主角利用。",
        form: "条目式，每条是「世界层面的断言」，不是「这一章会发生什么」。",
      },
      {
        heading: "术语表",
        write: "生造词、专名：词 · 一句解释。",
        avoid: "需要展开的设定 —— 那些拆成 wiki/<题>.md 专题页。",
        form: "一条一行，解释一句话。",
      },
    ],
    style: DOC_STYLE,
    guide: [
      "工作法：",
      "1) 总纲入口是 wiki/world.md（以上三格），常驻注入、写在它里面；",
      "2) 长尾设定（地理/势力/历史/专名展开等）拆成 wiki/<题>.md 专题页，world.md 里留一行指引——专题页按需读、不常驻；",
      "3) 先让用户用自己的话讲 → 按小节整理成草稿（没讲到的写（待定））→ propose-design 摆给他看、等回话 → 认可后 apply-design；",
      "4) 之后只 propose-design 那一格（带 section），补细节给建议/选项、一次可答多个；",
      "5) 文档文件一旦建立，后续以文件当前内容为准（先 read-design 再动）。",
    ].join("\n"),
  },
  characters: {
    id: "characters",
    file: "characters/",
    title: "人物层（角色总表 + 一角色一卡）",
    sections: [
      {
        heading: "角色总表",
        write: "characters/_index.md，每行一位：名字 · 身份/所属（取该卡「基本档案」的首句）。",
        avoid: "手写这个文件——它由工具增删改后自动同步。",
      },
    ],
    guide: [
      "一角色一卡 characters/<名>.md = `# 角色：<名>` + 若干 `###` 小节，分两层：",
      "  常驻带（写 ta 的任何一场戏都要带，先填这四格）：### 基本档案（首行写身份/所属，角色总表取这一行）/ ### 想要 · 最怕 / ### 底线 · 绝不做 / ### 说话方式（给一句『声音范例』原文，别只写性格形容词）；",
      "  按需格（按场景切片，按戏份随时补，不填不是缺陷）：### 性格与矛盾 / ### 来历 · 成因 / ### 语录 / ### 身体 · 习惯 / ### 关联角色 / ### 能力 · 机制 / ### 转变 · 走向 / ### 在故事中的功能。",
      "  `### 当前`（在场/已故 + 此刻处境）由章末回写维护，不要手改；规范外的自定义 `###` 小节允许（世界特有的，如「回响」），工具会原样保留。",
      "工作法：",
      "1) 加角色用 add-character：只缺的常驻格写（待定）并提示补，并同步 characters/_index.md；别逐格盘问——让用户用自己的话讲；",
      "2) 想了解/完善某角色先 read-design 看 characters/<名>.md 当前卡，update-character 只改你传的格，其余（含自定义小节）原样保留；",
      "3) 拿不准声音时用**试镜**：让 ta 开口给一句台词，比问「性格是什么」有效——用户说「他不会这么说话」的那一刻，才是真的在设计角色；",
      "4) 用户说的与卡冲突时，把冲突摆出来问一句：改卡还是改戏？（卡是用户签过的合同，不是摆设）；",
      "5) 一角色一卡；_index.md 由工具自动同步，不用手改；删角色用 remove-character。",
    ].join("\n"),
  },
  outline: {
    id: "outline",
    file: "outline/outline.md",
    title: "情节层（主线到章节）",
    sections: [
      { heading: "一句话主线", write: "从开场到结局要完成什么、代价是什么。" },
      { heading: "开篇钩子（前 3 章）", write: "每章一个钩子。" },
      { heading: "分卷方向", write: "每卷：目标 / 冲突升级 / 卷末。" },
      { heading: "结局方向", write: "止于什么；可暂留余地。" },
      { heading: "伏笔与回收登记", write: "埋点 | 章节 | 状态：埋 / 已回收 / 放弃。" },
    ],
    style: DOC_STYLE,
    guide: [
      "工作法：",
      "1) 整本结构写 outline/outline.md（本节五格）；章节细纲 plan_ch<N>.md、分卷细纲 vol_*.md 与它同目录；",
      "2) 先让用户用自己的话讲 → 按小节整理成草稿（没讲到的写（待定））→ propose-design 摆给他看、等回话 → 认可后 apply-design；",
      "3) 之后只 propose-design 那一格（带 section），补细节给建议/选项、一次可答多个；",
      "4) 文档文件一旦建立，后续以文件当前内容为准（先 read-design 再动）。",
    ].join("\n"),
  },
};

/** 渲染成给模型的规范文本（design-spec 工具返回用）。目标路径留着——propose-design 靠它知道往哪写。 */
export function renderDesignSpec(id: LayerId): string {
  const spec = DESIGN_SPECS[id];
  // 每格三行（写 / 别写 / 写成）。
  const head = spec.sections.flatMap((s) => [
    `  ## ${s.heading}`,
    `     写：${s.write}`,
    ...(s.avoid ? [`     别写：${s.avoid}`] : []),
    ...(s.form ? [`     写成：${s.form}`] : []),
  ]);
  // 主文档是一个文件的层，把写入用的 key 就地给它（propose-design/apply-design 收 layer）；
  // characters 的 file 是目录、不是写入目标，所以不给 key（它的写法在 guide 里指向 add-character）。
  const isDir = spec.file.endsWith("/");
  const layerKey = isDir ? "" : ` · layer: ${spec.id}`;
  return [
    `【${spec.title}${layerKey} · 目标 design/${spec.file}】`,
    // 目录型（人物层）不是"一个文档若干 ##"——它的形状在 guide 里（一角色一卡，卡内是 ###）。
    isDir
      ? "本层不是单个文档：一角色一卡，卡的形状见下（唯一由工具维护的派生文件：）"
      : "该层文档应含以下小节（每个 ## 即一格，后续可单独 propose-design 那一格）：",
    ...head,
    ...(spec.style ? ["", spec.style] : []),
    "",
    spec.guide,
  ].join("\n");
}

export { LAYERS };
