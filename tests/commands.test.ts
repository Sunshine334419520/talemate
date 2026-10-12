/**
 * 桌面端 `/` 命令表与 CLI 的一致性守卫。
 *
 * 界面上的 `/status` 与 CLI 的 `/status` 必须是**同一条命令**。名字在说谎比少一条命令糟得多
 * （界面上曾有个 `/新会话`，而 CLI 的 `/new` 是新建**作品**——同一个人在两个外壳里被教了两遍不同的东西）。
 *
 * `src/cli.ts` 有顶层副作用（import 它就等于启动 CLI），所以只能读文本比对，同 `docs.test.ts`
 * 对待文档的做法。
 */
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMANDS } from "../desktop/src/renderer/commands";

const ROOT = join(import.meta.dir, "..");

describe("桌面端 / 命令", () => {
  test("表不是空的——否则下面两条会空着通过", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
  });

  test("每个命令名在 CLI 里都有一个 case", async () => {
    const cli = await readFile(join(ROOT, "src/cli.ts"), "utf8");
    const missing = COMMANDS.filter((c) => !cli.includes(`case "/${c.name}":`)).map((c) => c.name);
    expect(missing).toEqual([]);
  });

  test("名字是英文小写：界面上打的就是它，中文名会与 CLI 分叉", () => {
    const bad = COMMANDS.filter((c) => !/^[a-z][a-z-]*$/.test(c.name)).map((c) => c.name);
    expect(bad).toEqual([]);
  });

  test("说明是中文——命令名给键盘，说明给人，两条线不混", () => {
    const bad = COMMANDS.filter((c) => !/[一-龥]/.test(c.hint)).map((c) => c.name);
    expect(bad).toEqual([]);
  });
});
