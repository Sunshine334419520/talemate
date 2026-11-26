/**
 * 读口的边界预算（docs/compaction.md §11.3）：先截断，后折叠。
 *
 * 这些用例钉的是工具输出上限与分页提示，不是语料层本身——全部离线。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/core/types";
import { buildIndex } from "../src/framework/anchor";
import { globDocs, grepDocs } from "../src/framework/find";
import { renderHits } from "../src/framework/search";
import { renderTaskResult } from "../src/tool/core_tools";
import { grepTool } from "../src/tool/find_tools";
import { readTool } from "../src/tool/read_tools";
import { createProject, writeDoc } from "../src/storage/project";
import { readDoc, scanDocs } from "../src/storage/corpus";

let home: string;
let prevHome: string | undefined;
let projectId: string;

function ctx(): ToolContext {
  return {
    readDoc: (path) => readDoc(projectId, path),
    listIndex: (prefix) => buildIndex(projectId, prefix),
    globDocs: async (pattern, path) => (await globDocs(projectId, pattern, path)).text,
    grepDocs: async (query) => (await grepDocs(projectId, query)).text,
    searchDocs: async (query, prefix, limit) => renderHits(await scanDocs(projectId, query, prefix), query, limit),
  } as unknown as ToolContext;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-read-limits-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = home;
  projectId = (await createProject({ title: "读口预算" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe("read 的上限与分页", () => {
  test("超长文档无 section：返回小节索引 + 首段 + offset 提示", async () => {
    const body = `# 长文\n\n## 第一段\n${"正".repeat(13_000)}\n\n## 第二段\n${"文".repeat(13_000)}\n`;
    await writeDoc(projectId, "design/wiki/long.md", body);
    const out = (await readTool.execute({ path: "design/wiki/long.md" }, ctx())).output;
    expect(out).toContain("已截断");
    expect(out).toContain("- 第一段");
    expect(out).toContain("offset=");
    expect(out.length).toBeLessThan(body.length);
  });

  test("offset 继续读全文", async () => {
    const out = (await readTool.execute({ path: "design/wiki/long.md", offset: 12000 }, ctx())).output;
    expect(out).toContain("从第 12000 字起");
    expect(out).toContain("全文还有");
  });

  test("长小节：第一段 + offset 续读", async () => {
    const out = (await readTool.execute({ path: "design/wiki/long.md", section: "第一段" }, ctx())).output;
    expect(out).toContain("本节约");
    expect(out).toContain("此节还有");
    expect(out).toContain("offset=12000");
  });

  test("设计文档没有常驻特例：core 照常返回全文", async () => {
    // 从前 core / world 每轮注入 system，read 它们只回一个指针；没有常驻层之后这个特例必须消失，
    // 否则模型会被告知"正文在 system 里"，而 system 里根本没有。
    await writeDoc(projectId, "design/brief.md", "# 概览\n## 一句话简介\n一个人。\n");
    const out = (await readTool.execute({ path: "design/brief.md" }, ctx())).output;
    expect(out).toContain("一个人。");
    expect(out).not.toContain("常驻");
  });
});

describe("grep / task 的上限", () => {
  test("grep 单文件最多显示 20 处并报本文件剩余", async () => {
    await writeDoc(
      projectId,
      "design/wiki/hits.md",
      `# 命中\n\n${Array.from({ length: 50 }, (_, i) => `第 ${i} 行：沈越`).join("\n")}\n`,
    );
    const out = (await grepTool.execute({ pattern: "沈越" }, ctx())).output;
    expect(out).toContain("命中 50 处，显示前 20 处");
    expect(out).toContain("本文件还有 30 处未显示");
    expect(out).toContain("还有 30 处未显示；缩小 path 或 include");
  });

  test("task 结论超过 12k 时截断并标注", () => {
    const out = renderTaskResult("researcher", "结".repeat(13_000));
    expect(out).toContain("结论已截断");
    expect(out.length).toBeLessThan(13_000);
  });
});