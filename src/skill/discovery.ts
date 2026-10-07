/**
 * Skill 发现：SKILL.md 发现（内置库 + 全局库 + 项目库）+ 目录注入 + 读取；system 只放
 * <available_skills>（name+description），正文由 skill 工具按名取。
 * 三个库一条优先级：内置（随产品发布）< 全局（作者级）< 项目（本小说专属）——扫描顺序就是优先级，
 * 后扫的同名覆盖先扫的，所以内置那几份压不过任何用户自己的 skill。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinSkillsDir, paths, projectPaths, talemateHome } from "../core/config";
import { parseSkillFile, type Skill } from "./parse";

export type { Skill };
export { parseSkillFile };

export async function discoverSkills(projectId?: string): Promise<Skill[]> {
  const found = new Map<string, Skill>();

  await scanDir(builtinSkillsDir(), found);
  await scanDir(paths(talemateHome()).globalSkills, found);

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
      acc.set(skill.name, skill);
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

/** 渲染 <available_skills> 目录段（只含 name+description，无正文），注入 system prompt */
export function renderSkillCatalog(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills
    .filter((s) => s.description)
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`);
  return ["<available_skills>", ...lines, "</available_skills>"].join("\n");
}
