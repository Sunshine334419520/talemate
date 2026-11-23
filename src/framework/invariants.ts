/**
 * invariants：对落盘后的字节做后验——这份文档还算不算工具读得懂。
 *
 * 只保留与**寻址/安全**有关的检查；不再有“角色卡必须有五格”“不许 `##`”这类形状不变量——
 * 创作文档的结构由设计指南引导，不由写盘拦住。
 *
 * 在结果上判而不是在提案上判：对着提案文本判的话 `edit` / `write` / `delete` 都绕得过去，
 * 把写盘收成一条路径之后哪条路都绕不过。
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
  for (const h of listHeadings(text)) counts.set(h.title, (counts.get(h.title) ?? 0) + 1);
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
        if (n > had && had > 0) {
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