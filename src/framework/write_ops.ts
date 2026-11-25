/**
 * write_ops：所有改文件的操作唯一的一条路径。
 *
 * 七步，顺序即不变量：
 *
 *   1 解析目标    项目相对路径 → 绝对路径 + 安全校验 + 权限 pattern
 *   2 读当前      不存在 → undefined
 *   3 算结果      FileOp → 新字节（模糊匹配在这一步，见 file_ops.ts）
 *   4 算 diff     给用户看的材料
 *   5 取批准      二向弹窗（接受 / 拒绝），diff 就是用户审的那一版
 *   6 CAS + 原子写
 *   7 返回        diff / 统计 / 命中了哪一级
 *
 * 写成功后另记一条写前快照（`seq` + `before`），供"回退对话并还原文件"；记快照失败不影响落盘。
 * 每一笔都带 CAS；"唯一写路径"由 `ToolContext` 上只有一个写口保证，不是约定。
 *
 * 只有一条路：算完结果、渲染 diff，再弹窗问用户。整篇写与局部改都走它——没有"提案登记"那一半，
 * 因为写前 diff 已经把要落的字节摆出来了（`write` 新建时 diff 全是新增行，就是一份整篇预览）。
 *
 * 边界：不认识"层""角色卡""小节"。领域语义在工具层（派生成 op），内容不变量在 invariants.ts。
 * 也不认识根的名单：可写边界是项目根表里 `write` 的那些根，写口与读口从同一张表取数（见 core/roots.ts）。
 */
import { join } from "node:path";
import { PLAN_KEY } from "../core/types";
import type { FileOp, PermissionVerdict, ToolContext, WriteChange } from "../core/types";
import { PROSE_MODE } from "../agent/modes";
import { corpusRootAbs, projectCorpusRoots } from "../core/config";
import { writableCorpusRoots } from "../core/roots";
import { readText, removeIfUnchanged, StaleContentError, writeIfUnchanged } from "../storage/atomic";
import { recordFileCheckpoint } from "../storage/file-history";
import { joinBom, splitBom } from "../storage/bom";
import { safeRelPath } from "../storage/util";
import { diffLines, renderDiff } from "./diff";
import { computeNext, normalizeLineEndings } from "./file_ops";
import { formatProse } from "./format_prose";
import { checkInvariants } from "./invariants";
import type { MatchLevel } from "./match";

export type WriteFailure =
  /** 目标文件不存在（replace / delete 用） */
  | "notfound"
  /** 路径不合法、或指向不可写的根 */
  | "invalid"
  /** 用户在这次弹窗里拒了 */
  | "rejected"
  /** 规则表不许（如计划模式的只读） */
  | "denied"
  /** 读之后、写之前文件被改过 */
  | "stale";

/**
 * 直写：算结果 → 渲染 diff → 弹窗二向（接受 / 拒绝）→ 落盘。
 *
 * `note` 是给用户做判断用的额外材料（如删小节前的引用检查），排在 diff 之前——光有 diff
 * 看不出"这个改动会牵连哪些别的文档"。
 */
export interface WriteRequest {
  op: FileOp;
  action: string;
  note?: string;
}

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
      /** 界面按轮汇总用；模型看不到。没有实际改动（内容相同）时为空 */
      change?: WriteChange;
    }
  | { ok: false; reason: WriteFailure; output: string };

interface Target {
  abs: string;
  /** 归一化后的项目相对路径——权限用的就是它，两者不会各说各话 */
  pattern: string;
}

function resolveTarget(projectId: string, path: string): Target | { error: string } {
  const clean = path.replace(/\\/g, "/");
  const roots = writableCorpusRoots(projectCorpusRoots(projectId));
  let best: { spec: (typeof roots)[number]; rel: string } | undefined;
  for (const spec of roots) {
    if (!clean.startsWith(`${spec.dir}/`)) continue;
    const rel = safeRelPath(clean.slice(spec.dir.length + 1));
    if (rel === undefined) continue;
    if (best === undefined || spec.dir.length > best.spec.dir.length) best = { spec, rel };
  }
  if (best === undefined) {
    const dirs = roots.map((r) => r.dir);
    return {
      error:
        `目标要写成 <根>/<相对路径>，这本书可写的根只有 ${dirs.join(" / ")}` +
        `（收到：${path}）。`,
    };
  }
  return { abs: join(corpusRootAbs(projectId, best.spec.id), best.rel), pattern: `${best.spec.dir}/${best.rel}` };
}

