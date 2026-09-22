/**
 * "唯一写路径"的**结构性守卫**：读 `src/tool/*.ts`，断言没有工具自己接文件系统或存储层。
 *
 * 为什么要有这一条：这个不变量曾经只是**约定**（`design_ops.ts` 的文件头写着"写盘唯一实现"），
 * 而 `save-chapter` 就绕过去了——它复用权限渲染器，然后直接调存储原语，问是问了，落盘却跳过
 * 了整套变换与 CAS。约定拦不住东西；把写口从 `ToolContext` 上删掉能拦住（类型上只有一个口），
 * 但那只管"经 ctx"，管不了"自己 import 一个"。所以再补这一条。
 *
 * 与 `docs.test.ts` 同一路数：**让纪律长在 CI 里，而不是靠人记得。**
 */
import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TOOL_DIR = join(ROOT, "src/tool");

/**
 * 判据是**导入来源**，不是工具文件里出现过哪些词。
 * （按词判会误伤：`removeDesignSectionTool` 这个局部导出名里就有 `removeDesign`。）
 */
const BANNED = [
  { re: /from\s+"node:fs/, why: "工具不该自己 import 文件系统" },
  { re: /from\s+"\.\.\/storage\//, why: "工具不该 import 存储层——它的能力只能从 ctx 来" },
];

describe("唯一写路径 · 结构性守卫", () => {
  test("没有工具文件自己接文件系统或存储层", async () => {
    const files = (await readdir(TOOL_DIR)).filter((n) => n.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0); // 目录读空了别静默通过

    const hits: string[] = [];
    for (const f of files) {
      const text = await readFile(join(TOOL_DIR, f), "utf8");
      for (const b of BANNED) if (b.re.test(text)) hits.push(`src/tool/${f}：${b.why}`);
    }
    expect(hits).toEqual([]);
  });

  test("改文件的两个面确实走的是那条唯一路径", async () => {
    // 上一条是"没绕过"，这一条是"真接上了"——否则把 import 删干净也能过。
    const text = await readFile(join(TOOL_DIR, "file_tools.ts"), "utf8");
    expect(text).toContain('from "../framework/write_ops"');
    expect(text).toMatch(/\bwriteFile\(/);
  });
});
