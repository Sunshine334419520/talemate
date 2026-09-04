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

/** 解析 SKILL.md：剥离 ---frontmatter---，取 name/description */
export function parseSkillFile(raw: string, location: string): Skill {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = m ? m[2].trimStart() : raw;
  const front = m ? m[1] : "";
  const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name) throw new Error(`SKILL.md 缺 name 字段：${location}`);
  return { name, description: description ?? "", location, body };
}
