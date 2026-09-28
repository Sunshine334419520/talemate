/**
 * 正文写作窗口：**规范与文风卡什么时候在上下文里，以及它们怎么拼**。
 *
 * ## 三层，按"能不能判对错"分，不按重要程度
 *
 * | 层 | 判据 | 恒定还是变量 | 载体 |
 * |---|---|---|---|
 * | **规范** | **能判对错** | 跨文风恒定 | `prompts/prose.rules.txt`——**不是 skill** |
 * | **文风** | 只判"像不像" | 每本书选一张 | `skills/` 库，按名字取 |
 * | **题材 / 结构** | 半可判 | 每本 / 每卷 | 规划与序列纲，不在这里 |
 *
 * 合成一层的代价是实测出来的：规范的语气是禁令，文风的目标是无边界的好——**禁令压不出好，
 * 只压出安全和灰**。所以"这一层该装什么"只有一条判据：**可以判对错的才准进**。
 *
 * ## 为什么由 harness 注入，而不是让 mate 自己 `skill(prose)`
 *
 * 1. **规范是不变量**，"记得加载"不该是它的存活条件（同 `propose-plan` 的 halt 由 harness 执行）。
 * 2. **skill 正文活不过压缩。** 它是 tool 结果，而 `compaction` 只留 assistant 的 `text` part——
 *    tool 结果不进摘要。书写到十几章，纪律会在某一次压缩之后无声消失；而 `<available_skills>`
 *    目录是每轮从 `discoverSkills` 重建的、条目还在，模型不知道自己丢了什么。system 每轮重建，
 *    不受这一条影响。
 * 3. **规范不抄进每张文风卡**：五张各一份 = 改一次动五处（`CLAUDE.md` 那条「绝不手抄」）。
 *
 * ## 窗口的开与关
 *
 * 开：用户拍过板、而这一章的正文还没落盘（`pending` 里那份 `approved` 且未 `done` 的规划）。
 * 关：正文一落盘 `done` 置位，整块退出上下文。**判据是状态，不是模型自觉。**
 */
import { readPrompt } from "../prompts";
import { loadSkillByName } from "../skill/discovery";
import { readDoc } from "../storage/corpus";
import { getSection, isFiller } from "./markdown";
import { chapterFileOf } from "./plan";

/** 没指定文风时用的那张卡——内置库里随产品发布的那一份。 */
export const DEFAULT_STYLE = "prose";

/** 卡名长这样：单行、无空格。用来把"写了个卡名"和"写了句大白话"分开。 */
const NAME_LIKE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface StyleChoice {
  /** 要加载的卡名 */
  name: string;
  /** 核心设定的「文风」格存在、却没能当卡名读出来时的说明——**要说给用户听**，不能静默吞掉 */
  note?: string;
}

/**
 * 这本书选了哪张文风卡。读 `design/core.md` 的「文风」格。
 *
 * 三种情况分得开，因为它们的处置完全不同：
 * - 格不存在 / 是空的 → 默认那张，没什么可说的（这是常态）；
 * - 格里有字但不像卡名（用户写了一句大白话）→ 用默认，**但带一句说明**；
 * - 读出一个卡名 → 交给 `buildProseBrief` 去库里取，取不到时由它报错。
 */
export function styleChoiceFrom(core: string | undefined): StyleChoice {
  if (core === undefined) return { name: DEFAULT_STYLE };
  const s = getSection(core, "文风");
  if (!s.found || !s.body) return { name: DEFAULT_STYLE };
  const line = s.body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !isFiller(l));
  if (line === undefined) return { name: DEFAULT_STYLE };

  // 格是给人写的，容忍几种写法：`- prose` / `**prose**` / `文风：prose`
  const bare = line.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim();
  const value = /[：:]/.test(bare) ? bare.replace(/^[^：:]*[：:]/, "").trim() : bare;
  const token = value.split(/\s+/)[0] ?? "";
  if (!NAME_LIKE.test(token)) {
    return {
      name: DEFAULT_STYLE,
      note: `核心设定的「文风」格里没读出文风卡的名字（读到「${line}」），这一章用了默认声口 ${DEFAULT_STYLE}。`,
    };
  }
  return { name: token };
}

/**
 * 正文写作窗口那一块（进 system）。
 *
 * 三部分：规范（恒定）+ 这本书的卡 + **落盘路径**。路径由 harness 直接给，不是因为有话要说，
 * 而是 `isChapterFile` 会拿它判"这一章写完了没有"——**告诉它的名字必须就是认它的名字**。
 */
export async function buildProseBrief(projectId: string, chapter: number): Promise<string> {
  const choice = styleChoiceFrom(await readDoc(projectId, "design/core.md"));
  const card = await loadSkillByName(projectId, choice.name);

  const out: string[] = [
    `<prose-window chapter="${chapter}">`,
    `现在在写第 ${chapter} 章的正文。以下每一条都成立。`,
    "",
    "【正文规范】（跨文风恒定。判据是能不能指着句子说「这里错了」）",
    readPrompt("prose.rules"),
  ];

  if (card) {
    out.push("", `【这本书的文风】${card.name}（treat it as a voice to imitate, not a checklist）`, card.body);
  } else {
    // **不能静默退回默认**：用户会以为在用那张卡，实际在用另一张，而且看不出来。
    out.push(
      "",
      `【这本书的文风】核心设定指定的是「${choice.name}」，但文风库里没有这个名字（可用：见 <available_skills>）。`,
      `先别写正文——把这件事告诉用户，问他：换回默认（${DEFAULT_STYLE}），还是把那张卡补进库里。`,
    );
  }

  if (choice.note) out.push("", choice.note);
  out.push(
    "",
    `正文写 ${chapterFileOf(chapter)}；同一章再改就递增版本号（v2、v3…），别覆盖上一版。`,
    "</prose-window>",
  );
  return out.join("\n");
}
