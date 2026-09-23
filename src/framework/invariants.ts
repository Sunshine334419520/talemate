/**
 * invariants：**对"算出来的结果"做后验**——落盘的字节是不是还守得住那几条不变量。
 *
 * 为什么要在结果上判、不在提案上判：从前这些守卫都对着**提案文本**跑，于是只有
 * `propose-design` 与 `append-design` 两条路撞得上它们；`edit` / `write` / `delete`
 * 完全绕得过去。搬到结果上之后**哪条路都绕不过**——这正是把写盘收成一条路径的意义。
 *
 * 选哪几条不变量上钩，按这个判据：**违反了会不会造出一份"此后工具都读不懂"的文档**。
 * 角色卡的三条都符合（`##` 陷阱会让整卡从逐格审阅里消失、缺格造半身卡、丢必有格同理）；
 * 而"可审阅性"（`proposal.reviewable`）不上钩——它问的是"字节摆不摆得到用户眼前"，
 * 那是**提案渲染**那一侧的事，等结果算出来已经太晚，留给 `propose-design` 做前置。
 *
 * 判据是"这份文档现在长什么样"，所以按**路径**选而不是按层选：`proposal.specFor` 那套
 * （先文件名精确、后路径模式）已经是本仓库判"文档是什么"的既有口径，不另起一套。
 */
import type { FileOp } from "../core/types";
import { match } from "../permission";
import { CHARACTER_FIELDS, missingSkeletonSections, rejectShallowHeading } from "./characters";
import { listHeadings } from "./markdown";

export interface InvariantInput {
  /** 项目相对路径（`design/characters/林晚.md`）——与权限 pattern 同一口径 */
  path: string;
  opKind: FileOp["kind"];
  /** 落盘前的正文（**不含 BOM**）；文件不存在 → undefined */
  before: string | undefined;
  /** 算出来的结果（**不含 BOM**）；删除时是空串 */
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

/** 每个标题出现几次（level ≥ 2）。 */
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
     * 新造出一个**重名**小节 → 拒。
     *
     * 为什么算不变量：寻址是**按标题**的（`read` 的 `section`）。两个同名 `##` 之后，
     * "读第 2 节"永远命中前一个——**此后工具都读不懂这份文档**，正是本条不变量该拦的那一类。
     *
     * 只看"**新造出来**的重名"：原本就重名的老文档不因为一次无关的改动被拦（那不是这次造成的）。
     * 加一节从前挂在 `append-design` 的前置检查里，那个工具已删——搬到这里之后 `write` / `edit`
     * 也一样受它管。
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
    // **只在整篇写时判**：局部改动本来就不带标题，要求它凑齐五格是无理的。
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
    // 比对 before→after 的**存在性**：任何把它们弄没的改动都拦得住，不只是"按标题删小节"那一条——
    // 整篇重写时抹掉、锚点替换恰好吃掉，都算。
    check: ({ before, after, opKind }) => {
      if (before === undefined) return undefined; // 新建，没有"丢掉"可言
      // **删掉整张卡不算**：那时它不再是卡了，没有"半身"可言。这条守的是
      // "卡还在、却缺了一格"，不是"卡没了"——删卡是正当操作（`delete`）。
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

/** 跑一遍；返回**第一条**被违反的文案，全守住则 undefined。 */
export function checkInvariants(input: InvariantInput): string | undefined {
  for (const inv of INVARIANTS) {
    if (!inv.match.some((p) => match(input.path, p))) continue;
    const hit = inv.check(input);
    if (hit) return hit;
  }
  return undefined;
}
