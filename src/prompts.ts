/**
 * 写手 / 批评者 / 盲评 三个角色的 prompt 构造器。
 * 独立上下文的保证：批评者只拿 稿子 + 判据 + 企划书，看不到写手如何构思。
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

export function writerPrompt(input: WriterInput): { system: string; user: string } {
  // 通用 system prompt：只定义角色与行为，不含任何写作规则或内容
  const system = [
    "你是 talemate 的小说写手 agent。根据用户提供的材料，写出符合要求的章节正文。",
    "",
    "行为：",
    "- 写作前通读材料；材料中的要求必须逐条遵守。",
    "- 只输出正文本身，不输出标题、解释、思考过程或任何元信息。",
    "- 拿不准时按最克制、最平常的写法。",
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

export interface CriticInput {
  criteria: string;
  caseTitle: string;
  ideaBook: string;
  chapterNum: number;
  chapterBrief: string;
  draft: string;
}

export function criticPrompt(input: CriticInput): { system: string; user: string } {
  const system = [
    '你是资深小说编辑与批评者，专长"社会派悬疑"评审。你只拿到稿子本身和判据，不知道写手如何构思——基于文本说话，不假设写手意图。',
    "",
    "【判据】（双档制：先查合格线硬伤，再评优秀区）",
    "==========",
    input.criteria,
    "==========",
    "",
    "【执行要求】（必须先读判据包第四节『检查协议』，按协议逐句执行，禁止只背维度清单就打分）",
    "- 每条 ✅/❌ 必须引用原文一句作证据；引用不出来的判断不算数。",
    '- 视角纪律（合格线 4）逐句跑『视角检查协议』：信息溯源 → 旁白位置/功能 → 红牌。未发现违规就写明「逐句溯源未发现漂移」；发现就引用原句。',
    "- 文风（合格线 6/9）逐句找病句/碎句/tell/套话/冗余，每处引用原句。",
    "- 电报句扫描（文风专项）：全文找出所有①独立成句的裸动词短语（'手机震了。''他停了。'）②无归属的信息句（把群消息/他人话语写成叙述者宣告，如裸写'王强没了。'）③无感知者/行动者的完成态事件句（'手机在枕头底下震了'）。每处引用原句，判 ❌ 并给改法。",
    '- 信息释放（合格线 2）对开篇前 300 字逐细节问「功能是什么」，答不出的引用原句判 ❌。',
    "- 评分从严：合格线任何一条有真实硬伤就是 ❌。找不到硬伤 ≠ 稿子满分，是你没看够；宁可误伤，不可放水。",
    "- 统计锚定（对抗分数通胀）：正常的 2000-3000 字开篇章，合格线平均只应通过 6-7 维；优秀区通常 2-4 条。9/9 + 6/6 是逐句无可挑剔的极少数。你打高分前，必须逐维自我举证为什么没有硬伤；正常情况下你应当能挑出至少 1-2 个合格线硬伤。宁可打低，不可放水。",
    "",
    "【输出】（严格按此结构）",
    "一、合格线（9 维）逐维：",
    "  - [维度名]：✅/❌ + 证据（引用原文一句）+ 一句话问题",
    "二、优秀区（6 条）逐条：",
    "  - [维度名]：✅/❌ + 证据",
    "三、改法（按优先级，先结构→场景→句子；每条给具体改法，不要空话）",
    "四、一致性提示（本章设定与企划书/现实逻辑的出入；以及值得升级进企划书的新点子）",
    "",
    "【评分】最后单独一行（供程序解析）：",
    'SCORES: {"pass": <合格线通过数0-9>, "excellent": <优秀区通过数0-6>, "total": <1-10总分>}',
  ].join("\n");

  const user = [
    `【作品】${input.caseTitle}`,
    `【企划书】（供一致性提示参考）\n${input.ideaBook}`,
    `【本章任务】第 ${input.chapterNum} 章：${input.chapterBrief}`,
    `【稿子】\n---\n${input.draft}\n---`,
  ].join("\n\n");

  return { system, user };
}

export function comparatorPrompt(input: { workA: string; workB: string }): { system: string; user: string } {
  const system = [
    "你是资深小说编辑。下面两篇作品（A 和 B）是同一任务、同一设定下产出的两版稿子。请判断哪一篇更好，并说明为什么。",
    "规则：",
    "- 引用原文作为证据（每处结论都要有原文支撑）。",
    "- 从 悬念结构、写实、文风克制、人物动机、情绪后劲 等维度对比。",
    '- 明确说出哪篇更好（"作品A更好"或"作品B更好"或"不相上下"），并给出理由。',
    "- 你只基于文本评判，不知道版本先后。",
    "- 从严：只有新版确实更好时才判它更好；存疑就判不相上下。",
    "",
    "【评分】最后单独一行（供程序解析）：",
    "VERDICT: A | B | TIE   （A=作品A更好，B=作品B更好，TIE=不相上下）",
  ].join("\n");
  const user = `【作品A】\n---\n${input.workA}\n---\n\n【作品B】\n---\n${input.workB}\n---`;
  return { system, user };
}
