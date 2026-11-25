/**
 * invariants：对落盘后的字节做后验——这份文档还算不算工具读得懂。判据是"文档现在长什么样"，
 * 所以按路径选而不是按层选（glob，与权限同一套口径）。
 *
 * 在结果上判而不是在提案上判：`edit` / `write` / `delete` 都走这条后验，把写盘收成一条路径之后
 * 哪条路都绕不过。
 *
 * 上钩判据只有一个：违反了会不会造出一份**此后按标题读不懂**的文档。正文长什么样（有没有必填
 * 小节、用 `##` 还是 `###`）不在这里判——模板是建议，不是通行证（见 `docs/assets.md`）。
 */
import type { FileOp } from "../core/types";
import { match } from "../permission";
import { listHeadings } from "./markdown";

export interface InvariantInput {
  /** 项目相对路径（`design/characters/林晚.md`）——与权限 pattern 同一口径 */
  path: string;
  opKind: FileOp["kind"];
  /** 落盘前的正文（不含 BOM）；文件不存在 → undefined。 */
  before: string | undefined;
  /** 算出来的结果（不含 BOM）；删除时是空串。 */
  after: string;
}

export interface Invariant {
  id: string;
  /** 管哪些路径。glob，与权限的 pattern 同一套匹配语义（`*` 跨 `/`） */
  match: string[];
  /** 违反 → 返回给模型的自愈文案；守住 → undefined */
  check(input: InvariantInput): string | undefined;
}

function headingCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const h of listHeadings(text, 2)) counts.set(h.title, (counts.get(h.title) ?? 0) + 1);
  return counts;
}

export const INVARIANTS: Invariant[] = [
  {
    id: "design.no-duplicate-heading",
    match: ["design/*"],
    /**
     * 新造出一个重名小节 → 拒。寻址是按标题的（`read` 的 `section`），两个同名 `##` 之后
     * "读第 2 节"永远命中前一个，此后工具都读不懂这份文档。
     *
     * 只看新造出来的重名：原本就重名的老文档不该因一次无关改动被拦。
     */
    check: ({ before, after }) => {
      const was = headingCounts(before ?? "");
      for (const [title, n] of headingCounts(after)) {
        const had = was.get(title) ?? 0;
        // 新文件（`had` 为 0）里出现两个同名小节同样是"新造出重名"，不能因为 before 不在就放过
        if (n > had && n > 1) {
          return (
            `文档里已经有了小节「${title}」——再加一个同名的会让按标题寻址失效` +
            `（读那一节永远命中前一个）。换个标题，或者去改已有的那一节（用 edit）。`
          );
        }
      }
      return undefined;
    },
  },
];

/** 跑一遍；返回第一条被违反的文案，全守住则 undefined。 */
export function checkInvariants(input: InvariantInput): string | undefined {
  for (const inv of INVARIANTS) {
    if (!inv.match.some((p) => match(input.path, p))) continue;
    const hit = inv.check(input);
    if (hit) return hit;
  }
  return undefined;
}
