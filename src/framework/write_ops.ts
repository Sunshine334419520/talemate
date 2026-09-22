/**
 * write_ops：**所有改文件的操作唯一的一条路径**。
 *
 * 八步，**顺序即不变量**：
 *
 *   1 解析目标    项目相对路径 → 绝对路径 + 安全校验 + 权限 pattern
 *   2 读当前      不存在 → undefined
 *   3 算结果      FileOp → 新字节（模糊匹配在这一步，见 file_ops.ts）
 *   4 算 diff     给用户看的材料
 *   5 取批准      二向弹窗，或三向提案
 *   6 CAS + 原子写
 *   7 返回        diff / 统计 / 命中了哪一级
 *
 * 为什么要有这一层：从前"改一个文件"有六条入口、三套存储原语，各自读-改-写、各自问用户，
 * 于是 CAS 只有一处有、绕过写盘唯一实现的地方没人抓得到。收成一条之后，**每一笔都带 CAS**，
 * 而"唯一写路径"由 `ToolContext` 上只有一个写口来保证（不再是约定）。
 *
 * 两个批准来源，一条路径：
 * - `via:"confirm"` —— 二向。算完结果、渲染 diff，再弹窗问用户（接受 / 拒绝）。
 * - `via:"pending"` —— 三向。op **不从这里进**，只从提案登记里取（`proposalOp`）——
 *   所以"模型夹带用户没看过的字节"在结构上不可能，不是靠检查拦住的。
 *
 * 边界：不认识"层""角色卡""小节"。领域语义在工具层（派生成 op），内容不变量在 invariants.ts。
 */
import { join } from "node:path";
import type { FileOp, PermissionVerdict, ToolContext } from "../core/types";
import { talemateHome, projectPaths } from "../core/config";
import { readText, removeIfUnchanged, StaleContentError, writeIfUnchanged } from "../storage/atomic";
import { joinBom, splitBom } from "../storage/bom";
import { safeRelPath } from "../storage/util";
import { diffLines, renderDiff } from "./diff";
import { computeNext, normalizeLineEndings } from "./file_ops";
import { checkInvariants } from "./invariants";
import type { MatchLevel } from "./match";
import { proposalOp } from "./proposal";

/** 可写的两个根。**刻意只有两个**——加第三个根要同时想清楚权限 pattern 与常驻注入。 */
export const WRITE_ROOTS = ["design", "chapters"] as const;

export type WriteFailure =
  /** 目标文件不存在（replace / append / delete 用） */
  | "notfound"
  /** 路径不合法、或指向不可写的根 */
  | "invalid"
  /** 用户在这次弹窗里拒了 */
  | "rejected"
  /** 规则表不许（如计划模式的只读） */
  | "denied"
  /** 读之后、写之前文件被改过 */
  | "stale"
  /** 提案那条路：没有待落盘提案，或用户还没同意 */
  | "notapproved";

export type WriteRequest =
  /**
   * 直写：算结果 → 渲染 diff → 弹窗二向 → 落盘。
   *
   * `note` 是给用户**做判断用的额外材料**（如删小节前的引用检查），排在 diff 之前——
   * 光有 diff 看不出"这个改动会牵连哪些别的文档"。
   */
  | { via: "confirm"; op: FileOp; action: string; note?: string }
  /** 落提案：op 只从提案登记取，**不接受正文**。 */
  | { via: "pending"; proposalKey: string; action: string };

export type WriteOutcome =
  | {
      ok: true;
      /** 项目相对路径，与权限 pattern 同口径 */
      path: string;
      isNew: boolean;
      diff: string;
      additions: number;
      deletions: number;
      match?: MatchLevel;
      count?: number;
    }
  | { ok: false; reason: WriteFailure; output: string };

interface Target {
  abs: string;
  /** 归一化后的项目相对路径——权限用的就是它，两者不会各说各话 */
  pattern: string;
}

function resolveTarget(projectId: string, path: string): Target | { error: string } {
  const clean = path.replace(/\\/g, "/");
  const root = WRITE_ROOTS.find((r) => clean.startsWith(`${r}/`));
  if (!root) {
    return {
      error:
        `目标要写成 <根>/<相对路径>，可写的根只有 ${WRITE_ROOTS.join(" 与 ")}` +
        `（收到：${path}）。`,
    };
  }
  const rel = safeRelPath(clean.slice(root.length + 1));
  if (!rel) return { error: `非法路径：${path}` };
  const pp = projectPaths(talemateHome(), projectId);
  return { abs: join(root === "design" ? pp.design : pp.chapters, rel), pattern: `${root}/${rel}` };
}

/**
 * 走一遍写盘。校验不过 / 用户拒了 / 陈旧 → `{ ok:false, output }`（回给模型自愈，不抛）。
 *
 * 只有**调用方写错**才抛（提案那条路上 op 与登记不符），因为那不是模型能修的问题。
 */
