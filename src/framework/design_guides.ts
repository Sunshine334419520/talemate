/**
 * 设计指南注册表：一份文档"怎么写才算好"——为什么写它、它要回答哪些问题、好例/反例、尺寸。
 *
 * 与旧的"结构规范"不同：这里没有必填小节，也不做形状校验。创作文档的形状由模型决定；只有
 * 机器要用的数据（章型、承诺状态、知识、场景）才放到独立账本/元数据。
 *
 * 匹配按项目相对路径 glob（`permission.match`，`*` 跨 `/`），更具体的模式胜出——卷纲的模式也
 * 命中序列纲的路径，靠长度分开，不靠表序。
 */
import { match } from "../permission";
import { CARD_DIR } from "./characters";

export interface DesignGuide {
  id: string;
  /** 路径 glob */
  match: string;
  /** 给模型看的地址式样；目录入口没有 */
  target?: string;
  title: string;
  /** 提案标签（给用户看的短名）；不填就用文档自己的 H1 */
  label?: string;
  purpose: string;
  questions: string[];
  examples: string[];
  antiPatterns: string[];
  size?: string;
  suggestedShape?: string;
  /** `list` 里这一类怎么占一行：铺标题，还是取首句 */
  summary: "headings" | "lead";
}

const WORK_METHOD = [
  "工作法：",
  "1) 先让用户用自己的话讲，别逐格盘问；",
  "2) 按指南里的问题整理成一版草稿；没想好的写（待定），保留用户原话里的细节与味道；",
  "3) 用 propose-design 交给用户看（要先在草稿模式里）；这一步不写盘，本回合到此为止；",
  "4) 用户同意 → apply-design 落盘；要改 → 改完再提一次（改了内容必须重新提案）；",
  "5) 之后只动要改的那一段——用 edit，锚点就是那段原文；不必为改一处整篇重提；",
  "6) 文档一旦建立，后续先 read 再动。",
].join("\n");

