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
 *
 * **这个函数管的是"工具许建什么名字"**（写侧、以及模型自报的路径）。要挡的只是"读得回什么"
 * 就别用它——见 `safeReadPath`。
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

/**
 * **只挡目录穿越**的路径规范化——读侧（`corpus.splitRoot`）用。
 *
 * 与 `safeRelPath` 的唯一区别是**不限制字符类**。那个类限制的是"工具建得出哪些名字"，
 * 拿它去限制"读得回哪些名字"，就会造出**看得见却读不着**的文件：枚举走真实目录、什么都看得见，
 * 而读回时被字符类挡掉。那正是 `corpus.ts` 要消灭的那种两侧不一致。
 *
 * 手放的文件（`characters/约翰·史密斯.md`——译名里的 `·` 不在那个类里）是这一类里最要紧的：
 * 工具建不出它，可它就在盘上、正文里就引用得到它。
 *
 * 安全性不打折：拒绝空串 / 绝对路径（含盘符）/ `.` `..` / 空段之后，`join(root, sub)` 出不了那个根。
 */
export function safeReadPath(name: string): string | undefined {
  const p = name.replace(/\\/g, "/");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return undefined;
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return undefined;
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
