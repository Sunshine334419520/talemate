/**
 * 资产底座：frontmatter 解析、种类判定、增删改查、节拍 → 章范围。
 *
 * 这些用例守的是"底座可以独立于 UI 先成立"：没有 UI、没有工具、没有模型，只靠路径 + 文件
 * 就能建出一种资产、改它、移动它、删它，并把节拍算回章号。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, writeDoc } from "../src/storage/project";
import { readDoc } from "../src/storage/corpus";
import {
  parseFrontmatter,
  serializeFrontmatter,
  splitFrontmatter,
  withFrontmatter,
} from "../src/framework/frontmatter";
import {
  assetKinds,
  beatDirOf,
  beatsOf,
  chapterRangeOf,
  createAsset,
  deleteAsset,
  kindOf,
  listAssets,
  moveAsset,
  parseAsset,
  readAsset,
  updateAsset,
} from "../src/framework/assets";
import { loadAssetKinds, parseAssetKind } from "../src/framework/assetkinds";

let HOME = "";
let pid = "";
let prevHome: string | undefined;

beforeAll(async () => {
  HOME = await mkdtemp(join(tmpdir(), "talemate-assets-"));
  prevHome = process.env.TALEMATE_HOME;
  process.env.TALEMATE_HOME = HOME;
  pid = (await createProject({ title: "资产底座" })).id;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.TALEMATE_HOME;
  else process.env.TALEMATE_HOME = prevHome;
  await rm(HOME, { recursive: true, force: true });
});

describe("frontmatter", () => {
  test("标量、行内列表、块列表、未知字段都解析；坏行带行号", () => {
    const raw = [
      "kind: character",
      'title: "沈越"',
      "order: 3",
      'aliases: [沈老三, "越哥"]',
      "tags:",
      "  - 主角",
      "  - 码头",
      "custom: 保留",
      "flag: true",
      "nothing: null",
    ].join("\n");
    const { data, problems } = parseFrontmatter(raw);
    expect(problems).toEqual([]);
    expect(data.kind).toBe("character");
    expect(data.title).toBe("沈越");
    expect(data.order).toBe(3);
    expect(data.aliases).toEqual(["沈老三", "越哥"]);
    expect(data.tags).toEqual(["主角", "码头"]);
    expect(data.custom).toBe("保留");
    expect(data.flag).toBe(true);
    expect(data.nothing).toBeNull();

    const bad = parseFrontmatter("key: [未闭合\nnext: {a: b}");
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(bad.problems.some((p) => p.includes("第 1 行"))).toBe(true);
  });

  test("split / with 是逐字节可逆的（正文原样，头部顺序稳定）", () => {
    const text = '---\nkind: beat\ntitle: 进内城\noutline: design/outline/第1卷.md\nchapters: 3\n---\n\n这一拍：主角第一次进内城。\n';
    const split = splitFrontmatter(text);
    expect(split.body).toBe("这一拍：主角第一次进内城。\n");

    const { data } = parseFrontmatter(split.raw as string);
    const rebuilt = withFrontmatter(data, split.body, ["kind", "title", "outline", "chapters"]);
    expect(rebuilt).toBe(text);

    const reSplit = splitFrontmatter(rebuilt);
    expect(parseFrontmatter(reSplit.raw as string).data).toEqual(data);
  });

  test("没有头部 / 不闭合 → 正文原样，不误判", () => {
    const plain = "# 角色：沈越\n\n他话少。\n";
    expect(splitFrontmatter(plain)).toEqual({ body: plain });
    const broken = "---\nkind: character\n# 没有闭合\n";
    expect(splitFrontmatter(broken)).toEqual({ body: broken });
  });

  test("序列化的字段顺序按传入顺序，未知字段排在后面", () => {
    const text = serializeFrontmatter(
      { zebra: "z", title: "标题", kind: "brief", alpha: "a" },
      ["kind", "title"],
    );
    expect(text.split("\n")[0]).toBe("kind: brief");
    expect(text.split("\n")[1]).toBe("title: 标题");
    expect(text).toContain("alpha: a");
    expect(text).toContain("zebra: z");
  });
});

describe("种类定义（assets/kinds/*.json）", () => {
  test("内置定义齐全、id 与文件名一致、字段声明可读", () => {
    const kinds = assetKinds();
    const ids = kinds.map((k) => k.id);
    const expected = [
      "brief",
      "world",
      "world-entry",
      "character",
      "outline",
      "beat",
      "chapter",
      "state-character",
      "foreshadowing",
      "progress",
    ];
    expect(new Set(ids)).toEqual(new Set(expected));
    const problems: string[] = [];
    for (const kind of kinds) {
      if (kind.label === "" || kind.section === "" || kind.match.length === 0) {
        problems.push(`${kind.id} 缺 label/section/match`);
      }
      if (kind.fields.some((f) => f.label === "")) problems.push(`${kind.id} 有字段缺标签`);
      if (kind.id === "beat" && !kind.fields.some((f) => f.key === "outline" && f.required)) {
        problems.push("beat 的 outline 必须是必填字段");
      }
    }
    expect(problems).toEqual([]);
  });

  test("路径数组、枚举中文名、默认值、create 模板都能解析", () => {
    const text = JSON.stringify({
      id: "prop",
      label: "道具",
      section: "图鉴",
      order: 5,
      match: ["design/props/*.md", "design/props/**/*.md"],
      create: "design/props/{title}.md",
      fields: [
        { key: "title", label: "标题", type: "string" },
        {
          key: "rarity",
          label: "稀有度",
          type: "enum",
          default: "common",
          values: [
            { value: "common", label: "普通" },
            { value: "rare", label: "稀有" },
          ],
        },
        { key: "weight", label: "重量", type: "number", default: 1, min: 0 },
      ],
    });
    const kind = parseAssetKind(text, "prop.json");
    expect(kind.match).toEqual(["design/props/*.md", "design/props/**/*.md"]);
    expect(kind.fields.map((f) => f.key)).toEqual(["title", "rarity", "weight"]);
    expect(kind.fields[1]?.values).toEqual([
      { value: "common", label: "普通" },
      { value: "rare", label: "稀有" },
    ]);
    expect(kind.fields[1]?.default).toBe("common");
    expect(kind.fields[2]?.default).toBe(1);
    expect(kind.createPath?.("剑")).toBe("design/props/剑.md");
  });

  test("定义写错直接抛，消息带文件路径", () => {
    const base = { id: "x", label: "X", section: "X", order: 1, match: ["a/*.md"], fields: [] };
    const cases: Array<[string, string]> = [
      ["{不是 json", "不是合法 JSON"],
      [JSON.stringify({ label: "X", section: "X", order: 1, match: ["a/*.md"], fields: [] }), "id"],
      [JSON.stringify({ ...base, match: [] }), "match"],
      [
        JSON.stringify({
          ...base,
          fields: [{ key: "f", label: "F", type: "bogus" }],
        }),
        "type",
      ],
      [
        JSON.stringify({
          ...base,
          fields: [{ key: "f", label: "F", type: "enum" }],
        }),
        "values",
      ],
      [JSON.stringify({ ...base, bogus: 1 }), "bogus"],
    ];
    const errors: string[] = [];
    for (const [text] of cases) {
      try {
        parseAssetKind(text, "bad.json");
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    expect(errors.length).toBe(cases.length);
    expect(errors.every((m) => m.includes("bad.json"))).toBe(true);
    expect(errors.some((m) => m.includes("不是合法 JSON"))).toBe(true);
    expect(errors.some((m) => m.includes("type"))).toBe(true);
    expect(errors.some((m) => m.includes("values"))).toBe(true);
    expect(errors.some((m) => m.includes("bogus"))).toBe(true);
  });

  test("目录加载：只收 .json、id 与文件名不一致报错、按 order 排序", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talemate-kinds-"));
    const writeKind = (name: string, id: string, order: number): Promise<void> =>
      writeFile(
        join(dir, name),
        JSON.stringify({ id, label: id.toUpperCase(), section: id.toUpperCase(), order, match: [`${id}/*.md`], fields: [] }),
      );
    try {
      await writeKind("b.json", "b", 2);
      await writeKind("a.json", "a", 1);
      await writeFile(join(dir, "note.md"), "# 不读\n");
      const kinds = loadAssetKinds(dir);
      expect(kinds.map((k) => k.id)).toEqual(["a", "b"]);

      await writeKind("wrong.json", "other", 3);
      expect(() => loadAssetKinds(dir)).toThrow("不一致");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("资产种类（路径判定）", () => {
  test("每一条登记的模式都能判回自己，且更具体的胜出", () => {
    const cases: Array<[string, string]> = [
      ["design/brief.md", "brief"],
      ["design/core.md", "brief"],
      ["design/wiki/world.md", "world"],
      ["design/wiki/漕运.md", "world-entry"],
      ["design/characters/沈越.md", "character"],
      ["design/outline/vol_1.md", "outline"],
      ["design/outline/vol_1/s1.md", "outline"],
      ["design/outline/vol_1/beats/b01.md", "beat"],
      ["chapters/chapter_ch1_v1.md", "chapter"],
      ["state/characters/沈越.md", "state-character"],
      ["state/foreshadowing.md", "foreshadowing"],
      ["state/progress.md", "progress"],
    ];
    const mismatched = cases.filter(([path, id]) => kindOf(path)?.id !== id);
    expect(mismatched).toEqual([]);
    expect(kindOf("design/notes.md")).toBeUndefined();
    const ids = assetKinds().map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("无头部的旧文件照样成资产（kind 由路径定，标题从文件名/正文取）", async () => {
    await writeDoc(pid, "design/characters/周渡.md", "# 角色：周渡\n\n港务局职员。\n");
    const asset = await readAsset(pid, "design/characters/周渡.md");
    expect(asset?.kind).toBe("character");
    expect(asset?.title).toBe("周渡");
    expect(asset?.problems).toEqual([]);
  });

  test("头的 kind 与路径不一致列为问题，但文件仍可读", () => {
    const asset = parseAsset("design/characters/沈越.md", "---\nkind: beat\ntitle: 沈越\n---\n\n正文\n");
    expect(asset?.kind).toBe("character");
    expect(asset?.problems.some((p) => p.includes("不一致"))).toBe(true);
  });
});

describe("增删改查", () => {
  test("新建角色/大纲/节拍：路径按种类算，order 递增，节拍落在所属大纲目录", async () => {
    const shen = await createAsset(pid, { kind: "character", title: "沈越", body: "# 沈越\n\n码头搬运工。\n" });
    expect(shen.ok).toBe(true);
    if (!shen.ok) return;
    expect(shen.asset.path).toBe("design/characters/沈越.md");
    expect(shen.asset.frontmatter.kind).toBe("character");
    expect(shen.asset.frontmatter.name).toBe("沈越");
    expect(shen.asset.frontmatter.order).toBe(1);

    const second = await createAsset(pid, { kind: "character", title: "林晚" });
    if (!second.ok) throw new Error(second.error);
    expect(second.asset.frontmatter.order).toBe(2);

    const outline = await createAsset(pid, { kind: "outline", title: "第 1 卷" });
    if (!outline.ok) throw new Error(outline.error);
    expect(outline.asset.path).toBe("design/outline/第1卷.md");
    expect(outline.asset.frontmatter.startChapter).toBe(1);

    const beat1 = await createAsset(pid, {
      kind: "beat",
      title: "进内城",
      body: "主角第一次进内城。\n",
      frontmatter: { outline: "design/outline/第1卷.md", chapters: 3 },
    });
    if (!beat1.ok) throw new Error(beat1.error);
    expect(beat1.asset.path).toBe("design/outline/第1卷/beats/b01.md");
    expect(beat1.asset.frontmatter.order).toBe(1);

    const beat2 = await createAsset(pid, {
      kind: "beat",
      title: "夜宴",
      frontmatter: { outline: "design/outline/第1卷.md" },
    });
    if (!beat2.ok) throw new Error(beat2.error);
    expect(beat2.asset.path).toBe("design/outline/第1卷/beats/b02.md");
    expect(beat2.asset.frontmatter.chapters).toBe(1);
  });

  test("节拍没有所属大纲 / 大纲不存在 / 提前建节拍 → 拒绝", async () => {
    const noOutline = await createAsset(pid, { kind: "beat", title: "孤儿" });
    expect(noOutline.ok).toBe(false);

    const wrongPath = await createAsset(pid, { kind: "beat", title: "错位", path: "design/outline/随便/beats/b01.md" });
    expect(wrongPath.ok).toBe(false);

    const missing = await createAsset(pid, {
      kind: "beat",
      title: "悬空",
      frontmatter: { outline: "design/outline/不存在的卷.md" },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("不存在");
  });

  test("图表/条目：标题安全化成路径，显式路径必须与种类对上", async () => {
    const entry = await createAsset(pid, { kind: "world-entry", title: "漕运 · 河道" });
    if (!entry.ok) throw new Error(entry.error);
    expect(entry.asset.path).toBe("design/wiki/漕运河道.md");

    const wrong = await createAsset(pid, { kind: "world-entry", path: "design/characters/错.md", title: "错" });
    expect(wrong.ok).toBe(false);
  });

  test("更新：合并字段、保留未知字段、拒绝陈旧写入", async () => {
    const created = await createAsset(pid, {
      kind: "character",
      title: "沈越",
      path: "design/characters/沈越2.md",
      frontmatter: { custom: "作者自己的字段" },
    });
    if (!created.ok) throw new Error(created.error);
    const before = created.asset;

    const updated = await updateAsset(pid, {
      path: before.path,
      expected: before.content,
      frontmatter: { aliases: ["沈老三"], role: "protagonist" },
      body: "# 沈越\n\n他话少，先答后想。\n",
    });
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.asset.frontmatter.custom).toBe("作者自己的字段");
    expect(updated.asset.frontmatter.aliases).toEqual(["沈老三"]);
    expect(updated.asset.body).toContain("先答后想");

    const stale = await updateAsset(pid, {
      path: before.path,
      expected: before.content,
      frontmatter: { role: "minor" },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toContain("改动");
  });

  test("移动：种类不变、目标不覆盖；旧文件消失，字节不变", async () => {
    const moved = await moveAsset(pid, {
      path: "design/characters/沈越2.md",
      to: "design/characters/沈越改.md",
    });
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.asset.path).toBe("design/characters/沈越改.md");
    expect(await readDoc(pid, "design/characters/沈越2.md")).toBeUndefined();
    expect(await readDoc(pid, "design/characters/沈越改.md")).toContain("custom");

    const wrongKind = await moveAsset(pid, {
      path: "design/characters/沈越改.md",
      to: "design/wiki/沈越改.md",
    });
    expect(wrongKind.ok).toBe(false);
  });

  test("删除：大纲有节拍时拒绝，cascade 才连带删；删除后 becomes undefined", async () => {
    const refused = await deleteAsset(pid, { path: "design/outline/第1卷.md" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("节拍");

    const done = await deleteAsset(pid, { path: "design/outline/第1卷.md", cascade: true });
    if (!done.ok) throw new Error(done.error);
    expect(done.removed).toContain("design/outline/第1卷.md");
    expect(done.removed.some((p) => p.endsWith("b01.md"))).toBe(true);
    expect(await readAsset(pid, "design/outline/第1卷.md")).toBeUndefined();
  });
});

describe("节拍 → 章范围", () => {
  test("按 order 与 chapters 累计；改一章数，后面的范围随之变化", async () => {
    const outline = await createAsset(pid, {
      kind: "outline",
      title: "第 2 卷",
      frontmatter: { startChapter: 10 },
    });
    if (!outline.ok) throw new Error(outline.error);
    const link = { outline: outline.asset.path };
    const b1 = await createAsset(pid, { kind: "beat", title: "开场", frontmatter: { ...link, chapters: 2 } });
    const b2 = await createAsset(pid, { kind: "beat", title: "中段", frontmatter: { ...link, chapters: 3 } });
    const b3 = await createAsset(pid, { kind: "beat", title: "收束", frontmatter: link });
    if (!b1.ok || !b2.ok || !b3.ok) throw new Error("建节拍失败");

    const index = await listAssets(pid);
    const beats = beatsOf(index.assets, outline.asset.path);
    expect(beats.map((b) => b.title)).toEqual(["开场", "中段", "收束"]);
    expect(chapterRangeOf(outline.asset, beats, b1.asset.path)).toEqual({ start: 10, end: 11 });
    expect(chapterRangeOf(outline.asset, beats, b2.asset.path)).toEqual({ start: 12, end: 14 });
    expect(chapterRangeOf(outline.asset, beats, b3.asset.path)).toEqual({ start: 15, end: 15 });

    const grown = await updateAsset(pid, {
      path: b2.asset.path,
      expected: b2.asset.content,
      frontmatter: { chapters: 5 },
    });
    if (!grown.ok) throw new Error(grown.error);
    const after = await listAssets(pid);
    expect(chapterRangeOf(outline.asset, beatsOf(after.assets, outline.asset.path), b3.asset.path)).toEqual({
      start: 17,
      end: 17,
    });
  });

  test("节拍目录由大纲路径派生；重复标题不会撞名", async () => {
    expect(beatDirOf("design/outline/第2卷.md")).toBe("design/outline/第2卷/beats");
    expect(beatDirOf("design/outline/vol_1/s1.md")).toBe("design/outline/vol_1/s1/beats");
  });
});

describe("清单与一致性", () => {
  test("未登记文档列出来不静默丢；悬空节拍列为索引问题", async () => {
    await writeDoc(pid, "design/notes.md", "# 笔记\n\n不算资产。\n");
    await writeDoc(pid, "design/outline/第2卷/beats/b99.md", "---\nkind: beat\ntitle: 悬空\noutline: design/outline/不存在.md\n---\n\n正文\n");
    const index = await listAssets(pid);
    expect(index.unregistered).toContain("design/notes.md");
    expect(index.problems.some((p) => p.path.endsWith("b99.md") && p.message.includes("不存在"))).toBe(true);
  });

  test("概览只允许一份（legacy core.md 也算）", async () => {
    await writeDoc(pid, "design/core.md", "# 核心设定\n\n一句话。\n");
    const second = await createAsset(pid, { kind: "brief", title: "第二份概览" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("已经有概览");
  });

  test("清单按种类、order、标题排序，且只收登记过的路径", async () => {
    const index = await listAssets(pid);
    expect(index.assets.every((a) => kindOf(a.path)?.id === a.kind)).toBe(true);
    const positions = index.assets.map((a) => assetKinds().findIndex((k) => k.id === a.kind));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});