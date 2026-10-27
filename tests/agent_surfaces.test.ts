/**
 * Agent 表面的镜像守卫：同一份工作区指令和同一个 release skill 同时服务 Claude Code 与 DSH。
 *
 * DSH 读 `AGENTS.md` + `.dsh/skills/`，Claude Code 读 `CLAUDE.md` + `.claude/skills/`。两份内容
 * 各改各的，迟早出现“一个 agent 能发版、另一个看不到流程”的问题；这里只认字节相等。
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("agent surfaces", () => {
  test("AGENTS.md 与 CLAUDE.md 是同一份工作区指令", async () => {
    const [agents, claude] = await Promise.all([
      readFile(join(ROOT, "AGENTS.md"), "utf8"),
      readFile(join(ROOT, "CLAUDE.md"), "utf8"),
    ]);
    expect(agents).toBe(claude);
  });

  test("release skill 在 .dsh 与 .claude 下是同一份", async () => {
    const [dsh, claude] = await Promise.all([
      readFile(join(ROOT, ".dsh/skills/talemate-release/SKILL.md"), "utf8"),
      readFile(join(ROOT, ".claude/skills/talemate-release/SKILL.md"), "utf8"),
    ]);
    expect(dsh).toBe(claude);
  });
});
