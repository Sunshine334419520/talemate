/**
 * 目录摘要器：**一份文档在 `list` 里占哪一行**——按路径匹配的注册表。
 *
 * 为什么要有这一层：这一判断从前是 `anchor.ts` 里的一串 if（"是角色卡 → 那一行；规范说不分格 →
 * 首句；否则铺小节标题"）。加一种文档形状就要改那个函数体，于是**取数的那一侧自己知道了一份领域**。
 * 搬进注册表之后，加一种形状 = 加一行数据。
 *
 * 形状照抄 `framework/invariants.ts`：同一个 `match` 词表（glob，`*` 跨 `/`，与权限同一套），
 * 同一个"命中就派发"的结构。**本文件的 `match` 与 `design_spec.SPECS` 必须同一套口径**——
 * `summarize` 会把同一个 `path` 同时喂给两者（先问形状，再问规范），口径不同就会各读各的。
 * 两者都是**项目相对**（`design/characters/林晚.md`），与工具收的路径同一个口径。
 */
import { match } from "../permission";
import { CARD_DIR, characterLine, nameFromPath } from "./characters";
import { specFor } from "./design_spec";
import { isFiller } from "./markdown";

/**
 * 索引递给摘要器的东西。**`label` 是索引给的默认名字**（外层目录已剥掉的那一段）——形状可以
 * 拿它当基准，也可以整个换掉：角色卡就是换掉的那个（用卡名，不用路径），
 * 而"不分格的文档"要在它后面缀首句（`s1.md（主角混进内城…）`，不缀就看不出是哪一份）。
 */
export interface SummaryInput {
  /** 项目相对路径——形状与规范都按它选 */
  path: string;
  /** 这份文档在索引里的默认名字 */
  label: string;
  /** 读不到内容 → `undefined` */
  content: string | undefined;
}

export interface DocSummary {
  id: string;
  /** 管哪些路径。glob，与 `invariants`/权限同一套（`*` 跨 `/`） */
  match: string[];
  /**
   * 目录里那**一整行**（不含缩进）。
   * **返回 `undefined` = 在我这匹配范围内、但这一行我写不了**（如"在 `characters/` 下却不是一张卡"）
   * → 判定为"没有一行"，索引去铺它的小节标题。**不会退回去问别处**——匹配范围就是这个形状的领地。
   */
  line(input: SummaryInput): string | undefined;
}

export const SUMMARIES: DocSummary[] = [
  {
    id: "characters.card",
    match: [`${CARD_DIR}*.md`],
    /**
     * 一人一行，**不铺必有格的标题**——排章时要看的是"这个人能不能写了、他卡上有什么"，
     * 而五格的标题每张卡都一样，铺出来是纯噪音。行首那个 `-名 ·` 就是它换掉 `label` 的地方。
     *
     * "是不是卡"由 `nameFromPath` 说了算，不由路径模式说了算：它还负责拒掉 `_index` 这类遗留物
     * （2026-09-18 删掉的派生总表）。这也是为什么 `line` 允许返回 `undefined`——匹配上了
     * `design/characters/*.md` 却给不出名字，那它就不是卡。
     */
    line: ({ path, content }) => {
      const name = nameFromPath(path);
      if (name === undefined) return undefined;
      return `- ${name} · ${content === undefined ? "（缺）" : characterLine(content)}`;
    },
  },
];

/**
 * 正文整篇的"一句话"：全文第一句有效内容（跳过标题行、空行、占位、引用）。
 * 序列纲这类文档没有小节可铺，首句才是它在目录里的信号。
 */
function proseLead(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !isFiller(l));
  if (line === undefined) return "空";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/**
 * 这一份在目录里占哪一行；**返回 `undefined` = 没有一行可言，索引去铺它的小节标题**。
 *
 * 两步：
 *   1. **命中了注册表 → 那个形状说了算。** 它给一行就用；它在自己的匹配范围里**让位**
 *      （这份文件不属于这个形状），就是"没有一行"——**不再退回去问规范**。退回会让"不是卡"
 *      的文件掉进"不分格就取首句"里，拿到一句脱离上下文的正文。
 *   2. 没命中任何形状 → 规范说"这份文档不分格"（`sections` 为空，如序列纲）就给 **`label（首句）`**。
 *      **这一条从规范派生，所以不在这里再抄一遍路径模式**：某种文档不分格是规范那一侧的事。
 *
 * 其余（有格的文档、没登记规范的文档）→ `undefined`，索引铺它的小节标题。
 */
export function summarize(input: SummaryInput): string | undefined {
  const hook = SUMMARIES.find((s) => s.match.some((p) => match(input.path, p)));
  if (hook) return hook.line(input);
  // 内容读不到时没有"首句"可取——交给索引统一写「（缺）」，免得每个形状各写一套。
  if (input.content === undefined) return undefined;
  const spec = specFor(input.path);
  if (spec !== undefined && spec.sections.length === 0) {
    return `${input.label}（${proseLead(input.content)}）`;
  }
  return undefined;
}
