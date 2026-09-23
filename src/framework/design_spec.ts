/**
 * design-spec：结构规范——哪份文档该有哪些小节、每格装什么、成稿做法。
 *
 * **两张表，两个匹配键**：
 *   `DESIGN_SPECS` 按 `LayerId` 登记，`file` 是**精确文件名**——主文档是一个固定文件的层。
 *   `DOC_SPECS`    按**路径模式**登记——一个层下面有几种文档时用（情节层：卷纲 / 序列纲）。
 *
 * 分成两张是因为两者答的不是同一个问题：层的规范还要说"这层是什么"（`layers.ts` 管显示名
 * 与顺序，这里管结构）；文档的规范只关心"这条路径的文档长什么样"。混成一张的代价，看
 * `proposal.specFor` 就明白——它得同时回答"这份文档按哪几格审阅"。
 *
 * - 懒建：目标文档平时不存在，用户要完善时才取规范、成稿落盘。
 * - 结构与内容分离：这里只定义"长什么样"；文档文件一旦建立即内容与真相。
 */
import { CHARACTER_FIELDS, IDENTITY_KEY, PROFILE_KEYS } from "./characters";
import { LAYERS, type LayerId } from "./layers";

/** 必有格的 `### 标题` 枚举——从 characters.CHARACTER_FIELDS **派生**，不在这里另抄一份。 */
const REQUIRED_SECTIONS = CHARACTER_FIELDS.map((f) => `### ${f.label}`).join(" / ");

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
  "通篇：断言式、条目优先。不写剧情事件、不写台词、不写抒情和解释性铺陈，不出现自我评价（「极具张力」「令人震撼」这类）。这是给写手当约束用的，不是给读者看的简介。";

export interface DesignSpec {
  /**
   * 判别式。两处靠它分支：`proposal.labelOf` 决定标签取层名还是文档自己的 H1；
   * `renderOne` 决定写入口给 `layer: <id>` 还是 `name: <路径>`。
   */
  kind: "layer" | "doc";
  /** 归属层——`design-spec` 按层聚合、取层名都用它 */
  layer: LayerId;
  title: string;
  sections: DesignSection[];
  /** 通篇形制（见 DOC_STYLE）；只有"文档型"的层有 */
  style?: string;
  guide: string; // 成稿/补缺做法（给模型看的工作法）
}

/** 主文档是一个固定文件的层。`file` 是**精确**匹配键；目录型的层以 "/" 结尾，永不匹配真实文件。 */
export interface LayerSpec extends DesignSpec {
  kind: "layer";
  file: string;
}