export const GUIDES: DesignGuide[] = [
  {
    id: "core",
    match: "design/core.md",
    target: "design/core.md",
    title: "核心设定",
    label: "核心层",
    purpose: "这本书是什么、为什么值得写；它是常驻的方向约束，不是剧情梗概。",
    questions: [
      "一句话简介：谁（身份+处境）× 他要什么 × 挡着他的是什么。",
      "主角的内核：他想要什么、最怕什么、为什么是他？",
      "金手指/超常设定（若有）：能力是什么 + 硬边界（上限/代价/不可逆/触发条件）。",
      "这本书的题材、频道与声音：写文风卡的名字，不抄卡的内容。",
    ],
    examples: [
      "一句话简介：沈越，被逐出家族的前首席，靠一门不能见光的本事往回爬。\n金手指：能看见旧物上残留的“未完成遗言”；代价是每读一次，忘掉自己的一段记忆。\n文风：storytelling",
    ],
    antiPatterns: [
      "结局、主题升华、第二个句子；",
      "把人物卡、伏笔台账、卷纲抄进来；",
      "写“极具张力”“令人震撼”这类评价；",
      "把文风卡的内容整段抄进来（只写卡名）。",
    ],
    size: "建议半页到一页；核心层会被每轮注入，越短越贵。",
    summary: "headings",
  },
  {
    id: "world",
    match: "design/wiki/world.md",
    target: "design/wiki/world.md",
    title: "世界观总纲",
    label: "世界层",
    purpose: "这本书的舞台与规则：哪些约束每一场都成立；长尾拆专题页。",
    questions: [
      "空间与舞台：世界性质、主要舞台、时代与科技、人怎么从 A 到 B。",
      "规则与秩序：每一场都成立的规则 + 硬边界（上限/代价/不可逆）。",
      "术语表：生造词、专名：词 + 一句解释。",
      "一条事实只放一处；长尾拆 design/wiki/<题>.md，总纲里留一行指引。",
    ],
    examples: [
      "空间与舞台：一座被城墙围住的港城；夜宴在沈家老宅，座次按房头排。\n规则：二房不坐主桌；在族老面前动账册，等于当众撕破脸。\n术语：回响——旧物上残留的未完成执念。",
    ],
    antiPatterns: [
      "写具体案件、谁在掩盖什么（那是情节）；",
      "把规则怎么被主角利用写成剧情；",
      "总纲和专题页重复同一条规则；",
      "编年史式的历史堆砌。",
    ],
    size: "总纲建议 ≤30k 字；专题页按需拆分。",
    summary: "headings",
  },
  {
    id: "characters",
    match: `${CARD_DIR}*`,
    target: `${CARD_DIR}<名>.md`,
    title: "角色卡",
    purpose: "写一张“下一次写他时用得上的合同”，不是人物传记；每一笔都应改变某个选择或某句话。",
    questions: [
      "他想要什么？具体到能驱动行动。",
      "他最怕什么？恐惧决定压力下的选择。",
      "他绝不做什麼？否定式约束，防 OOC。",
      "他说话是什么声音？给一句可验伪的原话。",
      "他身上的矛盾是什么？这是选择的来源。",
      "他的能力/限制如何塑造选择？",
      "别人怎么称呼他？（别名/称谓）",
    ],
    examples: [
      "# 角色：林晚\n\n二房庶女，管着家里的账，却始终不被允许坐上主桌。\n\n她想要账册，不是为了钱，是为了让二房在族老面前没法再说她“只是个丫头”。\n她最怕被当成二房争产的棋子；所以先算账，再叫人。\n\n“二爷的账，什么时候轮到外人看了？”——她对二房以外的人，永远先问这一句。\n她绝不让人看见她哭。",
    ],
    antiPatterns: [
      "形容词堆（英俊、冷酷、聪明）；",
      "简历/年表（三岁丧母，七岁习武）；",
      "当前处境、在场/已故（那在 state/characters）；",
      "关系（谁欠谁、此刻盟友还是敌人）；",
      "没有一句可验伪的台词；",
      "把“他很强”写成技能列表。",
    ],
    size: "建议 300–1200 字，决策级。",
    suggestedShape: "可以几段散文，也可以分小标题；结构自定，回答得上问题即可。",
    summary: "lead",
  },
  {
    id: "outline",
    match: "design/outline/",
    title: "情节层（卷纲 + 序列纲）",
    purpose: "两个尺度的故事合同：一卷结束时什么必须为真；一小段结束时什么必须为真。",
    questions: [
      "卷纲：卷末状态、旧债/新债/禁揭、目标与阻力、序列功能；",
      "序列纲：功能、入口→出口、不可逆转折、承诺、写法约束。",
    ],
    examples: [],
    antiPatterns: [
      "没有“整本大纲”：主线归核心层，进度归卷纲/状态；",
      "写事件清单不写状态；",
      "写章号/节拍表。",
    ],
    size: "卷纲 1–2 页；序列纲 300–800 字。",
    summary: "headings",
  },
  {
    id: "outline-seq",
    match: "design/outline/vol_*/s*.md",
    target: "design/outline/vol_<N>/s<序号>.md",
    title: "序列纲",
    purpose: "这一小段的单元合同：入口和出口差在哪，哪一步不可逆，兑现/埋下什么，什么不能写坏。",
    questions: [
      "这一小段在卷里承担什么功能？推进哪条线程、兑现/埋下哪条承诺。",
      "它自己的问题是什么：谁想要什么、谁挡着、失败会失去什么。",
      "入口 → 出口差在哪？出口如何引出下一段的问题。",
      "哪一步不可逆？谁选择、代价是什么。",
      "兑现哪条旧承诺、埋下哪条新承诺、什么不能提前揭。",
      "哪几处不能写坏：世界规则、战力上限、知识边界。",
      "体量大概多少（参考，不是章数）。",
    ],
    examples: [
      "功能：给沈越一个进内城的理由，并让林晚第一次怀疑他。\n\n入口：沈越有夜宴请帖，但没有账册；林晚以为他是二房的人。\n出口：沈越拿到账册抄本，林晚知道他撒谎；“合作”变成互相利用。\n\n不可逆转折：沈越为保账册，把林晚推出去挡了族老的人；她记住了。\n承诺：埋下“账册是抄本”；兑现“林晚查沈越的底”。\n\n写法约束：夜宴座次按房头；二房不坐主桌；沈越不能在这里用遗言。\n体量：3–5 章。",
    ],
    antiPatterns: [
      "事件清单（主角遇到老乞丐）；",
      "章数/节拍表/镜头调度；",
      "把“功能”写成事件；",
      "入口和出口状态相同。",
    ],
    size: "建议 300–800 字。",
    summary: "lead",
  },
  {
    id: "outline-vol",
    match: "design/outline/vol_*.md",
    target: "design/outline/vol_<N>.md",
    title: "卷纲",
    purpose: "这一阶段的阶段合同：卷末什么不可逆地变了，欠读者什么，什么不能提前揭。",
    questions: [
      "这一卷的独立故事问题是什么？为什么是现在？和上一卷的差异、主线增量。",
      "谁想要什么、谁挡着、失败会失去什么；升级轴、失败代价、本卷上限。",
      "卷末什么状态必须为真？用状态写，不用事件写；至少一轴不可逆。",
      "旧债、新债、禁揭是什么？",
      "这一卷分几段、每段的功能是什么？卷末高潮落在哪一段？",
      "情绪节奏是什么？（参考，不是合同）",
    ],
    examples: [
      "这一卷的独立问题是“沈越能不能在沈家站住脚”，不是“他能不能报仇”。\n\n卷首他是被逐出家门的弃子；卷末他成了族老不得不承认的账房先生，但代价是林晚知道遗言。\n\n目标：查清账册。阻力：二房与族老。升级轴：从查账到被当成争产的人。\n失败代价：再次被逐出，且失去林晚。本卷上限：不能碰十年前车祸的幕后。\n\n旧债：母亲留下的那封信。新债：账册是抄本。禁揭：十年前车祸的幕后。\n\n序列：混进夜宴（拿账册）→ 账册失窃（被栽赃）→ 族老审账（反转）→ 卷末选择（烧掉抄本保林晚）。\n\n情绪：压抑里偶尔的爽点；卷末不靠打赢，靠选择。",
    ],
    antiPatterns: [
      "事件清单；",
      "章号；",
      "承诺台账的实际状态（那在 state/foreshadowing）；",
      "只写打赢/打输，不写代价；",
      "“这一卷很精彩”这类评价；",
      "把序列写成每章的节拍表。",
    ],
    size: "建议 1–2 页。",
    summary: "headings",
  },
];

