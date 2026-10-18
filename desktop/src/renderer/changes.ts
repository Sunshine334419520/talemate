/**
 * 把一轮里的若干次落盘按文件合并成清单行。
 *
 * 只做分组与排序，不碰 DOM。显示名与先后由目录树给（`labelOf` / `rankOf`）——界面上
 * 不另写一份"哪份文档叫什么"的清单。
 */
import type { WriteChange } from "../../../src/core/types";

export interface ChangeRow {
  path: string;
  label: string;
  /** 这一轮结束时的净变化：先建后改仍是新建，最后删掉就是删除 */
  kind: "created" | "modified" | "deleted";
  /** 这一轮对这份文件写了几次——同一个文件被 edit 三次仍是一行 */
  count: number;
  /** 这一轮的 diff 拼在一起；新建文件为空（正文就在盘上，点开读全文） */
  diff: string;
}

export function groupChanges(
  changes: readonly WriteChange[],
  labelOf: (path: string) => string,
  rankOf: (path: string) => number,
): ChangeRow[] {
  const byPath = new Map<string, WriteChange[]>();
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
        .map((c) => c.diff)
        .filter((d) => d !== "")
        .join("\n\n"),
    });
  }

  return rows.sort((a, b) => rankOf(a.path) - rankOf(b.path) || a.label.localeCompare(b.label, "zh"));
}
