/**
 * corpus 的离线测试：枚举 / 读 / 扫词，以及**两侧判据一致**。
 * 运行：bun test
 *
 * 这一层存在的全部理由就是"什么算一份文档"只能有一处判据，所以用例盯的主要是**一致性**：
 * 枚举得到的每一份，扫词也扫得到。另外钉住路径口径是**项目相对**（`design/...` / `chapters/...`）。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, writeDoc } from "../src/storage/project";
import { enumerateDocs, readDoc, scanDocs } from "../src/storage/corpus";

let HOME: string;
let pid: string;

beforeAll(async () => {
  HOME = await mkdtemp(join(tmpdir(), "talemate-corpus-"));
  process.env.TALEMATE_HOME = HOME;
  pid = (await createProject({ title: "语料测试" })).id;
});

afterAll(async () => {
  await rm(HOME, { recursive: true, force: true });
});

/** 项目根（用于手放文件——工具建不出某些名字，见下）。 */
const root = (): string => join(HOME, "novels", pid);

describe("corpus · 枚举", () => {
  test("两个根都收，路径是**项目相对**", async () => {
    await writeDoc(pid, "design/core.md", "# 核心\n");
    await writeDoc(pid, "design/characters/沈越.md", "# 角色：沈越\n");
    await writeFile(join(root(), "chapters/chapter_ch1_v1.md"), "第一章\n", "utf-8");
    expect(await enumerateDocs(pid)).toEqual([
      "chapters/chapter_ch1_v1.md",
      "design/characters/沈越.md",
      "design/core.md",
    ]);
  });

  test("前缀限定范围", async () => {
    expect(await enumerateDocs(pid, "design/")).toEqual(["design/characters/沈越.md", "design/core.md"]);
    expect(await enumerateDocs(pid, "chapters/")).toEqual(["chapters/chapter_ch1_v1.md"]);
  });

  test("原子写的临时文件（`.tmp`）进不来", async () => {
    // 落盘是"同目录 .<uuid>.tmp 再 rename"（见 atomic.ts）。它是真实存在过的邻居，
    // 所以"只收 .md"这一道必须真的在——不能让半份文件冒充一份文档。
    await writeFile(join(root(), "design/.2f1a.tmp"), "写到一半\n", "utf-8");
    expect(await enumerateDocs(pid, "design/")).not.toContain("design/.2f1a.tmp");
  });

  test("目录不存在 → 空，不抛", async () => {
    const fresh = (await createProject({ title: "空项目" })).id;
    expect(await enumerateDocs(fresh)).toEqual([]);
    expect(await readDoc(fresh, "design/core.md")).toBeUndefined();
  });
});

describe("corpus · 读", () => {
  test("读得到两个根；不存在的给 undefined", async () => {
    expect(await readDoc(pid, "design/core.md")).toBe("# 核心\n");
    expect(await readDoc(pid, "chapters/chapter_ch1_v1.md")).toBe("第一章\n");
    expect(await readDoc(pid, "design/nope.md")).toBeUndefined();
  });

  test("根之外一律不认；目录穿越被挡", async () => {
    // talemate.json 就躺在 projekt 根上——它绝不该被当成一份"语料文档"读到。
    expect(await readDoc(pid, "design/talemate.json")).toBeUndefined();
    expect(await readDoc(pid, "design/../talemate.json")).toBeUndefined();
    expect(await readDoc(pid, "design/wiki/../../talemate.json")).toBeUndefined();
    expect(await readDoc(pid, "design/design")).toBeUndefined();
  });
});

describe("corpus · 两侧判据一致", () => {
  test("**手放进去的**文件两侧都看得见——`·` 这类名字从前只有一侧收", async () => {
    // 工具建不出这个名字（写侧 `safeRelPath` 的字符类不收 `·`），所以这个分歧只在**手放的**
    // 文件上真实存在。而那恰恰是最该被搜到的一类：工具管不着它，删前引用检查要是漏了它，
    // 级联清理就会漏掉引用。枚举与扫词都得认。
    const hand = "design/characters/约翰·史密斯.md";
    await mkdir(join(root(), "design/characters"), { recursive: true });
    await writeFile(join(root(), hand), "他是 沈越 的旧识。\n", "utf-8");

    expect(await enumerateDocs(pid)).toContain(hand);

    const hits = await scanDocs(pid, "沈越");
    expect(hits.map((h) => h.path)).toContain(hand);
    // 反向也成立：扫出来的每一份，枚举里都得有。两侧认的是同一个文件集。
    const all = new Set(await enumerateDocs(pid));
    expect(hits.filter((h) => !all.has(h.path)).map((h) => h.path)).toEqual([]);
  });

  test("扫词收 `chapters/`——这是新能力（从前 scope 硬编码 design）", async () => {
    await writeFile(join(root(), "chapters/chapter_ch2_v1.md"), "沈越 上了船。\n", "utf-8");
    const scoped = await scanDocs(pid, "沈越", "chapters/");
    expect(scoped.map((h) => h.path)).toEqual(["chapters/chapter_ch2_v1.md"]);
    expect(scoped[0].line).toBe(1);
  });

  test("空词 → 空，不把整仓扫一遍", async () => {
    expect(await scanDocs(pid, "   ")).toEqual([]);
  });
});

describe("corpus · 夹具（`writeDoc` / `removeDoc`）", () => {
  test("夹具与读口走**同一个**绝对路径算法，也认同一套根", async () => {
    // 夹具是"测试要播种字节"用的（生产改文件只能走 write_ops）。它与读口共用 `corpus.docAbs`——
    // 各算各的话，"夹具写得进去、读口读不出来"这种事迟早发生。
    await writeDoc(pid, "design/fixture/probe.md", "播种\n");
    expect(await readDoc(pid, "design/fixture/probe.md")).toBe("播种\n");

    // 根之外的路径一律不认（与读口同一套 `DOC_ROOTS`）
    await expect(writeDoc(pid, "talemate.json", "x")).rejects.toThrow();
    await expect(writeDoc(pid, "design/../talemate.json", "x")).rejects.toThrow();
  });
});
