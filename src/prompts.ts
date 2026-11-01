/**
 * 提示词加载：自带 prompt 放仓库根 prompts/*.txt（内容即文件，便于 diff/review），
 * readPrompt("mate.system") → prompts/mate.system.txt，相对 import.meta.url 解析、不依赖 cwd。
 * 路径每次调用时算、不在模块顶层算：桌面端打包后 import.meta.url 指向 bundle 内部，外壳会在启动时
 * 用 `setResourceRoot` 把它钉到随包数据那里，而顶层算过的话 import 提升会让外壳永远来不及钉。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resourceRoot } from "./core/config";

function promptsDir(): string {
  // `import.meta.url` 也放进函数里求：桌面壳把这份代码打成 CJS，CJS 里 `import.meta` 是空的，
  // 放在模块顶层算，启动时就会炸在 `fileURLToPath(undefined)` 上；钉了资源根时它根本用不上
  const fallback = join(dirname(fileURLToPath(import.meta.url)), "..");
  return join(resourceRoot() ?? fallback, "prompts");
}

/**
 * 评测变体的内存覆盖：只改本次进程读到的文本，不碰仓库文件。
 * 键是 readPrompt 的 id（如 `prose.rules`），调用方负责在每次 run 前 clear。
 */
const overrides = new Map<string, string>();

export function overridePrompt(id: string, text: string): void {
  overrides.set(id, text.trim());
}

export function clearPromptOverrides(): void {
  overrides.clear();
}

export function readPrompt(rel: string): string {
  const id = rel.endsWith(".txt") ? rel.slice(0, -4) : rel;
  const override = overrides.get(id);
  if (override !== undefined) return override;
  const file = join(promptsDir(), `${id}.txt`);
  return readFileSync(file, "utf-8").trim();
}
