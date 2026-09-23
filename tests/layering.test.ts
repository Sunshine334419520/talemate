/**
 * 分层的**结构性守卫**：让纪律长在 CI 里，而不是靠人记得（与 `docs.test.ts` 同一路数）。
 *
 * 1. **改文件只有一个口**——工具不自己接文件系统、不 import 存储层。这条曾经只是约定
 *    （`design_ops.ts` 文件头写着"写盘唯一实现"），而 `save-chapter` 就绕过去了：它复用权限
 *    渲染器、然后直接调存储原语，问是问了，落盘却跳过整套变换与 CAS。把写口从 `ToolContext`
 *    上删掉只拦得住"经 ctx"的，拦不住"自己 import 一个"——所以补这一条。
 * 2. **取数也只有一个口**——`framework/` 不许自己接文件系统。它曾经接过：`framework/search.ts`
 *    自带一条 walker，于是"什么算一份文档"全仓有两份判据、且两份不一致。现在取数只在
 *    `storage/corpus.ts` 一处（见该文件头）。
 */
import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * 判据是**导入来源**，不是工具文件里出现过哪些词。
 * （按词判会误伤：`removeDesignSectionTool` 这个局部导出名里就有 `removeDesign`。）
 */
const NO_FS = { re: /from\s+"node:fs/, why: "不该自己 import 文件系统" };

const BANNED: { dir: string; bans: { re: RegExp; why: string }[] }[] = [
  {
    dir: "src/tool",
    bans: [NO_FS, { re: /from\s+"\.\.\/storage\//, why: "工具不该 import 存储层——它的能力只能从 ctx 来" }],
  },
  { dir: "src/framework", bans: [NO_FS] },
];

describe("分层 · 结构性守卫", () => {
  for (const { dir, bans } of BANNED) {
    test(`${dir} 只从该来的那一层取数/写盘`, async () => {
      const files = (await readdir(join(ROOT, dir))).filter((n) => n.endsWith(".ts"));
      expect(files.length).toBeGreaterThan(0); // 目录读空了别静默通过

      const hits: string[] = [];
      for (const f of files) {
        const text = await readFile(join(ROOT, dir, f), "utf8");
        for (const b of bans) if (b.re.test(text)) hits.push(`${dir}/${f}：${b.why}`);
      }
      expect(hits).toEqual([]);
    });
  }

  test("改文件的两个面确实走的是那条唯一路径", async () => {
    // 上面那条是"没绕过"，这一条是"真接上了"——否则把 import 删干净也能过。
    const text = await readFile(join(ROOT, "src/tool/file_tools.ts"), "utf8");
    expect(text).toContain('from "../framework/write_ops"');
    expect(text).toMatch(/\bwriteFile\(/);
  });
});