/** 按路径取指南：命中的模式里更长者胜出（与权限/invariants 同一套 glob）。 */
export function guideFor(name: string): DesignGuide | undefined {
  let best: DesignGuide | undefined;
  for (const g of GUIDES) {
    if (!match(name, g.match)) continue;
    if (best === undefined || g.match.length > best.match.length) best = g;
  }
  return best;
}

function isContainer(g: DesignGuide): boolean {
  return g.match.endsWith("/");
}

function renderOne(g: DesignGuide): string {
  return [
    `【${g.title}${g.target === undefined ? "" : ` · path: ${g.target}`}】`,
    `为什么要写它：${g.purpose}`,
    "",
    "一份好的文档回答：",
    ...g.questions.map((q) => `- ${q}`),
    ...(g.examples.length ? ["", "范例：", ...g.examples.map((e) => e)] : []),
    "",
    "别写：",
    ...g.antiPatterns.map((a) => `- ${a}`),
    ...(g.size === undefined ? [] : ["", `尺寸：${g.size}`]),
    ...(g.suggestedShape === undefined ? [] : ["", `结构建议（可不用）：${g.suggestedShape}`]),
    "",
    WORK_METHOD,
  ].join("\n");
}

const SEP = "\n\n────\n\n";

/** 目录入口：把名下每种文档的指南一并返回。 */
export function renderGuide(name: string): string | undefined {
  const guide = guideFor(name);
  if (guide === undefined) return undefined;
  if (!isContainer(guide)) return renderOne(guide);
  const kids = GUIDES.filter((g) => g !== guide && g.match.startsWith(guide.match)).sort(
    (a, b) => a.match.length - b.match.length,
  );
  return [renderOne(guide), ...kids.map(renderOne)].join(SEP);
}