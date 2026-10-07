/**
 * SKILL.md 解析与 Skill 形状。一个 skill = 一个目录 + SKILL.md；frontmatter 只强校验 name+description，
 * 多余字段容忍并忽略。
 */
export interface Skill {
  name: string;
  description: string;
  location: string; // SKILL.md 绝对路径
  body: string; // frontmatter 之后正文
}

/**
 * 解析 SKILL.md：剥离 ---frontmatter---，取 name/description。
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
  const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name) throw new Error(`SKILL.md 缺 name 字段：${location}`);
  return { name, description: description ?? "", location, body };
}
