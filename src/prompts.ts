/**
 * 提示词加载：所有自带 prompt 放仓库根 prompts/*.txt（内容即文件，便于 diff/review）。
 * readPrompt("writer.system") → prompts/writer.system.txt。相对 import.meta.url 解析，不依赖 cwd。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(SRC_DIR, "..", "prompts");

export function readPrompt(rel: string): string {
  const file = join(PROMPTS_DIR, rel.endsWith(".txt") ? rel : `${rel}.txt`);
  return readFileSync(file, "utf-8").trim();
}
