/**
 * 章节规划工件：**写一章之前那一份可执行规划**的落脚处、命名与渲染。
 *
 * ## 它为什么不在 design/
 *
 * `design/` + `chapters/` 是**作品**——用户的、要被审阅的、可以进版本控制的。规划是**引擎的工作区**：
 * 可清理、用户不必看、不参与 `list` / `search` / 不变量 / 结构规范。所以它落在
 * `<novel>/.talemate/plans/`——同一份"作品 / 工作区"的边界把 `sessions/` 也划在外面。
 *
 * 由此推出两条**不从这里走**的路（都是有意为之，不是漏做）：
 * - 不经 `framework/write_ops.ts`。那条路认识的是"作品文档"：diff 给用户看、CAS 比对、不变量后验、
 *   权限 pattern。规划一样都不需要——它由 `propose-plan` 整篇写、整篇渲染给用户看，
 *   用户看过的字节就是落盘的字节。
 * - 不进 `storage/corpus.ts` 的 `DOC_ROOTS`。规划不是文档，`read` / `list` / `search` 看不见它。
 *   这也是为什么 `renderPendingNote` 要**把路径报出来**：mate 在下一次压缩之后仍要知道它在哪。
 *
 * ## 命名与清理
 *
 * 一章一个文件、文件名由章号决定，所以**同名即覆盖**：给同一章再交一份规划就是替换掉旧的，
 * 别的章的规划一个不动。清理策略就是这一条——规划的数量由章数封顶，不需要按时间或次数删。
 * 执行完**不删**：它是"这一次执行"的记录，删掉之后"当初打算怎么写"就只剩消息历史了。
 */
import { join } from "node:path";
import { projectPaths, talemateHome } from "../core/config";
import { writeAtomic } from "../storage/atomic";
import { indentLines } from "./proposal";

/** 规划工件的**项目相对**写法——与作品文档同一个口径，只是根不同（它在 `.talemate/` 下）。 */
export function planRelPath(chapter: number): string {
  return `.talemate/plans/ch_${chapter}.md`;
}

/** 规划工件的绝对路径。**唯一**把章号变成路径的地方，别处不再拼一遍。 */
export function planAbs(projectId: string, chapter: number): string {
  return join(projectPaths(talemateHome(), projectId).plans, `ch_${chapter}.md`);
}

/**
 * 一份规划落盘时的**全文**：标题由章号生成，正文是模型交上来的那一份。
 *
 * 用户看到的与落到盘上的是同一个字符串（`renderPlan` 也从它渲染），所以标题栏不会两处各写各的。
 */
export function planDocument(chapter: number, content: string): string {
  return `# 第 ${chapter} 章规划\n\n${content.trim()}\n`;
}

/** 写规划工件（整篇覆盖，无条件原子写——同一章再交一份就是替换）。 */
export async function savePlan(projectId: string, chapter: number, content: string): Promise<string> {
  const rel = planRelPath(chapter);
  await writeAtomic(planAbs(projectId, chapter), planDocument(chapter, content));
  return rel;
}

/**
 * 渲染一份规划给用户看（纯函数，无 IO）。
 *
 * 与 `proposal.renderProposal` 的区别：规划**不是文档提案**——没有逐格编号、没有"第 N 格"、
 * 没有待定格、没有 apply 那一半。它批准的是**执行**（照着它去写正文），不是一次落盘。
 * 所以这里只有一条收尾契约：接受就开写，不接受就说要改哪儿。
 */
export function renderPlan(chapter: number, content: string): string {
  return [
    `──── 第 ${chapter} 章 · 规划 ────`,
    "",
    ...indentLines(content),
    "",
    "回复「没问题」就照这个写正文；要改直接说。",
  ].join("\n");
}
