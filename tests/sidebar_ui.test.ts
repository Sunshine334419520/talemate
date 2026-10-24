/**
 * 左栏字号的守卫：段标题（会话 / 目录）、会话行、目录文件必须是同一档，
 * 不能各自写一个 11 / 12.5 / 13。元信息（时间、数量）才允许降一档。
 */
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("左栏 · 字号统一", () => {
  test("会话标题、段标题、目录文件共用 --side-text；时间/数量用 --side-meta", async () => {
    const css = await readFile(join(ROOT, "desktop/src/renderer/styles.css"), "utf8");
    expect(css).toContain("--side-text: 13px");
    expect(css).toContain("--side-meta: 11.5px");
    expect(css).toMatch(/\.section-head \{[^}]*font-size:\s*var\(--side-text\)/);
    expect(css).toMatch(/\.side \.sess \.title \{[^}]*font-size:\s*var\(--side-text\)/);
    expect(css).toMatch(/\.tree \.doc \{[^}]*font-size:\s*var\(--side-text\)/);
    expect(css).toMatch(/\.side \.sess \.when \{[^}]*font-size:\s*var\(--side-meta\)/);
  });
});
