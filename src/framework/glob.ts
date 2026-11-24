/**
 * glob：项目相对路径的模式匹配。
 *
 * 只支持第一版需要的那一小撮语法：`*`（段内任意，不跨 `/`）、`**`（任意层）、`?`（段内一个字符）。
 * 不支持 brace/extglob/取反——这些写错时按字面处理，不会静默变成另一种语义。
 *
 * **无 `/` 的模式按文件名在任意深度匹配**（`*.md` = 所有 md）。这是 ripgrep / opencode 的直觉，
 * 也是模型最常写的那一种；要"只在根下一层"就写 `*`? 不——写 `./*.md` 也还是同一语义。
 * 想限定目录请用路径模式（`design/*.md`）。
 *
 * 边界：纯文本匹配，不碰文件系统；候选集由 `framework/find.ts` 从语料层拿。
 */
import { platform } from "node:os";

/** 匹配用；`*` 不跨 `/`，`**` 跨 `/`，`?` 单字符。 */
function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * 编译成锚定整串的 RegExp。
 *
 * `**\/` 先占位再还原成 `(?:.*\/)?`，这样 `design/**\/*.md` 既命中 `design/a.md` 也命中
 * `design/wiki/a.md`；剩下的 `**` 还原成 `.*`。
 */
export function globToRegExp(pattern: string): RegExp {
  const clean = pattern.replace(/\\/g, "/").trim();
  const marker = "\u0001";
  const crossMarker = "\u0002";
  const hasSlash = clean.includes("/");
  const body = escapeRegex(clean)
    .replace(/\*\*\//g, marker)
    .replace(/\*\*/g, crossMarker)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll(marker, "(?:.*/)?")
    .replaceAll(crossMarker, ".*");
  const prefix = hasSlash ? "" : "(?:.*/)?";
  const flags = platform() === "win32" ? "i" : "";
  return new RegExp(`^${prefix}${body}$`, flags);
}

/** 项目相对路径是否匹配模式。路径里的反斜杠先归一成 `/`。 */
export function matchGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path.replace(/\\/g, "/"));
}