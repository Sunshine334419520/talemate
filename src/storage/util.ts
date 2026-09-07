/** 小工具函数：slug / 随机后缀 / 安全文件名 / 行读取，供 storage 两个文件共用。 */
import { access, readFile, writeFile } from "node:fs/promises";

export function slugify(s: string): string {
  const ascii = s
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || "novel";
}

export function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function safeName(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop() ?? name; // 只取最后一段，防路径穿越
  return /^[\w一-鿿.\-]+$/.test(base) ? base : undefined;
}

/**
 * 设计文档的相对子路径（design/ 之下，允许一层以上目录，如 wiki/地理.md、characters/沈越.md）。
 * 反斜杠归一为 `/`；拒绝空串/绝对路径/`.` `..`/空段；每段限 [\w一-鿿.\-]+。防目录穿越。
 */
export function safeRelPath(name: string): string | undefined {
  const p = name.replace(/\\/g, "/");
  if (!p || p.startsWith("/")) return undefined;
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return undefined;
    if (!/^[\w一-鿿.\-]+$/.test(s)) return undefined;
  }
  return segs.join("/");
}

export async function readLines(file: string): Promise<string[]> {
  return readFile(file, "utf-8")
    .then((t) => (t ? t.split("\n") : []))
    .catch(() => [] as string[]);
}

export async function touch(file: string): Promise<void> {
  try {
    await access(file);
  } catch {
    await writeFile(file, "", "utf-8");
  }
}
