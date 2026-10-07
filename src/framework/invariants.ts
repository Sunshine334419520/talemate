/**
 * invariants：对落盘后的字节做后验——这份文档还算不算工具读得懂。判据是"文档现在长什么样"，
 * 所以按路径选而不是按层选，沿用 `design_spec.specFor` 那套既有口径（先文件名精确、后路径模式）。
 *
 * 在结果上判而不是在提案上判：对着提案文本判的话 `edit` / `write` / `delete` 都绕得过去，
 * 把写盘收成一条路径之后哪条路都绕不过。
 *
 * 上钩判据是"违反了会不会造出一份此后工具都读不懂的文档"（角色卡三条都符合）；"可审阅性"
 * （`proposal.reviewable`）不上钩——它问的是字节能不能到用户眼前，归提案渲染那一侧。
 */
import type { FileOp } from "../core/types";
import { match } from "../permission";
import { CHARACTER_FIELDS, missingSkeletonSections, rejectShallowHeading } from "./characters";
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

const CARD = ["design/characters/*.md"];

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
  {
    id: "characters.no-shallow-heading",
    match: CARD,
    check: ({ after }) => {
      const shallow = rejectShallowHeading(after);
      return shallow
        ? `角色卡的小节一律用 \`###\`（收到 \`## ${shallow}\`）——更浅的标题会让卡里所有 \`###\` 从逐格审阅里消失，用户看不到却被落盘。`
        : undefined;
    },
  },
  {
    id: "characters.skeleton-complete",
    match: CARD,
    // 只在整篇写时判：局部改动本来就不带标题，要求它凑齐五格是无理的
    check: ({ after, opKind }) => {
      if (opKind !== "write") return undefined;
      const missing = missingSkeletonSections(after);
      return missing.length
        ? `角色卡缺这几格：${missing.join("、")}——整篇写必须带齐必有五格，没定的写（待定）。补齐后再来。`
        : undefined;
    },
  },
  {
    id: "characters.required-kept",
    match: CARD,
    // 比对 before→after 的存在性：任何把它们弄没的改动都拦得住，不只是"按标题删小节"——
    // 整篇重写抹掉、锚点替换恰好吃掉，都算
    check: ({ before, after, opKind }) => {
      if (before === undefined) return undefined; // 新建，没有"丢掉"可言
      // 删掉整张卡不算：那时它不再是卡，没有"半身"可言；这条守的是"卡还在却缺一格"，
      // 删卡是正当操作（`delete`）
      if (opKind === "delete") return undefined;
      const gone = CHARACTER_FIELDS.filter(
        (f) => before.includes(`### ${f.label}`) && !after.includes(`### ${f.label}`),
      ).map((f) => f.label);
      return gone.length
        ? `「${gone.join("、")}」是角色卡的必有格，不能整格消失——那会造出半身卡。` +
            `要清空这一格，请把正文改成（待定），别把标题删掉。`
        : undefined;
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