export async function writeFile(ctx: ToolContext, req: WriteRequest): Promise<WriteOutcome> {
  // ─── 5 之前先定 op：pending 那条路只认提案登记里的那一份 ───
  let op: FileOp;
  let tryAction: string;
  let expected: string | null | undefined;
  let checkDeny: string;

  if (req.via === "confirm") {
    op = req.op;
    tryAction = req.action;
    expected = undefined; // 直写不比快照：CAS 的基准就是"我刚刚读到的那一份"
  } else {
    const p = ctx.getProposal(req.proposalKey);
    if (!p) {
      return {
        ok: false,
        reason: "notapproved",
        output: `没有 ${req.proposalKey} 的待落盘提案——先用 propose-design 把这一版交给用户过目，等用户回话再来。`,
      };
    }
    if (!p.approved) {
      return {
        ok: false,
        reason: "notapproved",
        output:
          "用户还没同意这一版提案，不能落盘。请按用户这几轮说的话重新 propose-design；" +
          "落盘的永远只能是用户看过并认可的那一版。",
      };
    }
    const derived = proposalOp(p);
    if (!derived) {
      return {
        ok: false,
        reason: "notapproved",
        output: `${req.proposalKey} 不是一份待落盘的文档（节拍不落盘）——它解锁的是别的动作，不是写文件。`,
      };
    }
    op = derived;
    tryAction = req.action;
    // 提案登记时的那份快照就是 CAS 基准：文件在提案之后被改过 → 拒绝
    expected = p.base ?? null;
  }

  const target = resolveTarget(ctx.projectId, op.path);
  if ("error" in target) return { ok: false, reason: "invalid", output: target.error };
  checkDeny = target.pattern;

  // 读回来的字节**原样**留着（含 BOM）——CAS 比的就是它，得逐字节忠实。
  const raw = await readText(target.abs);
  const source = raw === undefined ? undefined : splitBom(raw);
  // 没有 BOM 的正文才是内容本身：匹配、算结果、算 diff 都用它，免得那个不可见字符
  // 混进模型的 find、混进展示给人看的材料。
  const current = source?.text;

  const next = computeNext(op, current);
  if (!next.ok) {
    return { ok: false, reason: current === undefined ? "notfound" : "invalid", output: next.output };
  }

  const nextSplit = next.action === "remove" ? { bom: false, text: "" } : splitBom(next.content);
  // 沿用文件原有的 BOM；文件本来没有、而模型显式带了一个，才采用它（见 storage/bom.ts）
  const desiredBom = (source?.bom ?? false) || nextSplit.bom;
  const after = nextSplit.text;

  // **对结果做后验**（不是对提案）。放在算 diff 之前：违反不变量就不该问用户，
  // 也不该让他看见一份注定落不下去的 diff。
  const violation = checkInvariants({ path: target.pattern, opKind: op.kind, before: current, after });
  if (violation) return { ok: false, reason: "invalid", output: violation };

  // diff 按**归一行尾**的形态算：行尾是文件自己的属性，不归一的话一份 `\r\n` 的文档
  // 在 diff 里会每行都是改动，用户看到的全是噪音。
  const d = diffLines(normalizeLineEndings(current ?? ""), normalizeLineEndings(after));
  const diff = renderDiff(d);

  // ─── 取批准 ───
  if (req.via === "pending") {
    // 三向的"同意"已经在提案那一轮拿过了，这里不再弹窗；但**仍然过规则表**——
    // "不许"不因为问过一次就失效（如计划模式的只读）。
    if (ctx.check("edit", checkDeny) === "deny") {
      return { ok: false, reason: "denied", output: `当前模式不允许改文件。要改就先离开这个模式。` };
    }
  } else {
    const verdict: PermissionVerdict = await ctx.ask({
      permission: "edit",
      pattern: checkDeny,
      always: checkDeny,
      summary: tryAction,
      detail: [req.note, next.action === "remove" ? `将删除 ${checkDeny}。` : undefined, "", diff]
        .filter((s) => s !== undefined)
        .join("\n"),
    });
    if (verdict === "deny") {
      return { ok: false, reason: "denied", output: `当前模式不允许改文件。要改就先离开这个模式。` };
    }
    if (verdict === "reject") {
      return { ok: false, reason: "rejected", output: `用户已拒绝：${tryAction}` };
    }
  }

  // ─── CAS + 原子写 ───
  try {
    if (next.action === "remove") {
      await removeIfUnchanged({ abs: target.abs, expected: raw ?? null });
    } else {
      await writeIfUnchanged({
        abs: target.abs,
        expected: expected === undefined ? (raw ?? null) : expected,
        content: joinBom(after, desiredBom),
      });
    }
  } catch (e) {
    if (e instanceof StaleContentError) {
      return {
        ok: false,
        reason: "stale",
        output:
          `${target.pattern} 在读取与落盘之间被改动过（或新建/删除了）——现在写下去会盖掉那次改动。` +
          "请重新读一遍，按当前的内容再来。",
      };
    }
    throw e;
  }

  return {
    ok: true,
    path: target.pattern,
    isNew: next.action === "remove" ? false : next.isNew,
    diff,
    additions: d.additions,
    deletions: d.deletions,
    match: next.action === "remove" ? undefined : next.match,
    count: next.action === "remove" ? undefined : next.count,
  };
}