/** 按**路径模式**登记的文档。`match` 是匹配键，`target` 给人看的路径式样（design/ 相对）。 */
export interface DocSpec extends DesignSpec {
  kind: "doc";
  match: RegExp;
  target: string;
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

export const DESIGN_SPECS: Record<LayerId, LayerSpec> = {
  // core：小说介绍（写作方向不变量），常驻、一切层依赖它。
  // 主角内核（想要/最怕/为什么是他）归 characters 主角卡；爽点排布归 outline；世界观归 wiki/world.md，均不并入本层。
  core: {
    kind: "layer",
    layer: "core",
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
    kind: "layer",
    layer: "world",
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
    kind: "layer",
    layer: "characters",
    file: "characters/",
    title: "人物层（一角色一卡）",
    // 本层不是"一个文档若干 ##"，所以没有规范小节——卡的形状在 guide 里（卡内是 ###）。
    // 名单（有哪些人、必有格齐没齐、卡上还有哪些自由小节）由 list-designs 现算，没有派生文件。
    sections: [],
    guide: [
      "一角色一卡 characters/<名>.md = `# 角色：<名>` + 若干 `###` 小节，分两部分：",
      `  **必有五格**（整篇提案缺一即拒，没定的写（待定））：${REQUIRED_SECTIONS}；`,
      "  **自由长尾**：用户提出要加什么就加什么（如「回响」这类这个世界特有的格）。工具原样保留，不催、不校验；",
      "  卡上只许 `###`——出现 `##` 会让卡里所有小节从逐格审阅里消失，工具会直接拒。",
      "写法：",
      `  · 「基本档案」是**逐行「键：值」**，键固定：${PROFILE_KEYS.join(" / ")}（例：\`性别：男\`）。名单取「${IDENTITY_KEY}」那一行；`,
      "  · 「性格与矛盾」写成「既…又…」的矛盾，不是形容词堆；「说话方式」给一句『声音范例』原文，别只写性格形容词；",
      "  · 只写个空标题能过骨架校验，但名单里会显示为待补——必有格要**真的有内容**；",
      "状态不在卡上：「在场/已故、此刻处境」这类随章变化的东西归 design/state/（尚未落地），别写进卡。",
      "工作法：",
      "1) 建卡与整篇重写走 propose-design 带 name:\"characters/<名>.md\"（三向：用户接受 / 拒绝 / 提意见，要先在草稿模式里）。**没有专用的角色工具**——改一格用 edit（锚点就是那一格的正文），删卡用 delete；",
      "2) 先 read-design 看当前卡再动手；改一格只动那一格，其余小节（含自由长尾）字节一个不动；",
      "3) 别逐格盘问——让用户用自己的话讲；拿不准声音时用**试镜**：让 ta 开口给一句台词，比问「性格是什么」有效；",
      "4) 用户说的与卡冲突时，把冲突摆出来问一句：改卡还是改戏？（卡是用户签过的合同，不是摆设）；",
      "5) 一角色一卡；名单（有哪些人、必有格齐没齐、卡上还有哪些自由小节）由 list-designs 现算，没有需要手改的总表；删角色用 delete，它会先把「这个名字还在哪儿出现」摆出来，级联清理你自己用 edit 做。",
    ].join("\n"),
  },
  // outline：**没有"整本大纲"这个文档**。全本走向是 core 的一句话简介加上各卷卷纲**能算出来的**
  // 东西，另存一份就是迟早脱节的缓存——脱节的缓存比没有更糟，它会误导写手。所以本层的 file 是目录、
  // sections 为空，真正的形状在 DOC_SPECS 里按路径登记（卷纲 / 序列纲）。与 characters 同构。
  outline: {
    kind: "layer",
    layer: "outline",
    file: "outline/",
    title: "情节层（卷纲 + 序列纲）",
    sections: [],
    guide: [
      "本层不是单个文档，是两个尺度、各一个文件：",
      "  · **卷纲** design/outline/vol_<N>.md —— 一卷 = 一个完整的故事（自己的目标、冲突、收束）。",
      "  · **序列纲** design/outline/vol_<N>/s<序号>.md —— 一个序列 = 一个情节单元。",
      "  两者的形状见下（design-spec 带 name 可单独取其一）。",
      "没有「整本大纲」这个文档：主线是什么归核心层的一句话简介，走到哪了归各卷卷纲——都由它们",
      "算出来。章计划（这一批写哪几章）也不进 design/：它不经过用户拍板，是拍板之后的执行细节。",
      "工作法与其余层同：先让用户用自己的话讲 → 整理成草稿 → propose-design 摆给他看、本回合到此",
      "为止 → 认可后 apply-design。文档一旦建立，后续以文件当前内容为准（先 read-design 再动）。",
    ].join("\n"),
  },
};

/** 卷纲：一卷一个文件。五格，见下。 */
const VOL_SPEC: DocSpec = {
  kind: "doc",
  layer: "outline",
  match: /^outline\/vol_\d+\.md$/,
  target: "outline/vol_<N>.md",
  title: "卷纲",
  style: DOC_STYLE,
  sections: [
    {
      heading: "本卷在全局的位置",
      write: "承接上一卷的什么、把主线推到哪。一两句。",
      avoid: "复述上一卷的剧情；解释主线是什么（核心层里已有）。",
      form: "断言句，不展开。",
    },
    {
      heading: "本卷目标与阻力",
      write: "主角这一卷要拿到 / 达成什么 + 谁或什么挡着 + 阻力比上一卷强在哪。",
      avoid: "具体场次、谁在第几章出场；主角会怎么做（那是序列的事）。",
      form: "目标一句、阻力一句、升级一句。",
    },
    {
      heading: "本卷的情绪曲线",
      write:
        "读者这一卷的情绪怎么走（起 / 压 / 爆 / 落大致落在哪几段）+ 爽点是哪种类型（打脸 / 获得 / 被认可 / 成长）。",
      avoid: "「高潮迭起」「爽点密集」这类评价词——要写就写清是哪种爽、落在哪一段。",
      form: "条目式，一条一段。",
    },
    {
      heading: "卷末状态",
      write: "写完这一卷，主角和世界处于什么状态，与卷首比变了什么。",
      avoid: "事件（「主角打败了 X」）。事件可以换，状态必须保住。也别写悬念怎么解。",
      form: "「从…变成…」这类状态断言。",
    },
    {
      heading: "本卷的序列",
      write: "大致分几段、每段一句话方向；末尾给本卷的预估字数。",
      avoid: "展开每段细节（写到那个序列再展开，各自一个文件）；不写章号——章数是写出来的结果。",
      form: "一段一行，最后一行给体量范围。",
    },
  ],
  guide: WORK_METHOD,
};

/**
 * 序列纲：整篇散文，**不分小节**。所以 `sections` 为空、形状全在 guide 里——与角色卡同路。
 * 逼它分格是削足适履：一个序列本来就该一口气说完，而"必含 A、B、C"式的清单会把事件钉死，
 * 偏偏只有功能稳定、事件随时可换。
 */
const SEQ_SPEC: DocSpec = {
  kind: "doc",
  layer: "outline",
  match: /^outline\/vol_\d+\/s\d+\.md$/,
  target: "outline/vol_<N>/s<序号>.md",
  title: "序列纲",
  sections: [],
  guide: [
    "序列纲：一个情节单元一个文件。**整篇散文，不分小节**——一个序列本来就该一口气说完。",
    "",
    "写四件事，用大白话，别铺陈：",
    "1) 这个序列讲什么、在卷里承担什么。一两句。",
    "2) 大致怎么走。松散的事件线——写到哪一场具体怎么演，留给写手。",
    "3) 写的时候哪几处不能写坏（哪个人物要立住、哪里的节奏要压住、哪里别太顺）。",
    "4) 预估体量（多少字，给范围）。",
    "",
    "别写：",
    "- 别列「必含 A、B、C」的清单。清单把事件钉死，而事件随时可以换、只有功能稳定。要写就写功能",
    "  （「给主角一个进内城的理由」），别写事件（「主角遇到老乞丐」）。",
    "- 别写具体台词、场景调度、章号。",
    "- 别抄核心层 / 世界观 / 人物卡里已有的设定——引用，别复制。",
    "- 别写评价词（「精彩」「有张力」）。这是给写手当约束的，不是给读者看的简介。",
    "- 没想好的写（待定），别编。",
    "",
    "长度：几百字到一千字。写到两千字，说明你在替写手写正文了。",
    "",
    "工作法：先让用户用自己的话讲 → 整段写成草稿 → propose-design 摆给他看、本回合到此为止 →",
    "认可后 apply-design。改一处也是整篇重提（它不分格）；文档一旦建立先 read-design 再动。",
  ].join("\n"),
};

/** 情节层的两种文档。**顺序即推荐顺序**：先有卷，才有卷里的序列。 */
export const DOC_SPECS: DocSpec[] = [VOL_SPEC, SEQ_SPEC];

/** 一格的规范：三行（写 / 别写 / 写成）。 */
function renderSection(s: DesignSection): string[] {
  return [
    `  ## ${s.heading}`,
    `     写：${s.write}`,
    ...(s.avoid ? [`     别写：${s.avoid}`] : []),
    ...(s.form ? [`     写成：${s.form}`] : []),
  ];
}

/**
 * 渲染一份规范。`writeKey` 是**写入口**——propose-design/apply-design 靠它知道往哪写：
 * 层的规范给 `layer: <id> · 目标 <路径>`，文档的规范给 `name: <路径>`；目录型的层没有固定目标文件，不给。
 */
function renderOne(spec: DesignSpec, writeKey: string): string {
  const shape = spec.sections.length
    ? [
        "该文档应含以下小节（每个 ## 即一格，后续可单独 propose-design 那一格）：",
        ...spec.sections.flatMap(renderSection),
      ]
    : // 不分格的文档（角色卡、序列纲）：形状全在 guide 里。**不能**只说"应含以下小节"然后空着。
      ["本文档不分小节——形状见下。"];
  return [
    `【${spec.title}${writeKey ? ` · ${writeKey}` : ""}】`,
    ...shape,
    ...(spec.style ? ["", spec.style] : []),
    "",
    spec.guide,
  ].join("\n");
}

/** 层的写入口。目录型的层（characters / outline）主文档不是一个文件，没有固定路径可给。 */
function layerWriteKey(spec: LayerSpec): string {
  return spec.file.endsWith("/") ? "" : `layer: ${spec.layer} · 目标 design/${spec.file}`;
}

/**
 * 某一层的全部规范：层自己的 + **它名下的文档规范**（情节层 → 层级说明 + 卷纲 + 序列纲）。
 * 一次调用就让模型看清这一层有哪几种文档，不用它自己猜有几个。
 */
export function renderDesignSpec(id: LayerId): string {
  const blocks = [renderOne(DESIGN_SPECS[id], layerWriteKey(DESIGN_SPECS[id]))];
  for (const doc of DOC_SPECS.filter((d) => d.layer === id)) {
    blocks.push(renderOne(doc, `name: ${doc.target}`));
  }
  return blocks.join("\n\n────\n\n");
}

/** 按路径取**某一份文档**的规范（design-spec 的 name 入口）。没登记 → undefined，由调用方给自愈文案。 */
export function renderNamedSpec(name: string): string | undefined {
  const doc = DOC_SPECS.find((d) => d.match.test(name));
  return doc ? renderOne(doc, `name: ${name}`) : undefined;
}

export { LAYERS };
