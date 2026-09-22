/**
 * atomic 的离线测试：原子写、CAS 拒绝陈旧、新建的排他、并发串行化。
 * 运行：bun test
 *
 * 这些是**不变量级**的断言（"中断不留半份文件"）而不是实现细节，所以刻意从外部可观察的行为
 * 去测：目录里剩了什么、抛的是不是 StaleContentError。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readText, removeIfUnchanged, StaleContentError, writeAtomic, writeIfUnchanged } from "../src/storage/atomic";

let DIR: string;

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), "talemate-atomic-"));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

/** 每个用例一个独立子目录，免得互相看见对方的残留文件。 */
async function freshDir(tag: string): Promise<string> {
  const d = join(DIR, tag);
  await rm(d, { recursive: true, force: true });
  await writeAtomic(join(d, ".keep"), "");
  return d;
}

describe("atomic · 写入", () => {
  test("新建：目录会被建出来，内容是给定字节", async () => {
    const d = await freshDir("create");
    const f = join(d, "sub", "core.md");
    const r = await writeIfUnchanged({ abs: f, expected: null, content: "# core\n" });
    expect(r.created).toBe(true);
    expect(await readText(f)).toBe("# core\n");
  });

  test("覆盖已存在：内容换掉，并报 created:false", async () => {
    const d = await freshDir("overwrite");
    const f = join(d, "core.md");
    await writeFile(f, "旧");
    const r = await writeIfUnchanged({ abs: f, expected: "旧", content: "新" });
    expect(r.created).toBe(false);
    expect(await readText(f)).toBe("新");
  });

  test("写完不留临时文件（rename 覆盖在 Windows 上也要成立）", async () => {
    const d = await freshDir("no-tmp");
    const f = join(d, "core.md");
    await writeFile(f, "旧");
    await writeIfUnchanged({ abs: f, expected: "旧", content: "新" });
    await writeIfUnchanged({ abs: f, expected: "新", content: "更新" });
    const entries = await readdir(d);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]); // 没有 .uuid.tmp 残留
    expect(entries).toContain("core.md");
  });

  test("readText 对不存在的文件返回 undefined，不抛", async () => {
    expect(await readText(join(DIR, "根本没有这个文件.md"))).toBeUndefined();
  });
});

describe("atomic · CAS", () => {
  test("读之后被改过 → 拒绝落盘并抛 StaleContentError", async () => {
    const d = await freshDir("stale");
    const f = join(d, "core.md");
    await writeFile(f, "我读到的是这一份");
    // 模拟弹窗期间用户手改（或另一个工具落了一次盘）
    await writeFile(f, "被人改过了");

    const err = await writeIfUnchanged({ abs: f, expected: "我读到的是这一份", content: "照旧写下去" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StaleContentError);
    // 关键：拒绝时**一个字节都没落**——那次改动没被盖掉
    expect(await readFile(f, "utf-8")).toBe("被人改过了");
  });

  test("期望新建、实际已存在 → 也算陈旧（新建是排他的）", async () => {
    const d = await freshDir("exclusive");
    const f = join(d, "core.md");
    await writeFile(f, "我先来的");
    const err = await writeIfUnchanged({ abs: f, expected: null, content: "我要新建" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleContentError);
    expect(await readFile(f, "utf-8")).toBe("我先来的");
  });

  test("期望已存在、实际没了 → 陈旧（不把文件当新建写回去）", async () => {
    const d = await freshDir("vanished");
    const f = join(d, "core.md");
    const err = await writeIfUnchanged({ abs: f, expected: "我以为它在", content: "写" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleContentError);
    expect(await readText(f)).toBeUndefined();
  });

  test("删除同样走 CAS：文件变过就不删", async () => {
    const d = await freshDir("remove");
    const f = join(d, "card.md");
    await writeFile(f, "读到的");
    await writeFile(f, "改过的");
    await expect(removeIfUnchanged({ abs: f, expected: "读到的" })).rejects.toBeInstanceOf(StaleContentError);
    expect(await readText(f)).toBe("改过的");

    await removeIfUnchanged({ abs: f, expected: "改过的" });
    expect(await readText(f)).toBeUndefined();
  });
});

describe("atomic · 并发", () => {
  test("同一路径上的两次读改写不交错——后一次看到的是前一次的结果", async () => {
    // 没有按路径的锁，两个调用会各自读到 "0"、各自 +1、后写的把先写的盖掉，结果是 "1" 而不是 "2"。
    // 这条用例钉的就是那个丢失更新。
    const d = await freshDir("serial");
    const f = join(d, "counter.md");
    await writeFile(f, "0");

    const bump = () =>
      (async () => {
        const cur = (await readText(f)) ?? "";
        // 故意在读写之间让出：没有锁的话这里就是交错点
        await new Promise((r) => setTimeout(r, 5));
        await writeIfUnchanged({ abs: f, expected: cur, content: String(Number(cur) + 1) });
      })();

    const results = await Promise.allSettled([bump(), bump(), bump()]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    // 串行化之后只有第一次能成功，其余两次看到的是"已变"，被 CAS 挡住——**不许有丢失更新**
    expect(await readText(f)).toBe(String(ok));
    expect(ok).toBe(1);
  });
});
