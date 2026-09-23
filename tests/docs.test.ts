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

/**
 * 已删除/已改名的工具。docs/ 描述的是**当前状态**，不再提它们。
 *
 * 改名的一并列进来：对文档来说"这个 id 不存在了"和"它被删了"是同一件事——留着旧名，
 * 读文档的人就会去调一个不存在的工具。三个读口的旧名是 2026-09-23 那次正名留下的
 * （管辖范围从 `design/` 放宽到整个项目，名字里的 `-design` 就假了）。
 */
const RETIRED_TOOLS = [
  "add-character",
  "update-character",
  "character-brief",
  "save-chapter",
  "remove-character",
  "remove-design-section",
  "read-design",
  "list-designs",
  "search-designs",
];

async function docNames(): Promise<string[]> {
  return (await readdir(DOCS)).filter((n) => n.endsWith(".md")).sort();
}

/** 仓库里全部 .ts，路径**相对仓库根**（`src/framework/design_spec.ts`）——`tests/` 下的也要算。 */
async function allTsFiles(dir = ROOT, prefix = ""): Promise<string[]> {
  const SKIP = new Set(["node_modules", ".git"]);
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await allTsFiles(join(dir, e.name), rel)));
    else if (e.name.endsWith(".ts")) out.push(rel);
  }
  return out;
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
    // **要反引号包着才算提到这个工具。** 裸子串匹配等于没测：`write`、`edit` 这类词在散文里
    // 到处都是，随便哪句话带一个就"通过"了——守卫会静默失效，而它正是用来防静默失效的。
    const missing = BUILTIN_TOOLS.map((t) => t.id).filter((id) => !text.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  test("docs/agents.md 的工具表里没有代码里不存在的 id（反方向）", async () => {
    // 上面那条只管一个方向："代码里的工具都在文档里"。文档**多写**一个它抓不到——于是文档会
    // 描述一个不存在的东西，而那正是这份守卫存在的理由之一（写这条时我自己就先踩了一次：
    // 把 `edit` 写进表格，而 `edit` 还没建）。
    const text = await readAt("docs/agents.md");
    // 只认工具表那种"首格就是一个反引号 id"的行；别处的反引号（`design/*`、`writeDesign`）不在此列
    const listed = [...text.matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gm)].map((m) => m[1]);
    // 模式一旦失效（改了表格写法）就会一行都取不到，于是下面那条断言会空着通过——先钉住它非空
    expect(listed.length).toBeGreaterThan(0);
    const known = new Set(BUILTIN_TOOLS.map((t) => t.id));
    expect(listed.filter((id) => !known.has(id))).toEqual([]);
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

  test("docs/ 引到的源码文件都存在（删了/搬了文件忘了文档，在这里失败）", async () => {
    // 「相关源码」那些表是手维护的**地图**。工具名那条守卫（RETIRED_TOOLS）只管工具 id，
    // 管不到文件名：`framework/layers.ts` 删掉之后，源码表里还留着它——读文档的人会去找一个
    // 不存在的模块，而那正是"文档在描述一个已经不存在的东西"。
    //
    // 三种写法都算数：
    //   `src/agent/registry.ts` —— 相对仓库根
    //   `agent/registry.ts`      —— 相对 `src/`（文档里的惯例写法）
    //   `design_spec.ts`         —— 只写文件名（仓库里任何一处有同名文件即可）
    const files = await allTsFiles();
    const present = new Set(files);
    const byBase = new Set(files.map((p) => p.split("/").pop() as string));

    const hits: string[] = [];
    let checked = 0;
    for (const name of await docNames()) {
      const text = await readFile(join(DOCS, name), "utf8");
      for (const m of text.matchAll(/`([A-Za-z0-9_][A-Za-z0-9_./-]*\.ts)`/g)) {
        checked++;
        const rel = m[1];
        const ok =
          present.has(rel) || present.has(`src/${rel}`) || (!rel.includes("/") && byBase.has(rel));
        if (!ok) hits.push(`docs/${name} 引到不存在的 ${rel}`);
      }
    }
    expect(hits).toEqual([]);
    // 确实扫到了东西（否则模式一旦失效，上面那条会空着通过）
    expect(checked).toBeGreaterThan(0);
  });
});
