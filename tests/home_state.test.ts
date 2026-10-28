/**
 * 用户级状态文件（`models.json` / `desktop.json` / `current.json`）的落盘守卫。
 *
 * 守的第一件事：**全新机器上的第一次保存**。home 目录平时靠 `createProject` 顺手建出来，
 * 而"在设置里保存模型配置"跑到它之前——裸 `writeFile` 在那里是 ENOENT，用户在界面上看到的
 * 只是"保存失败"。
 *
 * 守的第二件事：坏文件不等于空文件。读口把"解析失败"当"还没配"，下一次保存就是拿空数据
 * 整份覆盖（配置与密钥一起没）。所以严格读必须抛，而且**不许动那个文件的字节**。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HomeStateError,
  homeStatePath,
  readHomeState,
  readHomeStateOr,
  writeHomeState,
} from "../src/storage/home_state";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "talemate-home-"));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("home 目录还不存在时也写得进去（全新机器第一次保存）", async () => {
  const home = join(await tempRoot(), "missing", "home");
  const env = { TALEMATE_HOME: home };
  const file = homeStatePath("models", env);
  expect(existsSync(file)).toBe(false);

  await writeHomeState("models", { profiles: [], default: "deepseek" }, env);

  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ profiles: [], default: "deepseek" });
});

test("没有文件 ≠ 坏文件：严格读给 undefined，宽松读给默认值", async () => {
  const env = { TALEMATE_HOME: join(await tempRoot(), "home") };

  expect(await readHomeState("desktop", env)).toBeUndefined();
  expect(await readHomeStateOr("desktop", {}, env)).toEqual({});
  expect(existsSync(homeStatePath("desktop", env))).toBe(false);
});

test("文件坏了：严格读抛（消息带路径），宽松读降级，两份都不改原字节", async () => {
  const env = { TALEMATE_HOME: join(await tempRoot(), "home") };
  const file = homeStatePath("models", env);
  await mkdir(dirname(file), { recursive: true });
  const broken = '{ "profiles": [';
  await writeFile(file, broken, "utf-8");

  let thrown: unknown;
  try {
    await readHomeState("models", env);
  } catch (e) {
    thrown = e;
  }

  const problems: string[] = [];
  if (!(thrown instanceof HomeStateError)) problems.push("严格读没有抛 HomeStateError");
  else if (!thrown.message.includes(file)) problems.push("错误消息里没有文件路径，用户无从修起");

  expect(problems).toEqual([]);
  expect(await readHomeStateOr("models", { profiles: [] }, env)).toEqual({ profiles: [] });
  expect(await readFile(file, "utf-8")).toBe(broken);
});

test("三份文件的名字与位置只由 homeStatePath 决定", async () => {
  const home = await tempRoot();
  const env = { TALEMATE_HOME: home };
  const got = (["models", "desktop", "current"] as const).map((n) => homeStatePath(n, env));
  expect(got).toEqual([join(home, "models.json"), join(home, "desktop.json"), join(home, "current.json")]);
});
