/**
 * 写手 prompt 构造器 + 章规划 prompt + 整章生成 prompt（带"写法规格"）。
 *
 * 设计方向：
 * - 结构由"章规划"（节拍序列）构造出来，生成时按拍落地。
 * - 质量由"写法规格"（STRUCTURE_SPEC 结构/剧情 + PROSE_SPEC 文笔渲染）在做生成时直接要求，而不是事后审。
 * - 三层级模型：文风（styleCard 可选）归文风卡；角色风格归企划书人物卡；技法（写法规格）挂在生成步。
 */

export interface WriterInput {
  caseTitle: string;
  ideaBook: string;
  outline: string;
  chapterNum: number;
  chapterBrief: string;
  /** 内置文风卡（experiments/styles/*.md），提供则写入 prompt；不提供则无文风要求 */
  styleCard?: string;
  /** 只写开篇 400-500 字（文风对比用） */
  openingOnly?: boolean;
}

/**
 * 通用写作规范（跨题材恒定，写手 prompt 始终携带）。
 * 只放"改写作价高、各题材都成立"的卫生规则；题材规则归体裁包/细纲，声口归文风卡。
 */
const UNIVERSAL_STANDARDS = [
  "【通用写作规范】",
  "- 无 AI 腔：禁用套话黑名单（涌起、仿佛、一抹、嘴角勾起、心中闪过、眼中闪过一丝、空气仿佛凝固、内心五味杂陈……）。",
  "- 不堆砌形容词和副词（缓缓、轻轻、冷冷、深深地）。",
  "- 不重复信息：同一个判断或同一句话，不换着说法写两遍。",
].join("\n");

export function writerPrompt(input: WriterInput): { system: string; user: string } {
  // 通用 system prompt：只定义角色与行为 + 恒定通用写作规范，不含题材规则
  const system = [
    "你是 talemate 的小说写手 agent。根据用户提供的材料，写出符合要求的章节正文。",
    "",
    "行为：",
    "- 写作前通读材料；材料中的要求必须逐条遵守。",
    "- 只输出正文本身，不输出标题、解释、思考过程或任何元信息。",
    "- 拿不准时按最克制、最平常的写法。",
    "",
    UNIVERSAL_STANDARDS,
  ].join("\n");

  // 可选块：文风卡。不提供时就只剩【输出要求】，写手自由发挥。
  const optionalBlocks: string[] = [];
  if (input.styleCard) {
    optionalBlocks.push(
      "",
      "【文风】（文风卡。逐条执行；范例是声音示范，模仿节奏与词汇，不模仿内容）",
      "==========",
      input.styleCard,
      "==========",
    );
  }

  const lengthNote = input.openingOnly
    ? "（本次只写本章开篇 400-500 字，到第一个悬念出现为止，用于文风对比）"
    : `（本次写第 ${input.chapterNum} 章正文 2000-3000 字）`;

  const parts = [
    `【作品】${input.caseTitle}`,
    `【企划书】\n${input.ideaBook}`,
    `【前 3 章细纲】\n${input.outline}`,
    input.openingOnly
      ? `【本章任务】只写本章开篇（前 400-500 字）：${input.chapterBrief}`
      : `【本章任务】写第 ${input.chapterNum} 章：${input.chapterBrief}`,
    ...optionalBlocks,
    `【输出要求】${lengthNote} 只输出正文，不要任何解释、标题或元信息。`,
  ];

  return { system, user: parts.join("\n\n") };
}

/** ─── 章规划：切节拍序列（生成前，替代事后审判） ─── */
export interface ChapterPlanInput {
  caseTitle: string;
  ideaBook: string;
  outline: string;
  chapterNum: number;
  chapterBrief: string;
  /** 上一章结尾钩子（章末钩子回收）；第 1 章无则省略 */
  previousHook?: string;
  /** 文风的结构约束行（见 extractStyleConstraint）；有则让规划也遵守视角/基调等硬规则 */
  styleConstraint?: string;
}

