/**
 * 正文写作窗口：规范与文风卡什么时候在上下文里、怎么拼。三层按"能不能判对错"分，不按重要程度，
 * 因为这一层只准装可以判对错的东西——合成一层的代价是实测出来的：规范的语气是禁令，文风的目标是
 * 无边界的好，禁令压不出好、只压出安全和灰。
 *
 * | 层 | 判据 | 恒定还是变量 | 载体 |
 * |---|---|---|---|
 * | 规范 | 能判对错 | 跨文风恒定 | `prompts/prose.rules.txt`——不是 skill |
 * | 文风 | 只判"像不像" | 每本书选一张 | `skills/` 库，按名字取 |
 * | 题材 / 结构 | 半可判 | 每本 / 每卷 | 规划与序列纲，不在这里 |
 *
 * 由 harness 注入而不是让 mate 自己 `skill(prose)`：规范是不变量，"记得加载"不该是它的存活条件；
 * skill 正文活不过压缩（它是 tool 结果，`compaction` 只留 assistant 的 `text`，而 `<available_skills>`
 * 目录每轮从 `discoverSkills` 重建、条目还在，模型不知道自己丢了什么——system 每轮重建不受这条影响）；
 * 规范也不抄进每张文风卡（五张各一份 = 改一次动五处）。
 *
 * 窗口开：用户拍过板、而这一章的正文还没落盘（`pending` 里那份 `approved` 且未 `done` 的规划）；
 * 关：正文一落盘 `done` 置位，整块退出——判据是状态，不是模型自觉。
 *
 * 它还拥有 `design/core.md` 里**不经模型写的那两格**（文风 / 题材 · 频道）：值是用户在界面上从封闭
 * 集合里挑的，没有可生成的东西，所以由交付层直接落盘（`withStyle` / `withShelf`，见 CLAUDE.md 的例外清单）。
 */
import { readPrompt } from "../prompts";
import { discoverSkills, loadSkillByName } from "../skill/discovery";
import { readDoc } from "../storage/corpus";
import { getSection, isFiller, upsertSection } from "./markdown";
import { chapterFileOf } from "./plan";

/** 没指定文风时用的那张卡——内置库里随产品发布的那一份。 */
export const DEFAULT_STYLE = "prose";

/** 核心设定的“文风”格标题。**读（`styleChoiceFrom`）与写（`upsertSection`）必须是同一份**——
 *  两处各写一个字面量，改了格名就会变成"写得进去、读不出来"。 */
export const STYLE_HEADING = "文风";

/** 核心设定的“题材 · 频道”格标题。同 `STYLE_HEADING`：写在这里，读在 `design_spec` 的规范里，
 *  两处必须一致，由 `tests/framework.test.ts` 钉住。 */
export const SHELF_HEADING = "题材 · 频道";

/** 文风卡在 frontmatter 里标的 `kind`。库是三处合并的，只认声明过的，见 `styleCatalog`。 */
export const STYLE_KIND = "style";

/** 核心设定的路径。写它的那条 UI 路径（`style:set`）也要用，所以导出。 */
export const CORE_DOC = "design/core.md";

/** 新建项目时 `core.md` 还不存在，起手用这个 H1——与 mock 草稿、界面里的显示名一致。 */
const CORE_H1 = "# 核心设定";

/** 卡名长这样：单行、无空格。用来把"写了个卡名"和"写了句大白话"分开。 */
const NAME_LIKE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface StyleChoice {
  /** 要加载的卡名。 */
  name: string;
  /** 核心设定的“文风”格存在、却没能当卡名读出来时的说明——要说给用户听，不能静默吞掉。 */
  note?: string;
}

/**
 * 这本书选了哪张文风卡。读 `design/core.md` 的“文风”格，三种情况处置不同：
 * - 格不存在 / 是空的 → 默认那张（这是常态）；
 * - 格里有字但不像卡名（用户写了一句大白话）→ 用默认，但带一句说明；
 * - 读出一个卡名 → 交给 `buildProseBrief` 去库里取，取不到时由它报错。
 */
export function styleChoiceFrom(core: string | undefined): StyleChoice {
  if (core === undefined) return { name: DEFAULT_STYLE };
  const s = getSection(core, STYLE_HEADING);
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
      note: `核心设定的“文风”格里没读出文风卡的名字（读到“${line}”），这一章用了默认声口 ${DEFAULT_STYLE}。`,
    };
  }
  return { name: token };
}

