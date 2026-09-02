/**
 * 写手 / 审判（三遍式：拆情节 → 逐情节深审 → 汇总）的 prompt 构造器。
 * 独立上下文的保证：审判只拿 原文 + 判据 + 企划书 + 本章任务，看不到写手如何构思。
 */

export interface WriterInput {
  caseTitle: string;
  ideaBook: string;
  outline: string;
  chapterNum: number;
  chapterBrief: string;
  previousDraft?: string;
  critique?: string;
  /** 可选写作标准（判据）。不提供则不写入 prompt——写手自由发挥 */
  criteria?: string;
  /** 内置文风卡（experiments/styles/*.md），提供则写入 prompt；不提供则无文风要求 */
  styleCard?: string;
  /** 只写开篇 400-500 字（文风对比用） */
  openingOnly?: boolean;
}

/**
 * 通用写作规范（跨题材恒定，写手 prompt 始终携带）。
 * 只放"改写作价高、各题材都成立"的卫生规则；题材规则归体裁包/判据，声口归文风卡。
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

  // 可选块：写作标准（判据）+ 文风卡。都不提供时，写作要求只剩【输出要求】，写手自由发挥。
  const optionalBlocks: string[] = [];
  if (input.criteria) {
    optionalBlocks.push("【写作标准】（必须逐条遵守）", "==========", input.criteria, "==========");
  }
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
  if (input.previousDraft) {
    parts.push(`【你正在重写】上一版稿：\n---\n${input.previousDraft}\n---`);
    parts.push(
      `【批评者报告】（只改其中优先级最高的问题，顺序：先结构→场景→句子，不要全盘推倒）：\n${input.critique}`,
    );
  }

  return { system, user: parts.join("\n\n") };
}

/** ─── 审判第一遍：拆情节 ─── */
export interface SegmentInput {
  caseTitle: string;
  ideaBook: string;
  chapterNum: number;
  chapterBrief: string;
  /** 已标段落号 [N] 的正文 */
  draft: string;
}

export function segmentPrompt(input: SegmentInput): { system: string; user: string } {
  const system = [
    "你是资深小说编辑。下面是一章正文，每段已标号 [N]。请把它拆成一个个【情节单元】——每个单元是一个自足的场景/节拍，有明确功能，内部有状态变化。",
    "",
    "切分依据：",
    "- 一个情节内部通常有变化：起于目标/问题 → 遇阻碍 → 出转折/决定 → 落到新状态。没变化的串段不该单独成情节。",
    "- 功能标签自取（铺垫/突发/反应/转折/收尾/钩子 或自行概括），要能看出它在这章里干什么。",
    "",
    "【输出格式】（严格按此，除了这两段不要再写别的）",
    "BEATS:",
    "序号|起止段号|功能标签|一句话概括",
    "…（每个情节一行，序号从 1 开始；起止段号用正文里 [N] 的编号）",
  ].join("\n");
  const user = [
    `【作品】${input.caseTitle}`,
    `【本章任务】第 ${input.chapterNum} 章：${input.chapterBrief}`,
    `【企划书】（人物/设定，供切分参考）\n${input.ideaBook}`,
    `【正文】\n${input.draft}`,
  ].join("\n\n");
  return { system, user };
}

/** ─── 审判第二遍：逐情节深审 ─── */
export interface BeatReviewInput {
  criteria: string;
  caseTitle: string;
  ideaBook: string;
  chapterNum: number;
  chapterBrief: string;
  beatIndex: number;
  beatLabel: string;
  /** 已标段落号 [N] 的本情节原文 */
  beatText: string;
  /** 前一情节末段（衔接） */
  prevTail?: string;
  /** 后一情节首段（衔接） */
  nextHead?: string;
}

export function beatReviewPrompt(input: BeatReviewInput): { system: string; user: string } {
  const system = [
    "你是资深小说编辑，逐情节审查单章。你只拿到这一个情节的原文和它的上下文，不假设写手意图——基于文本说话。",
    "",
    "【判据】（两档：先看情节设计，再逐段查执行）",
    "==========",
    input.criteria,
    "==========",
    "",
    "【执行要求】",
    "- 一、情节设计：按【情节标准】逐条判断，每条 ✅/❌ 必须引用原文一句作证据。",
    "- 二、逐段执行：按【段落标准】对本情节的每一段（[N]）标 ✅/❌，每段引用原文作证据，❌ 给一句具体改法。",
    "- 只评这个情节，不评价前后情节；引用不出来的判断不算数。",
    "- 从严：找不到硬伤 ≠ 没问题，是你没看够；宁可误伤，不可放水。",
    "",
    "【输出】",
    "一、情节设计（逐条）：[标准名]：✅/❌ + 证据 + 一句话问题",
    "二、逐段：[段号]：✅/❌ + 证据（❌ 时给改法）",
  ].join("\n");
  const user = [
    `【作品】${input.caseTitle}`,
    `【本章任务】第 ${input.chapterNum} 章：${input.chapterBrief}`,
    `【本情节】第 ${input.beatIndex} 个（功能：${input.beatLabel}）`,
    input.prevTail ? `【衔接·前一情节末段】\n${input.prevTail}` : "",
    input.nextHead ? `【衔接·后一情节首段】\n${input.nextHead}` : "",
    `【企划书】（人物/设定，判断逻辑与人物行为是否成立）\n${input.ideaBook}`,
    `【本情节正文】\n${input.beatText}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

/** ─── 审判第三遍：汇总 + 停止信号 ─── */
export interface SynthesizeInput {
  caseTitle: string;
  chapterNum: number;
  chapterBrief: string;
  /** 各情节的审查结果，顺序对应情节序号 */
  reviews: string[];
}

export function synthesizePrompt(input: SynthesizeInput): { system: string; user: string } {
  const system = [
    "你是总编。下面是一章拆成若干情节后的逐情节审查结果。请汇总成一份给写手的改稿报告。",
    "",
    "【报告结构】",
    "一、本章任务达成度：本章是否完成了【本章任务】？一句话说明。",
    "二、必改问题清单：按 结构→场景→句子 排序，每条引用 段号+原句 并给具体改法，不要空话。",
    "三、可保留的优点：简短，一句一个。",
    "",
    "【停止判定】最后单独一行（供程序解析，必须）：",
    "JUDGE: NEEDS_FIX  （还有必须修的硬伤，写手需再改一轮）",
    "JUDGE: CLEAN      （无必须修的硬伤，本章可定稿）",
    "判定从严：只要还有影响结构或场景的硬伤就算 NEEDS_FIX；只有句级小瑕疵才可 CLEAN。",
  ].join("\n");
  const user = [
    `【作品】${input.caseTitle}`,
    `【本章任务】第 ${input.chapterNum} 章：${input.chapterBrief}`,
    ...input.reviews.map((r, i) => `【情节 ${i + 1} 审查】\n${r}`),
  ].join("\n\n");
  return { system, user };
}