export function chapterPlanPrompt(input: ChapterPlanInput): { system: string; user: string } {
  const system = [
    "你是资深小说编辑，为一个章做“读者体验”工程规划。不要提前写正文，而是把本章任务工程化成一张【节拍序列】（读者体验的施工图），作为后续写作的蓝图。",
    "",
    "【切分要求】",
    "- 先定【中枢问题】：这章只绕着一件事担心，一句话；全章每一拍都服务它，不服务的拍删掉。",
    "- 每个节拍是自足单位：有功能（铺垫/突发/反应/转折/收尾/钩子），有变化（起于状态 A → 落到状态 B，B≠A）。",
    "- 宁少勿多：默认 3-4 个节拍，最多 5 个；拍少、每拍写深 > 拍多、每拍敷衍。",
    "- 章节是“变”不是“平推”：整章至少让一样压力上升（代价更重/关系移位/离目标更近一步/麻烦变大）。",
    "- 拍与拍因果相连：上一拍的落点是下一拍的起因；或最后一拍抛一个非答不可的问题。",
    "- 读者效果优先：每拍写【读者此刻】应感到/应知道/应猜错什么——是读者体验，不是作者意图。",
    "- 每拍给一个【落地的具体】：一个换不掉的画面/对话/动作（有材质/形状/瑕疵）；换成泛泛说法读者察觉不出，就不是细节。",
    "- 信息差：每拍标【信息差】——这拍揭了“谁不知道的什么”、谁瞒着谁；揭露只依赖前文已出现的信息，不引入“此刻才冒出来”的新规则。",
    "- 书尺度：每拍判一句——在“埋”（为后续造钩/造包袱）还是在“还”（兑现前文埋的）；在节拍里标出。",
    "- 环账本编号纪律：问题一律用〔Q1〕〔Q2〕…，环账本与各拍【信息差】里的〔Q〕必须完全一致；禁止自创 P1/Q0 等混用编号。",
    "- 篇幅：整份规划控制在 1200—1800 字（节拍 3-4 个即可，每拍点到为止；别写成章评、别堆分析）。",
    "- 最后一拍 = 章末钩子（决定/发现/误判/代价 四选一），断在情绪最高点；同时标【章尾留】那个未答复的问题。",
    input.previousHook ? "- 上一章钩子应在本章前 30% 回收（见下方【上一章钩子】）。" : "",
    "",
    "【输出格式】（严格按此结构；环账本用〔Q1〕式编号且与各拍【信息差】完全一致；整份控制在 1200—1800 字）",
    "【第 <N> 章·体验工程图】<作品名>",
    "**中枢问题**：这章绕着一件事担心——<一句话，每个拍都服务它>",
    "**环账本**：开环〔Q1,Q2〕→ 闭环〔Q1〕→ 新开〔Q3〕→ 章尾留〔Q3〕",
    "**章末钩子**：决定/发现/误判/代价 四选一 + 落点一句话",
    "**放大点**：哪里慢镜头几百字（关键动作/决定/爽点）；哪里半句带过。",
    "**这章不许**：2-3 条反套路的硬禁令（打断模板化写法）。",
    "",
    "**节拍序列**",
    "1. 【功能】<单句概括>",
    "    起：<状态A，不展开> → 落：<状态B，B≠A>",
    "    读者此刻：<应感到/应知道/应猜错什么>",
    "    落地的具体：<一个换不掉的画面/对话/动作，不是概括>",
    "    信息差：<这拍揭了“谁不知道的什么”；谁瞒着谁>",
    "    书尺度：埋（为后续钩）/ 还（兑现前文）",
    "2. ……",
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `【作品】${input.caseTitle}`,
    `【企划书】（人物/设定，判断节拍成立与否）\n${input.ideaBook}`,
    `【前 3 章细纲】\n${input.outline}`,
    input.previousHook ? `【上一章钩子】（本章前 30% 需回收）\n${input.previousHook}` : "",
    `【本章任务】${input.chapterBrief}`,
    input.styleConstraint ? `【文风·结构约束】（规划节拍时遵守这些视角/基调/详略硬规则）\n${input.styleConstraint}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

/**
 * 结构规格（STRUCTURE_SPEC）：草稿步主用。把"结构/剧情对"变成可执行指令。
 * 这些机制是"好"的必要条件；某拍功能决定主推哪条，其余只求不违反。
 * 渲染（概括→具象 / 情绪外化 / 压缩重复）单独放 RENDER_SPEC，只喂精修——
 * 草稿不背它，避免"既要结构对又要文笔好"的自相矛盾。
 */
const STRUCTURE_SPEC = [
  "【写作要旨：把“好看”执行出来，不是把话讲顺】",
  "不要只追求情节讲顺，要同时做到下面每一条；本章按功能拍推进，主推哪条由该拍功能决定。",
  "",
  "一、代入被锚定：主视角要有明确目标、且在障碍前做了“在场取舍”，不是“被推着走”。",
  "二、期待被点燃：每拍要么开环（抛一个未解决的问题/欲望），要么闭环（兑现前文）；",
  "    整章至少开一个大环，章尾留一个未完成环（钩子）。",
  "三、节奏被选择：镜头要有远近变化——一句话能带过的时间就一句，值得放大的一瞬间（关键动作/决定/爽点）用几百字慢慢磨；全章不要一个力度到底。",
  "四、爽点要导引：憋屈 → 展示 → 反馈具名（别人当面承认/看见/被打脸）→ 主角回应；缺了“反馈具名”爽就放空炮，这段每一步都要落地。",
  "五、人物要撑起：角色有一致性 + 缺陷 + 高成本选择；配角即便反面也为自己利益做过选择，不为让主角赢而变蠢；任何人在场景里“毫无代价地让路”就是工具人。",
  "六、信息要设计：该藏藏、该揭揭，读者知道的和角色知道的要有差；揭露只依赖前文已出现的信息，不引入“此刻才冒出来”的新规则（机械降神）。",
  "",
  "【硬性禁忌】（结构/内容卫生，草稿与精修共用）",
  "- 禁止作者旁白式讲设定（“他是个…的人”）——用动作/选择/对话带出。",
  "- 禁止作者旁白式讲情绪（“她怒火中烧”）——用身体动作/细节外化。",
  "- 禁止对话报户口（“我是学机械的所以我懂机械”）——用道具/行为具象化。",
  "- 禁止视角跳神——整段保持主视角的所知。",
].join("\n");

/**
 * 文笔规格（PROSE_SPEC）：与 STRUCTURE_SPEC 一同用于单次成文，把"好"落到句子上。
 * 结构正确性由 STRUCTURE_SPEC（机制一~六）+ 体验工程图承担；这里只管句子的具象/外化/节奏/声口/卫生。
 */
const PROSE_SPEC = [
  "【文笔要旨：把“好”落在句子上】",
  "以下每一条都要做到；本章按功能拍推进，主推哪条由该拍功能决定。",
  "",
  "一、概括→具象：凡一个细节能被换成泛泛说法而读者察觉不出，就不是细节，是填充；要“换不掉的具象”（有材质/形状/瑕疵/反直觉处）。",
  "二、情绪外化：不写“他感到/他怒了/心里一沉”，用身体动作、细节、对话让读者自己得出。",
  "三、节奏被选择：照下方【体验工程图】的【放大点】——该慢镜头处（关键决定/动作/爽点）磨出两三百字，该一笔带过的（背景/转场）一句收掉；不要每个地方一个力度。",
  "四、声口：按下方【文风】逐条贴声音（名词领句/白话/短句…），只模仿节奏与措辞，不模仿内容；无文风卡时按最克制平常的写法。",
  "",
  "【硬性禁忌】",
  "- 不用 AI 腔（涌起/仿佛/一抹/嘴角勾起/心中闪过/五味杂陈…）；不无病呻吟地堆形容词副词——每个都要有用、换不掉。",
  "- 不作者旁白式讲设定、讲情绪（用动作/选择/对话带出）；不对话报户口。",
  "- 不视角跳神——整段保持主视角的所知；不引入“此刻才冒出来”的新设定、新信息（机械降神）。",
  "- 不重复信息、不啰嗦：同一个判断/同一句话不换着说法写两遍。",
].join("\n");

/**
 * 从文风卡抽出"结构约束行"（只能喂给草稿/plan 的那层）。
 * 文风卡分两层：约束层（视角/时态/基调/详略/禁忌——决定"拍和内容"选什么）与声音层（词汇/句长/修辞——精修用）。
 * 优先读卡里手写的 "> 结构约束：..." 声明（最准）；否则启发式兜底。
 */
export function extractStyleConstraint(styleCard: string): string {
  // 1) 作者声明优先：文风卡里留一行 "结构约束：..."。容忍 结构约束 与冒号之间的说明文字，冒号后才是约束正文。
  const declared = styleCard.match(/结构约束[^：:\n]*[：:]\s*(.+)$/m)?.[1]?.trim();
  if (declared) return declared;

  // 2) 启发式兜底：只保留"约束层"信息，丢掉声音层（句式节奏/词汇/修辞/衔接/声音范例）
  const soundHeads = /句式|词汇|修辞|衔接|范例|示范|声音/;
  const structHeads = /视角|叙述距离|详略|基调|反例|定位/;
  const out: string[] = [];
  // 顶部 > 注记（一句话定位 / 叙事视角 / 人称）
  for (const raw of styleCard.split("\n")) {
    const l = raw.trim();
    if (/^>/.test(l) && /一句话定位|叙事视角|第三人称|人称|全知|限知|视角/.test(l) && !soundHeads.test(l)) {
      out.push(l.replace(/^>\s*/, ""));
    }
  }
  // ## 小节里取约束层正文
  let inStruct = false;
  for (const raw of styleCard.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (/^##\s/.test(l)) {
      inStruct = structHeads.test(l) && !soundHeads.test(l);
      continue;
    }
    if (inStruct && !soundHeads.test(l) && /第三人称|人称|全知|限知|视角|基调|快进|慢镜头|重对话|轻陈述|不|别|禁|违/.test(l)) {
      out.push(l.replace(/^[-*>\s]+/, "").replace(/\*\*/g, ""));
    }
  }
  return [...new Set(out)].join("；").slice(0, 480);
}

export interface ChapterWriteInput {
  caseTitle: string;
  ideaBook: string;
  outline: string;
  chapterNum: number;
  chapterBrief: string;
  /** 章规划的节拍大纲全文（plan_ch<N>.md） */
  beatsPlan: string;
  styleCard?: string;
}

export function chapterWritePrompt(input: ChapterWriteInput): { system: string; user: string } {
  const system = [
    "你是 talemate 的小说写手 agent。根据企划书、前 3 章细纲与本章【体验工程图】，一次性写出整章正文（2000-3000 字）。",
    "",
    STRUCTURE_SPEC,
    "",
    PROSE_SPEC,
    "",
    "行为：",
    "- 严格按【体验工程图】的拍序写，每一拍都落地、不跳拍不并拍；照【放大点】【这章不许】执行。",
    "- 每一拍都要打中它标注的【读者此刻】——这是本章的靶子，不是把情节讲顺。",
    "- 只输出正文本身，不输出标题、章节名、解释、思考过程或任何元信息。",
    "- 拿不准时按最克制、最平常的写法。",
  ].join("\n");

  const optionalBlocks: string[] = [];
  if (input.styleCard) {
    optionalBlocks.push(
      "",
      "【文风】（文风卡。逐条执行；范例是声音示范，模仿节奏与词汇，不模仿内容）",
      "==========",
      input.styleCard,
      "==========",
    );
  }

  const parts = [
    `【作品】${input.caseTitle}`,
    `【企划书】（人物/设定）\n${input.ideaBook}`,
    `【前 3 章细纲】\n${input.outline}`,
    `【本章任务】第 ${input.chapterNum} 章：${input.chapterBrief}`,
    `【本章·体验工程图】（严格按拍序写，每一拍都落地；放大点/这章不许在这里）\n${input.beatsPlan}`,
    ...optionalBlocks,
    `【输出要求】一次性写完整章正文 2000-3000 字；只输出正文，不要标题、章节名或任何元信息、思考。`,
  ];

  return { system, user: parts.filter(Boolean).join("\n\n") };
}