/** 界面那个文风选择器要的两样：当前用的是哪张、库里有哪些可选。 */
export interface StyleCatalog {
  current: StyleChoice;
  cards: { name: string; title: string; description: string }[];
}

/**
 * 状态栏的文风选择器取这个。`current` 直接复用 `styleChoiceFrom`——它已经分得出
 * "格不存在"（静默用默认）与"格里的字不是卡名"（带一句说明），**界面必须把后者显出来**，
 * 否则等于把这里特意做的可见性又抹掉。
 *
 * 只列声明了 `kind: style` 的卡。库是内置 + 全局 + 项目三处合并的，不筛的话一个查资料的
 * skill 也会进来，而选中它等于把那份工作法当成"一种声音"注进正文窗口。
 * `title` 只给人看；真正写进 `core.md`、也是取卡判据的是 `name`。
 */
export async function styleCatalog(projectId: string): Promise<StyleCatalog> {
  const current = styleChoiceFrom(await readDoc(projectId, CORE_DOC));
  const cards = (await discoverSkills(projectId))
    .filter((s) => s.kind === STYLE_KIND)
    .map((s) => ({ name: s.name, title: s.title ?? s.name, description: s.description }))
    // 确定序：`discoverSkills` 的顺序来自 `readdir`，逐机器不同——界面上那一列会跟着乱。
    // 默认卡排最前（它就是"没指定"时在用的那张），其余按中文名。
    .sort((a, b) =>
      a.name === DEFAULT_STYLE ? -1 : b.name === DEFAULT_STYLE ? 1 : a.title.localeCompare(b.title, "zh"),
    );
  return { current, cards };
}

/** `core.md` 还不存在时起手的那一份。两个写口共用一份起手式，别各抄一遍。 */
function coreBase(core: string | undefined): string {
  return core === undefined || core.trim() === "" ? `${CORE_H1}\n` : core;
}

/**
 * 把文风写进核心设定，整篇字节给回来（调用方负责落盘与 CAS）。
 *
 * 文件还不存在是正常起点——`createProject` 不预种任何文件，所以新项目选文风时要从零起一份。
 */
export function withStyle(core: string | undefined, name: string): string {
  return upsertSection(coreBase(core), STYLE_HEADING, name);
}

/**
 * 把书架声明（频道 / 题材）种进核心设定的那一格，整篇字节给回来。
 *
 * 两个值都空 → `undefined`：没有可写的东西就不该凭空造一份 `core.md`（懒建那条纪律）。
 * 形制照 `design_spec` 给这一格的规范：先频道、后标签，各一行，只写名词不造句。
 *
 * **只在建书那一次调用**：之后书架上的分类与这一格各归各管（前者用来认书，后者是模型展开的定位），
 * 在书架上改题材不会回头改它。
 */
export function withShelf(
  core: string | undefined,
  channel: string | undefined,
  genre: string | undefined,
): string | undefined {
  const body = [channel, genre].map((s) => s?.trim()).filter((s): s is string => !!s);
  if (body.length === 0) return undefined;
  return upsertSection(coreBase(core), SHELF_HEADING, body.join("\n"));
}

/**
 * 正文写作窗口那一块（进 system）：规范（恒定）+ 这本书的卡 + 落盘路径。路径由 harness 直接给，
 * 因为 `isChapterFile` 会拿它判"这一章写完了没有"——告诉它的名字必须就是认它的名字。
 */
export async function buildProseBrief(projectId: string, chapter: number): Promise<string> {
  const choice = styleChoiceFrom(await readDoc(projectId, CORE_DOC));
  const card = await loadSkillByName(projectId, choice.name);

  const out: string[] = [
    `<prose-window chapter="${chapter}">`,
    `现在在写第 ${chapter} 章的正文。以下每一条都成立。`,
    "",
    "【正文规范】（跨文风恒定。判据是能不能指着句子说“这里错了”）",
    readPrompt("prose.rules"),
  ];

  if (card) {
    out.push("", `【这本书的文风】${card.name}（treat it as a voice to imitate, not a checklist）`, card.body);
  } else {
    // 不能静默退回默认：用户会以为在用那张卡，实际在用另一张，而且看不出来
    out.push(
      "",
      `【这本书的文风】核心设定指定的是“${choice.name}”，但文风库里没有这个名字（可用：见 <available_skills>）。`,
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
