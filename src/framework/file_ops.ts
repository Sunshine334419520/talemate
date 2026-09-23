/**
 * file_ops：`FileOp` → **新内容**的纯函数。
 *
 * 只做一件事：给定 op 和文件当前的内容，算出它该变成什么。读盘、审批、落盘、不变量后验
 * 都不在这里——那些在 `write_ops.ts`（唯一的写盘管线）。
 *
 * 为什么把这一层单独拆出来：它是整条链上唯一**会产生字节**的一步，也是最容易出错的一步
 * （模糊匹配、唯一性、跨度失控都在这里）。纯函数意味着它能被穷举测试，而不用起临时目录。
 */
import type { FileOp } from "../core/types";

import { applyReplace, type MatchLevel } from "./match";

/**
 * 行尾有两种：`\n` 与 `\r\n`。**文件用哪一种，是文件自己的属性**——ASCII 之外的字符在两种
 * 写法下是同样的文本，所以模型（以及大多数编辑器）倾向写 `\n`。
 */
export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * 先把两种行尾归一成 `\n`、再转成目标那一种。**用来适配模型给的片段去就文件的写法**：
 * 模型写 `\n`、文件是 `\r\n` 时，不转就永远找不到。
 *
 * 方向很重要：**文件自己那份字节不归一**——那是"用户没让我碰的字节"，整篇转一遍会把
 * 一份混合行尾的文档悄悄改成统一的。只有模型新给的、要并进去的片段才转。
 */
export function toLineEnding(text: string, ending: "\n" | "\r\n"): string {
  const normalized = normalizeLineEndings(text);
  return ending === "\n" ? normalized : normalized.replaceAll("\n", "\r\n");
}

/** 两种行尾都归成 `\n`。给**算 diff** 用：行尾差异不是内容差异，混进去会让整篇看着都像改了。 */
export function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export type OpOutcome =
  | {
      ok: true;
      action: "write";
      content: string;
      isNew: boolean;
      /** 只有 replace 会给出：命中的是哪一级、换了几处 */
      match?: MatchLevel;
      count?: number;
    }
  | { ok: true; action: "remove" }
  | { ok: false; output: string };

/**
 * `current` 是文件现在的字节；`undefined` = 文件不存在。
 *
 * 失败一律走返回值，文案是给模型的自愈线索（CLAUDE.md：模型能修的走 return，不走 throw）。
 */
export function computeNext(op: FileOp, current: string | undefined): OpOutcome {
  switch (op.kind) {
    case "write":
      return { ok: true, action: "write", content: op.content, isNew: current === undefined };

    case "replace": {
      if (current === undefined) {
        return { ok: false, output: `没有找到 ${op.path}——要新建一份请用 write，改一份已存在的才用 replace。` };
      }
      // 只把**模型给的**两侧适配到文件的写法；current 原样参与匹配与替换
      const ending = detectLineEnding(current);
      const r = applyReplace(current, toLineEnding(op.find, ending), toLineEnding(op.replace, ending), op.all);
      if (!r.ok) return { ok: false, output: r.output };
      return { ok: true, action: "write", content: r.content, isNew: false, match: r.level, count: r.count };
    }

    case "delete": {
      if (current === undefined) return { ok: false, output: `没有找到 ${op.path}，无法删除。` };
      return { ok: true, action: "remove" };
    }
  }
}
