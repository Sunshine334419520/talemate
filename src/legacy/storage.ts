import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 落盘到 experiments/output/<relPath>，返回完整路径 */
export async function save(relPath: string, content: string): Promise<string> {
  const full = `experiments/output/${relPath}`;
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
  return full;
}
