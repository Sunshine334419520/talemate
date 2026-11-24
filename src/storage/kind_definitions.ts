/**
 * 种类定义的取数口：把 `assets/kinds/` 下的文件读成 `{name, path, text}`。
 *
 * 只做"读盘"这一件事，不认格式、不认字段、不校验——解析与策略在 `framework/assetkinds.ts`。
 * 这样分层守卫那条"framework 不许自己接文件系统"仍然成立：framework 拿到的已经是文本。
 *
 * 路径同 prompts/skills：资源根（打包后 `process.resourcesPath`）下的 `assets/kinds/`；
 * 没钉资源根时按 `import.meta.url` 往上推到仓库根——CLI 与测试什么都不用做。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resourceRoot } from "../core/config";

export interface KindSourceFile {
  /** 文件名（含扩展名），如 `character.json` */
  name: string;
  /** 绝对路径，报错时直接指到文件 */
  path: string;
  /** 原始文本 */
  text: string;
}

/** 定义文件所在目录：资源根（或仓库根）下的 `assets/kinds/`。 */
export function kindDefinitionsDir(): string {
  // import.meta 放进函数里求：桌面壳打成 CJS 时顶层求值会炸；钉了资源根时这里根本用不上。
  const fallback = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return join(resourceRoot() ?? fallback, "assets", "kinds");
}

/**
 * 读目录下全部文件。目录不存在 → 抛错（打包漏资源时不能静默当成"没有种类"）；
 * 空目录不在这里判——"一条定义都没有"是策略，在 framework 里报。
 */
export function readKindDefinitions(dir = kindDefinitionsDir()): KindSourceFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    throw new Error(`资产定义目录读不到：${dir}（${(e as Error).message}）`);
  }
  return names.map((name) => {
    const path = join(dir, name);
    return { name, path, text: readFileSync(path, "utf-8") };
  });
}