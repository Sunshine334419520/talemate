/**
 * SKILL.md 解析与 Skill 形状。一个 skill = 一个目录 + SKILL.md；frontmatter 只强校验 name，
 * 多余字段容忍并忽略。
 *
 * `name` 与 `title` 是两件事，别合并：`name` 是写进 `design/core.md`「文风」格的**稳定 id**
 * （`framework/prose.ts` 按它取卡，界面切换文风也写它），`title` 只是给人看的显示名。
 * id 稳定、显示名可改——把中文写进 `name` 会同时踩两处：`prose.NAME_LIKE` 只认 ASCII，
 * 且中文之后"卡名"与"一句大白话"就分不开了。
 */
export interface Skill {
  name: string;
  /** 中文显示名。没写就回落成 `name`（界面那里兜）。 */
  title?: string;
  /**
   * skill 的类。写 `style` 的是**文风卡**——harness 按它把文风卡从普通 skill 里挑出来
   * （`framework/prose.ts` 的 `styleCatalog`）。不写就是普通 skill，即给模型用 `skill`
   * 工具加载的那种工作法。
   *
   * 判据必须显式声明，不能靠"库里现在只有文风卡"：库是内置 + 全局 + 项目三处合并的，
   * 混进一个查资料的 skill 之后，它会被当成"一种声音"注进正文窗口。
   */
  kind?: string;
  description: string;
  location: string; // SKILL.md 绝对路径
  body: string; // frontmatter 之后正文
}

/**
 * 解析 SKILL.md：剥离 ---frontmatter---，取 name/title/kind/description。
 *
 * 行尾先归一。正则里的 `\n` 是真换行符，而 Windows 检出（CRLF）的文件里第一行是 `---\r\n`，
 * 匹配不上 → frontmatter 读成空 → 缺 name 直接抛 → 被 `scanDir` 的 catch 静默吞掉；现象是库
 * 看着是满的、`discoverSkills` 却返回空数组，一个 skill 都不报错地消失。
 */
export function parseSkillFile(raw: string, location: string): Skill {
  const text = raw.replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = m ? m[2].trimStart() : text;
  const front = m ? m[1] : "";
  const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const title = front.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const kind = front.match(/^kind:\s*(.+)$/m)?.[1]?.trim();
  const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name) throw new Error(`SKILL.md 缺 name 字段：${location}`);
  return { name, title, kind, description: description ?? "", location, body };
}
