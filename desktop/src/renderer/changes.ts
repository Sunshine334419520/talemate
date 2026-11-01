/**
 * 把一轮里的若干次落盘按文件合并成清单行。
 *
 * 只做分组与排序，不碰 DOM。显示名与先后由目录树给（`labelOf` / `rankOf`）——界面上
 * 不另写一份"哪份文档叫什么"的清单。
 *
 * 输入有两种来源：内存里的 `WriteChange`（有 diff，本轮改动卡）和索引里的 `ChangePoint`
 * （有指针，没有 diff，历史视图）。历史行的 diff 在点开时才按指针去取。
 */
import type { ChangeRef } from "../../../src/core/types";

/** 两种来源的公共形状：索引项没有 diff，内存项没有指针。 */
export interface ChangeLike extends ChangeRef {
  diff?: string;
  messageSeq?: number;
  callId?: string;
}

export interface ChangeRow {
  path: string;
  label: string;
  /** 这一轮结束时的净变化：先建后改仍是新建，最后删掉就是删除 */
  kind: "created" | "modified" | "deleted";
  /** 这一轮对这份文件写了几次——同一个文件被 edit 三次仍是一行 */
  count: number;
  /** 这一轮的 diff 拼在一起；空 = 需要按 `refs` 懒加载，或新建文件本来就没有 diff */
  diff: string;
  /** 从索引来的行带着指针；内存来的行没有 */
  refs: { messageSeq: number; callId: string }[];
}

export function groupChanges(
  changes: readonly ChangeLike[],
  labelOf: (path: string) => string,
  rankOf: (path: string) => number,
): ChangeRow[] {
  const byPath = new Map<string, ChangeLike[]>();
  for (const c of changes) {
    const list = byPath.get(c.path);
    if (list === undefined) byPath.set(c.path, [c]);
    else list.push(c);
  }

  const rows: ChangeRow[] = [];
  for (const [path, list] of byPath) {
    const last = list[list.length - 1];
    const kind: ChangeRow["kind"] =
      last.kind === "deleted"
        ? "deleted"
        : list.some((c) => c.kind === "created")
          ? "created"
          : "modified";
    rows.push({
      path,
      label: labelOf(path),
      kind,
      count: list.length,
      diff: list
        .map((c) => c.diff ?? "")
        .filter((d) => d !== "")
        .join("\n\n"),
      refs: list.flatMap((c) =>
        c.messageSeq === undefined || c.callId === undefined
          ? []
          : [{ messageSeq: c.messageSeq, callId: c.callId }],
      ),
    });
  }

  return rows.sort((a, b) => rankOf(a.path) - rankOf(b.path) || a.label.localeCompare(b.label, "zh"));
}
