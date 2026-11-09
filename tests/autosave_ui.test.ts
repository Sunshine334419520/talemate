/**
 * 右栏编辑的自动保存：进入编辑就后台落盘，切走之前先把草稿存掉，存不上要问一句。
 *
 * 与其它界面守卫一样，jsdom 里没有真实磁盘与可靠的计时器，所以守的是结构：
 * 那几处关键判断必须在，且顺序不能反（先存再走、覆盖先存成功再放行）。
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("右栏编辑 · 自动保存", () => {
  test("停手就自动落盘，不用按保存", async () => {
    const pane = await readFile(join(ROOT, "desktop/src/renderer/SidePane.tsx"), "utf8");
    expect(pane).toContain("const AUTOSAVE_MS = 700");
    expect(pane).toContain("window.setTimeout(() => void saveNow(false), AUTOSAVE_MS)");
    // 状态必须让人看得见：正在存 / 还没存上 / 已存
    expect(pane).toContain("保存中…");
    expect(pane).toContain("待保存…");
    // 自动保存之后「放弃」已经没有意义（草稿早就落盘了），编辑态只剩「保存并完成」
    expect(pane).not.toContain('title="放弃"');
  });

  test("切屏/关栏之前先把草稿交给上层存掉", async () => {
    const pane = await readFile(join(ROOT, "desktop/src/renderer/SidePane.tsx"), "utf8");
    expect(pane).toContain("onRegisterDraft({ flush, discard })");

    const ws = await readFile(join(ROOT, "desktop/src/renderer/Workspace.tsx"), "utf8");
    expect(ws).toContain("const withLeaveGuard");
    expect(ws).toContain("await api.flush()");
    expect(ws).toContain("setLeaveAsk({ apply })");
    // 打开、返回、从改动记录进详情，三条路都要过这道门
    expect(ws).toContain("void withLeaveGuard(() => {");
  });

  test("存不上就问：覆盖 / 丢掉 / 留下，且覆盖必须真的写成功才放行", async () => {
    const ws = await readFile(join(ROOT, "desktop/src/renderer/Workspace.tsx"), "utf8");
    expect(ws).toContain("用我的覆盖并离开");
    expect(ws).toContain("丢掉改动离开");
    expect(ws).toContain("留下继续改");
    // 覆盖失败还把人送走 = 换一种方式悄悄丢稿
    expect(ws).toContain("draftApiRef.current?.flush(true)");
  });

  test("CAS 用界面带回来的那一份，不是现读现写", async () => {
    const main = await readFile(join(ROOT, "desktop/src/main/index.ts"), "utf8");
    const start = main.indexOf('"docs:save"');
    expect(start).toBeGreaterThan(0);
    const handler = main.slice(start, start + 1400);
    expect(handler).toContain("p.expected !== undefined && p.force !== true");
    expect(handler).toContain("expected");

    const api = await readFile(join(ROOT, "desktop/src/shared/api.ts"), "utf8");
    expect(api).toContain("opts?: { expected?: string | null; force?: boolean }");
  });

  test("自己写盘的回声不算「别处改了」", async () => {
    const ws = await readFile(join(ROOT, "desktop/src/renderer/Workspace.tsx"), "utf8");
    expect(ws).toContain("selfSavedRef.current.get(open.path) === text");
    expect(ws).toContain("selfSavedRef.current.set(path, text)");
  });
});
