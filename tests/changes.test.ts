/**
 * 一轮里的多次落盘 → 按文件合并的清单行。摘要卡与历史视图共用这一份分组。
 */
import { describe, expect, test } from "bun:test";
import type { WriteChange } from "../src/core/types";
import { groupChanges } from "../desktop/src/renderer/changes";

const change = (path: string, kind: WriteChange["kind"], diff = "- old\n+ new"): WriteChange => ({
  path,
  kind,
  diff: kind === "created" ? "" : diff,
  additions: 1,
  deletions: 1,
});

const labelOf = (path: string): string => path.split("/").pop() ?? path;
const rankOf = (path: string): number => ["characters/陈六.md", "characters/艄公.md", "chapters/ch6.md"].indexOf(path);

describe("按文件合并改动", () => {
  test("同一个文件写三次仍是一行，次数保留", () => {
    const rows = groupChanges(
      [
        change("chapters/ch6.md", "modified", "- a\n+ b"),
        change("chapters/ch6.md", "modified", "- c\n+ d"),
        change("chapters/ch6.md", "modified", "- e\n+ f"),
      ],
      labelOf,
      rankOf,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.kind).toBe("modified");
    expect(rows[0]?.diff.split("\n\n")).toHaveLength(3);
  });

  test("先建后改仍算新建", () => {
    const rows = groupChanges(
      [change("characters/陈六.md", "created"), change("characters/陈六.md", "modified")],
      labelOf,
      rankOf,
    );
    expect(rows[0]?.kind).toBe("created");
  });

  test("最后删掉就是删除", () => {
    const rows = groupChanges(
      [change("characters/陈六.md", "modified"), change("characters/陈六.md", "deleted")],
      labelOf,
      rankOf,
    );
    expect(rows[0]?.kind).toBe("deleted");
  });

  test("按目录顺序排，不按写入顺序", () => {
    const rows = groupChanges(
      [change("chapters/ch6.md", "modified"), change("characters/艄公.md", "created"), change("characters/陈六.md", "created")],
      labelOf,
      rankOf,
    );
    expect(rows.map((r) => r.label)).toEqual(["陈六.md", "艄公.md", "ch6.md"]);
  });
});
