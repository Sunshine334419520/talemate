/**
 * Skill 发现：SKILL.md 发现（全局库 + 项目库)+ 目录注入 + 读取。与 opencode 同构：
 * system 只放 <available_skills>（name+description），正文由 skill 工具按名取。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, projectPaths, talemateHome } from "../core/config";
import { parseSkillFile, type Skill } from "./parse";

export type { Skill };
export { parseSkillFile };

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
