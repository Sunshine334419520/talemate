/**
 * 用户级状态文件：住在 `<talemateHome>` 根上的三份 JSON——`models.json` / `desktop.json` / `current.json`。
 *
 * 它们不属于任何一部作品，所以路径与落盘都在这里各收一处，谁都不再自己 `join(talemateHome(), "…")`
 * 或裸 `writeFile`。两件事会因此坏掉：
 *
 * 1. home 目录平时是 `createProject` 顺手建出来的（见 storage/project.ts），全新机器上它还不存在。
 *    裸写于是 ENOENT——而症状出现在"设置里保存模型"，离真正的原因隔着整个产品。
 * 2. 裸写不是原子的。进程被杀留下的半截 JSON 会被读口当成"还没配"，下一次保存照着空数据整份
 *    覆盖，用户的配置与密钥一声不响地没了。
 *
 * 所以写走 `writeAtomic`（它负责 mkdir + 临时文件 + rename），路径只由 `homeStatePath` 拼。
 *
 * 读有两种，别混用：`readHomeState` 只有"没有"（undefined）和"读到"两种结果，**文件在但解析失败
 * 会抛**——凡是要"读来改写"的路径都必须用它，拿空数据覆盖比报错贵得多；`readHomeStateOr` 把坏
 * 文件降级成默认值，只给显示用的读口（界面不该因为一份坏文件就打不开）。
 *
 * `web.json` 不在这里：它有自己的模块（web_config.ts），读写口只有那一个。
 */
import { basename, join } from "node:path";
import { talemateHome } from "../core/config";
import { readText, writeAtomic } from "./atomic";

export type HomeStateName = "models" | "desktop" | "current";

/** 文件名清单是唯一的：加一份用户级文件 = 加一行。 */
const FILES: Record<HomeStateName, string> = {
  models: "models.json",
  desktop: "desktop.json",
  current: "current.json",
};

export function homeStatePath(name: HomeStateName, env = process.env): string {
  return join(talemateHome(env), FILES[name]);
}

/**
 * "文件在、但读不出来"。它要冒到用户面前：那份文件里可能有他的密钥与多套配置，静默当空文件
 * 处理等于替他做了删除的决定。
 */
export class HomeStateError extends Error {
  constructor(
    readonly abs: string,
    reason: string,
  ) {
    super(`${basename(abs)} 读不出来（${reason}）。先修好或删掉 ${abs}，再重试。`);
    this.name = "HomeStateError";
  }
}

/** 严格读：不存在 → undefined；解析失败 → HomeStateError。 */
export async function readHomeState<T>(name: HomeStateName, env = process.env): Promise<T | undefined> {
  const abs = homeStatePath(name, env);
  const raw = await readText(abs);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new HomeStateError(abs, e instanceof Error ? e.message : String(e));
  }
}

/** 宽松读：坏文件当没配，返回 fallback。只给显示用的读口。 */
export async function readHomeStateOr<T>(name: HomeStateName, fallback: T, env = process.env): Promise<T> {
  try {
    return (await readHomeState<T>(name, env)) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function writeHomeState(name: HomeStateName, value: unknown, env = process.env): Promise<void> {
  await writeAtomic(homeStatePath(name, env), `${JSON.stringify(value, null, 2)}\n`);
}