/**
 * 走一遍写盘。校验不过 / 用户拒了 / 陈旧 → `{ ok:false, output }`（回给模型自愈，不抛）。
 */
export async function writeFile(ctx: ToolContext, req: WriteRequest): Promise<WriteOutcome> {
  const op = req.op;
  const tryAction = req.action;
  // CAS 的基准就是"我刚刚读到的那一份"
  const expected: string | null | undefined = undefined;

  const target = resolveTarget(ctx.projectId, op.path);
  if ("error" in target) return { ok: false, reason: "invalid", output: target.error };
  const checkDeny = target.pattern;

  // 规划已批准、正文还没落盘时，章节写入必须先进入正文模式；否则 mate.system 还在，
  // 声口切换不会发生。这是模式的结构性用途，不是提示词劝告。
  const plan = ctx.getProposal(PLAN_KEY);
  if (
    target.pattern.startsWith("chapters/") &&
    plan?.approved === true &&
    plan.done !== true &&
    ctx.getMode() !== PROSE_MODE
  ) {
    return {
      ok: false,
      reason: "invalid",
      output: "规划已批准，但还没进入正文模式。先把前置产物落完，调用 enter-prose，再写这一章正文。",
    };
  }

  // 读回来的字节原样留着（含 BOM）——CAS 比的就是它，得逐字节忠实。
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
  // 正文的“一句一段”在落盘前确定性地做，不靠模型数句号；设计/状态文档不碰。
  const after =
    next.action === "write" && target.pattern.startsWith("chapters/")
      ? formatProse(nextSplit.text)
      : nextSplit.text;

  // 对结果做后验（不是对提案）。放在算 diff 之前：违反不变量就不该问用户，
  // 也不该让他看见一份注定落不下去的 diff。
  const violation = checkInvariants({ path: target.pattern, opKind: op.kind, before: current, after });
  if (violation) return { ok: false, reason: "invalid", output: violation };

  // diff 按归一行尾的形态算：行尾是文件自己的属性，不归一的话一份 `\r\n` 的文档
  // 在 diff 里会每行都是改动，用户看到的全是噪音。
  const d = diffLines(normalizeLineEndings(current ?? ""), normalizeLineEndings(after));
  const diff = renderDiff(d);

  // ─── 取批准 ───
  const verdict: PermissionVerdict = await ctx.ask({
    permission: "edit",
    pattern: checkDeny,
    always: checkDeny,
    summary: tryAction,
    // 材料分两段，空行隔开：先影响面，后这次具体动什么。顺序反过来，用户得先读完 diff
    // 才知道该拿什么去判断。没有前一段时不留空行（空串会被 filter 掉，不是塞个 "" 占位）。
    detail: [
      ...(req.note ? [req.note] : []),
      ...(next.action === "remove" ? [`将删除 ${checkDeny}。`] : []),
      diff,
    ].join("\n\n"),
  });
  if (verdict === "deny") {
    return { ok: false, reason: "denied", output: `当前模式不允许改文件。要改就先离开这个模式。` };
  }
  if (verdict === "reject") {
    return { ok: false, reason: "rejected", output: `用户已拒绝：${tryAction}` };
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

  const kind: WriteChange["kind"] =
    next.action === "remove" ? "deleted" : next.isNew ? "created" : "modified";
  // 内容一模一样地写回去不产生记录；新建/删除即使内容为空也算一次实际变动
  const changed = kind !== "modified" || d.additions > 0 || d.deletions > 0;

  // 写成功之后再记快照：写失败/被拒的文件不该进回退账。记失败不回滚已落盘的写——
  // 那会让用户刚看到的 diff 与盘上不一致；代价只是这次回退还原不了这个文件。
  if (changed && ctx.turnSeq !== undefined) {
    try {
      await recordFileCheckpoint(ctx.projectId, ctx.sessionId, {
        seq: ctx.turnSeq,
        path: target.pattern,
        before: raw ?? null,
      });
    } catch {
      // 见上：快照是回退的附加能力，不是落盘的前置条件
    }
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
    // 新建文件的正文就在盘上，界面点开读全文；不把整份内容再抄进记录。
    change: changed
      ? { path: target.pattern, kind, diff: kind === "created" ? "" : diff, additions: d.additions, deletions: d.deletions }
      : undefined,
  };
}
