/**
 * 考据本的唯一 IO：`<novel>/.talemate/research/<题目>.md`。
 *
 * 落在 `.talemate/` 而不是第四个根：不进 `DOC_ROOTS`，read/list/search、不变量与结构规范一概够不着它，
 * 也不需要用户拍板、不进版本控制；代价是全产品只有 `recall` 一个读口，垃圾笔记的出路只有文件系统。
 *
 * 单开一个模块是因为取数只有一个口：`src/tool/` 不许 import `node:fs`、也不许 import 本层，
 * `src/framework/` 不许 import `node:fs`（`tests/layering.test.ts` 钉着），而 recall 要列目录
 * ——IO 落在这里，策略在 `framework/research.ts`，工具是两个薄壳。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths, talemateHome } from "../core/config";
import { readText, writeAtomic } from "./atomic";
import { safeName } from "./util";

/**
 * 题目长度上限。文件系统对单个路径名有 255 字节的上限，而一个汉字 3 字节——60 字留足余量，
 * 也逼题目保持"一句话"的规模（它是 recall 的命中面）。
 */
export const MAX_NOTE_NAME = 60;

/**
 * 工具许建的题目：必须原样通过。
 *
 * 这里不能只写 `safeName(name) !== undefined`：`safeName` 会 `split(/[\\/]/).pop()`，
 * 于是 `"a/b"` 悄悄变成 `"b"`、`"../x"` 变成 `"x"`——静默改名，落成一个模型自己都不知道的
 * 名字，从此 recall 再也找不回来（比拒绝坏得多，拒绝至少是可自愈的）。
 * 顺带：空格与 `《》：` 都不在 `safeName` 的字符类里，中文题目要避开标点。
 *
 * 尾部 `.md` 摘掉：调用方给的是题目，不是文件名，`"明代税制.md"` 不该落成 `明代税制.md.md`。
 */
export function safeNoteName(raw: string): string | undefined {
  const name = raw.trim().replace(/\.md$/i, "");
  if (!name || name.length > MAX_NOTE_NAME) return undefined;
  // 点开头的一律拒（含 `.` 与 `..`）。字符类允许点，只靠 `safeName` 拦不住——而写侧放行的名字
  // 必须读侧也认：`readNote` 挡点开头的名字，若这里放行，那条笔记就写得进去、列得出来、
  // 却读不回来。两边清单是同一份，所以在这里堵。
  if (name.startsWith(".")) return undefined;
  return safeName(name) === name ? name : undefined;
}

/** 笔记文件的绝对路径。唯一一处"题目 → 路径"的映射，别处不再拼一遍。 */
export function noteAbs(projectId: string, name: string): string {
  return join(projectPaths(talemateHome(), projectId).research, `${name}.md`);
}

/** 笔记的项目相对写法——与作品文档同一个口径，只是根在 `.talemate/` 下（同 `planRelPath`）。 */
export function noteRelPath(name: string): string {
  return `.talemate/research/${name}.md`;
}

/**
 * 已有的题目（不含 `.md`），已排序。
 *
 * 不按字符类过滤，同 `corpus.enumerateDocs` 的理由：能枚举出来却读不回来的文件，就是
 * 两侧判据不一致的坑。手放进去的文件（用户自己丢一份笔记进来）在这里也照收。
 */
export async function listNoteNames(projectId: string): Promise<string[]> {
  const dir = projectPaths(talemateHome(), projectId).research;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3))
      .sort();
  } catch {
    return []; // 还没有过任何一条笔记（懒建：目录由第一次写入产生）
  }
}

/**
 * 读一条笔记的原文。只挡目录穿越，不限字符类——同 `corpus` 里 `safeReadPath` 的那条不对称：
 * 写侧限的是"工具许建什么名字"，读侧限的只是"出不出得了那个目录"。两边都上字符类，就会造出
 * 枚举得出来却读不回来的文件。
 */
export async function readNote(projectId: string, name: string): Promise<string | undefined> {
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) return undefined;
  return readText(noteAbs(projectId, name));
}

/**
 * 落一条笔记：整篇覆盖，不做 CAS。
 *
 * 同名即覆盖是功能不是副作用——重查之后要用新结论换掉旧结论，而"换"的入口就是重新记一遍
 * 同一个题目。做法与 `savePlan` 一致（`writeAtomic`，目录由它自己 mkdir）。
 */
export async function writeNote(projectId: string, name: string, doc: string): Promise<void> {
  // 调用方必须先过 `safeNoteName`（工具层就是这么做的）。走到这里还不合法 = 有人绕过了校验，
  // 那是编程错误，不是用户输入——宁可炸出来，也不要"写一个别的名字上去"。
  if (safeNoteName(name) !== name) throw new Error(`考据本的题目不合法：${JSON.stringify(name)}`);
  await writeAtomic(noteAbs(projectId, name), doc);
}
