/**
 * Skill 系统：SKILL.md 发现（全局库 + 项目库）+ 目录注入 + 读取。
 * 与 opencode 同构：system 只放 <available_skills>（name+description），正文由 skill 工具按名取。
 * skill = 一个目录 + SKILL.md，frontmatter 只强校验 name+description，多余字段容忍并忽略。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, projectPaths, talemateHome } from "../core/config";

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

/** 发现某项目可见的全部 skill（项目库优先，同名覆盖全局） */
export async function discoverSkills(projectId?: string): Promise<Skill[]> {
  const found = new Map<string, Skill>();

  const globalDir = paths(talemateHome()).globalSkills;
  await scanDir(globalDir, found);

  if (projectId) {
    const projDir = projectPaths(talemateHome(), projectId).skills;
    await scanDir(projDir, found);
  }

  return [...found.values()];
}

async function scanDir(root: string, acc: Map<string, Skill>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true }).then((ds) =>
      ds.filter((d) => d.isDirectory()).map((d) => d.name),
    );
  } catch {
    return;
  }
  for (const dir of entries) {
    const file = join(root, dir, "SKILL.md");
    try {
      const raw = await readFile(file, "utf-8");
      const skill = parseSkillFile(raw, file);
      acc.set(skill.name, skill); // 后扫的（项目库）覆盖先扫的（全局库）
    } catch {
      /* 无 SKILL.md 或损坏则跳过 */
    }
  }
}

export async function loadSkillByName(
  projectId: string | undefined,
  name: string,
): Promise<Skill | undefined> {
  const all = await discoverSkills(projectId);
  return all.find((s) => s.name === name);
}

/** 渲染 <available_skills> 目录段（只含 name+description，无正文）——注入 system prompt */
export function renderSkillCatalog(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills
    .filter((s) => s.description)
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`);
  return ["<available_skills>", ...lines, "</available_skills>"].join("\n");
}
