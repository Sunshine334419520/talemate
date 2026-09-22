/**
 * atomic：**落盘的唯一原语**——先写同目录临时文件再 rename，且写之前比对"我读到的那一份还在不在"。
 *
 * 两个问题各治一样：
 *
 * - **中途断掉会留下半份文件**。裸 `writeFile` 不是原子的：进程被杀、磁盘满、断电，读者会看到
 *   一个被截断的 core.md 或半章正文。而这两样东西是作品本身，没有第二份可以对照恢复。
 *   所以先写 `.tmp` 再 `rename`——rename 在同一文件系统内是原子的，读者要么看到旧的、要么看到新的。
 *   临时文件**必须与目标同目录**（跨设备 rename 不是原子的，还可能直接失败）。
 *
 * - **读与写之间文件被改掉**。落盘前有一串 await（算 diff、弹窗等用户回话），这中间文件可能变
 *   ——另一个工具调用，或者用户拿编辑器手改。只读一次然后照着写，等于把那次改动悄悄盖掉，
 *   而且没有任何痕迹。所以写之前重读一遍、比对 `expected`，不等就抛 StaleContentError。
 *
 * 边界：这里只管"一个绝对路径上的字节"。不认识 design/ 与 chapters/ 的区别，不认识小节、
 * 提案、权限。那些在 framework/write_ops.ts。
 *
 * **残留窗口（已知、有意）**：CAS 只覆盖同进程。进程外（用户手改文件）在"重读"与"rename"之间
 * 仍有一个极窄的窗口。POSIX 没有 compare-and-swap，关不掉；CLI 是单进程，实际情况里这个窗口
 * 只对手动编辑敞开，而那种改动本来就会在下一次读时被发现。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 落盘时发现文件不是我们读到的那一份。
 *
 * 它是一个**并发保护**而不是错误处理：调用方应当把它转成给模型的自愈文案
 * （"重新读一遍再来"），而不是让它冒到用户面前。
 */
export class StaleContentError extends Error {
  constructor(readonly abs: string) {
    super(`文件在读取与落盘之间被改动过：${abs}`);
    this.name = "StaleContentError";
  }
}

/** 读文本；不存在返回 undefined（与"读失败"区分开——不存在的文件是常态，不是错误）。 */
export async function readText(abs: string): Promise<string | undefined> {
  try {
    return await readFile(abs, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * 同一路径上的落盘串行化。
 *
 * 一次工具调用里有好几个 await 点，两次调用可以在那里交错——没有这把锁，
 * 两个 read-modify-write 会各自读到同一份旧内容，后写的那个把先写的盖掉。
 * 锁是**进程内**的（见文件头的残留窗口）。
 */
const locks = new Map<string, Promise<void>>();

async function withLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(abs) ?? Promise.resolve();
  const run = prev.then(fn);
  // 链上挂一个永不拒绝的哨兵给后来者等：一次失败不该把整条链毒住，让后面每次都立刻炸。
  const gate = run.then(
    () => {},
    () => {},
  );
  locks.set(abs, gate);
  try {
    return await run;
  } finally {
    if (locks.get(abs) === gate) locks.delete(abs);
  }
}

/** 临时文件落盘 + rename。**调用方必须已持有该路径的锁**。 */
async function writeUnlocked(abs: string, content: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  // 前缀点 + uuid：不会与任何真实文档撞名；尾部 .tmp 让它进不了 listDesigns（那只收 .md）
  const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true }); // 失败别在项目目录里留垃圾
    throw e;
  }
}

/** 无条件原子写（新建或覆盖）。给没有可比对基准的调用方用（会话元、项目元）。 */
export async function writeAtomic(abs: string, content: string): Promise<void> {
  await withLock(abs, () => writeUnlocked(abs, content));
}

/**
 * 比对后原子写——**写盘路径都该走这一个**。
 *
 * `expected` 是调用方读取时看到的字节；`null` 表示"当时这个文件还不存在"，
 * 于是它顺带成了新建的排他检查（期望不存在却存在 → 陈旧，拒绝）。
 */
export async function writeIfUnchanged(opts: {
  abs: string;
  expected: string | null;
  content: string;
}): Promise<{ created: boolean }> {
  return withLock(opts.abs, async () => {
    const current = await readText(opts.abs);
    if ((current ?? null) !== opts.expected) throw new StaleContentError(opts.abs);
    await writeUnlocked(opts.abs, opts.content);
    return { created: current === undefined };
  });
}

/** 比对后删除：删掉一个用户刚改过的文档同样是"盖掉改动"，所以也要 CAS。 */
export async function removeIfUnchanged(opts: { abs: string; expected: string | null }): Promise<void> {
  await withLock(opts.abs, async () => {
    const current = await readText(opts.abs);
    if ((current ?? null) !== opts.expected) throw new StaleContentError(opts.abs);
    await rm(opts.abs, { force: true });
  });
}
