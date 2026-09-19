/**
 * 文档守卫：让 `docs/` 的约定长在 CI 里，而不是靠人记得。
 *
 * 文档腐烂的两种典型方式，这里各堵一条：
 *   抄多了 —— 文档里写的清单与代码不一致（"加/删了工具，忘了文档"）
 *   抄少了 —— 文档在描述一个已经不存在的东西
 *
 * 判据是"**这份文档还配得上它的 Status 块吗**"，不是"文笔好不好"。
 */
import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_TOOLS } from "../src/tool";

const ROOT = join(import.meta.dir, "..");
const DOCS = join(ROOT, "docs");

/** 每份文档头部的固定四行——新加一份必须回答"它是给谁的"。 */
const STATUS_KEYS = ["**职责**", "**读者**", "**对齐代码**"];

/** 已删除的工具。docs/ 描述的是**当前状态**，不再提它们。 */
const RETIRED_TOOLS = ["add-character", "update-character", "character-brief"];

async function docNames(): Promise<string[]> {
  return (await readdir(DOCS)).filter((n) => n.endsWith(".md")).sort();
}

const readAt = (rel: string) => readFile(join(ROOT, rel), "utf8");

describe("文档守卫", () => {
  test("docs/ 下每份文档都有 Status 块（职责 / 读者 / 对齐代码）", async () => {
    const names = await docNames();
    expect(names.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const name of names) {
      // 只看头部：Status 块必须在最前面，读者一眼就能判断这份文档该不该读
      const head = (await readFile(join(DOCS, name), "utf8")).split("\n").slice(0, 12).join("\n");
      for (const key of STATUS_KEYS) {
        if (!head.includes(key)) missing.push(`docs/${name} 缺 ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("README 里链接的文档都存在（链接不腐烂）", async () => {
    const readme = await readAt("README.md");
    const links = [...readme.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const link of links) {
      if (/^https?:/.test(link)) continue;
      try {
        await readAt(link);
      } catch {
        missing.push(link);
      }
    }
    expect(missing).toEqual([]);
  });

  test("docs/ 覆盖了全部内置工具（加了工具忘了文档，在这里失败）", async () => {
    const text = await readAt("docs/agents.md");
    const missing = BUILTIN_TOOLS.map((t) => t.id).filter((id) => !text.includes(id));
    expect(missing).toEqual([]);
  });

  test("docs/ 不出现已删除的工具名（删了代码忘了文档，在这里失败）", async () => {
    const hits: string[] = [];
    for (const name of await docNames()) {
      const text = await readFile(join(DOCS, name), "utf8");
      for (const tool of RETIRED_TOOLS) {
        if (text.includes(tool)) hits.push(`docs/${name} 提到已删除的 ${tool}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
