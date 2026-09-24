/**
 * match：把"模型写的原文片段"对上"文件里真实存在的那一段"。纯函数、无 IO、不认识小节/角色卡/层。
 *
 * 为什么需要它：模型回填原文时几乎总是差一点——缩进被吃掉、行尾空格没了、中文弯引号被写成
 * 英文直引号、换行被写成字面的 `\n`。一次精确比较就失败太脆，所以从最严格到最宽松逐级降级，
 * **任一级命中即停**。
 *
 * 两个不变量比阶梯本身更要紧：
 * - **唯一性由这里判，不由调用方保证**：命中位置不唯一就换下一个候选；全跑完仍不唯一才报错。
 *   静默改错位置是最糟的失败模式，宁可拒绝。
 * - **跨度不成比例就拒绝**（isDisproportionate）：模糊匹配的失败模式不是"找不到"，而是
 *   "匹配到太大的一片"——把一整节吞掉换成一个词。这条最容易漏。
 *
 * 边界：这里只回答"对上了哪一段、换成什么"，**不写盘**。落盘路径见 write_ops.ts。
 *
 * 规模与取舍取自 opencode 的两份实现（`tool/edit.ts` 的九级字符串阶梯、`patch/index.ts` 的四趟
 * 行数组阶梯）。只取字符串那一套：行数组那套是给整文件补丁用的，等正文编辑真需要整章补丁再补。
 */

/** 命中级别。**顺序即优先级**——数组里靠前的先试，命中即停。诊断与测试用。 */
export const MATCH_LEVELS = [
  "exact", // 原样子串
  "line-trimmed", // 逐行去首尾空白后比
  "block-anchor", // 首末行当锚 + 中间行相似度
  "whitespace", // 所有空白串折叠成一个空格
  "escape", // 解转义（模型写的是字面 `\n`）
  "boundary", // 整段 trim 后再比
  "unicode", // 弯引号/破折号/省略号/不换行空格 归一成 ASCII
  "context", // 锚点 + 中间行多数相等
] as const;
export type MatchLevel = (typeof MATCH_LEVELS)[number];

/** 单候选相似度阈值（block-anchor / context 用）。取自 opencode，实测值，别随手调。 */
const SIMILARITY_THRESHOLD = 0.65;

/**
 * 编辑距离。**只留两行**——完整矩阵是 O(n·m) 内存，而这里会被逐行调用，
 * 长段落上没必要为了一样的答案多吃几万个格子。
 */
function levenshtein(a: string, b: string): number {
  if (a === "") return b.length;
  if (b === "") return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** 两个字符串的相似度 0..1（按较长者归一，空对空算 1）。 */
function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** 拆行。末尾那个空串是 `split` 的产物，不代表多出一行——统一去掉，免得每处各判一次。 */
function lines(text: string): string[] {
  const out = text.split("\n");
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** 把行数组还原成文本片段。 */
function joinLines(ls: string[]): string {
  return ls.join("\n");
}

/** 一个候选生成器：给定文件内容与要找的片段，产出"可能是它"的**真实子串**。 */
type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

/** 原样。 */
function* exact(_content: string, find: string): Generator<string> {
  yield find;
}

/** 逐行去首尾空白后比——模型最常丢的是行首缩进与行尾空格。 */
function* lineTrimmed(content: string, find: string): Generator<string> {
  const original = content.split("\n");
  const search = lines(find);
  if (!search.length) return;
  for (let i = 0; i + search.length <= original.length; i++) {
    let hit = true;
    for (let j = 0; j < search.length; j++) {
      if (original[i + j].trim() !== search[j].trim()) {
        hit = false;
        break;
      }
    }
    if (hit) yield original.slice(i, i + search.length).join("\n");
  }
}

/**
 * 首末行当锚，中间行算相似度。治的是"中间有几行被模型改写了措辞"。
 * 行数差超过 25% 就不认——差太多说明那不是同一块。
 */
function* blockAnchor(content: string, find: string): Generator<string> {
  const search = lines(find);
  if (search.length < 3) return;
  const original = content.split("\n");
  const first = search[0].trim();
  const last = search[search.length - 1].trim();
  const maxDelta = Math.max(1, Math.floor(search.length * 0.25));

  const candidates: { start: number; end: number }[] = [];
  for (let i = 0; i < original.length; i++) {
    if (original[i].trim() !== first) continue;
    for (let j = i + 2; j < original.length; j++) {
      if (original[j].trim() !== last) continue;
      if (Math.abs(j - i + 1 - search.length) <= maxDelta) candidates.push({ start: i, end: j });
      break; // 只认第一处末行，避免同一个首行配出一堆候选
    }
  }
  if (!candidates.length) return;

  const score = (c: { start: number; end: number }): number => {
    const span = c.end - c.start + 1;
    const middle = Math.min(search.length - 2, span - 2);
    if (middle <= 0) return 1; // 没有中间行可比，只能认锚点
    let sum = 0;
    for (let j = 1; j < search.length - 1 && j < span - 1; j++) {
      sum += similarity(original[c.start + j].trim(), search[j].trim());
    }
    return sum / middle;
  };

  if (candidates.length === 1) {
    const c = candidates[0];
    if (score(c) >= SIMILARITY_THRESHOLD) yield original.slice(c.start, c.end + 1).join("\n");
    return;
  }
  let best: { start: number; end: number } | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    const s = score(c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (best && bestScore >= SIMILARITY_THRESHOLD) yield original.slice(best.start, best.end + 1).join("\n");
}

/** 所有空白串折叠成一个空格。 */
function* whitespace(content: string, find: string): Generator<string> {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const target = norm(find);
  if (!target) return;

  const all = content.split("\n");
  for (const line of all) {
    if (norm(line) === target) yield line;
  }
  // 多行块整体折叠后相等
  const findCount = lines(find).length;
  if (findCount > 1) {
    for (let i = 0; i + findCount <= all.length; i++) {
      const block = all.slice(i, i + findCount).join("\n");
      if (norm(block) === target) yield block;
    }
  }
}

/** 字面转义还原——模型有时把 `\n` `\t` 当两个字符写出来。 */
function unescape(s: string): string {
  return s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case "\n":
        return "\n";
      default:
        return c; // ' " ` $ —— 转义与否是同一个字符
    }
  });
}

function* escape(content: string, find: string): Generator<string> {
  const target = unescape(find);
  if (target !== find && content.includes(target)) yield target;
  const all = content.split("\n");
  const count = lines(target).length;
  if (!count) return;
  for (let i = 0; i + count <= all.length; i++) {
    const block = all.slice(i, i + count).join("\n");
    if (unescape(block) === target) yield block;
  }
}

/** 整段 trim 后再比。 */
function* boundary(content: string, find: string): Generator<string> {
  const trimmed = find.trim();
  if (trimmed === find) return; // 本来就 trim 过，没必要再来一遍
  if (content.includes(trimmed)) yield trimmed;
  const all = content.split("\n");
  const count = lines(find).length;
  if (!count) return;
  for (let i = 0; i + count <= all.length; i++) {
    const block = all.slice(i, i + count).join("\n");
    if (block.trim() === trimmed) yield block;
  }
}

/**
 * Unicode 标点归一成 ASCII 后再比。
 *
 * 专治中文：正文里的引号**本就该是弯的**（“…”），而模型回填时常写成直的（"…"）——
 * 这跟"模型写错了"不同，是两种都合法的写法对不上。折线号、省略号、不换行空格同理。
 *
 * **只收"同一个字的两种合法写法"，不收全角/半角标点**：`：` 与 `:`、`，` 与 `,`、`。` 与 `.`
 * 在中文里不是等价变体——前者是正字，后者是模型敲错了。把它们归一等于把真错误抹平，
 * 而且会把 `他说,我要回去.` 这类串放到一大片候选上去（唯一性随即失效）。
 * 敲错了就该让它撞"找不到"、回去重读文档，这是更短的自愈路径。
 */
function* unicodeNormalized(content: string, find: string): Generator<string> {
  const norm = (s: string): string =>
    s
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‐‑‒–—―]/g, "-")
      .replace(/…/g, "...")
      .replace(/ /g, " ");
  const target = norm(find.trim());
  const all = content.split("\n");
  const count = lines(find).length;
  if (!count) return;
  for (let i = 0; i + count <= all.length; i++) {
    const block = all.slice(i, i + count);
    if (norm(block.join("\n").trim()) === target) yield block.join("\n");
  }
}

/** 锚点 + 中间行多数相等（比 block-anchor 松，用于参差更多的块）。 */
function* contextAware(content: string, find: string): Generator<string> {
  const search = lines(find);
  if (search.length < 3) return;
  const original = content.split("\n");
  const first = search[0].trim();
  const last = search[search.length - 1].trim();

  for (let i = 0; i < original.length; i++) {
    if (original[i].trim() !== first) continue;
    for (let j = i + 2; j < original.length; j++) {
      if (original[j].trim() !== last) continue;
      const block = original.slice(i, j + 1);
      if (block.length !== search.length) break;
      let same = 0;
      let total = 0;
      for (let k = 1; k < block.length - 1; k++) {
        const a = block[k].trim();
        const b = search[k].trim();
        if (a.length || b.length) {
          total++;
          if (a === b) same++;
        }
      }
      if (total === 0 || same / total >= 0.5) yield block.join("\n");
      break; // 只认第一处，与 block-anchor 同一口径
    }
  }
}

/**
 * 阶梯本体。数组顺序即优先级——**别按字母或"看起来更聪明"重排**。
 * 越靠后越宽松，命中的跨度也越可能不是模型想的那一段，所以靠后的级别尤其依赖
 * isDisproportionate 兜底。
 */
const LADDER: { level: MatchLevel; replacer: Replacer }[] = [
  { level: "exact", replacer: exact },
  { level: "line-trimmed", replacer: lineTrimmed },
  { level: "block-anchor", replacer: blockAnchor },
  { level: "whitespace", replacer: whitespace },
  { level: "escape", replacer: escape },
  { level: "boundary", replacer: boundary },
  { level: "unicode", replacer: unicodeNormalized },
  { level: "context", replacer: contextAware },
];

// **没有"去公共缩进"那一级**（opencode 的 IndentationFlexibleReplacer）。
// 它被 line-trimmed 完全覆盖：两级都要求行数相同，而"整段去掉同一个前缀后逐行相等"
// 蕴含"逐行 trim 后相等"——设 dedent(block) === dedent(find) === S，则 block[j] 要么就是 S_j、
// 要么是"空白前缀 + S_j"，两种的 trim 都等于 S_j.trim()。既然它永远轮不到，留着只会让
// 阶梯顺序这一层语义变得不可信（读的人会以为它拦住了什么）。

/**
 * 模糊匹配有没有"吃掉太大一片"。**这是整个阶梯的安全阀**。
 *
 * 越靠后的级别越宽松：`context` 只要首末行对上、中间过半行对上就认，于是"改一个词"可能被
 * 理解成"重写整节"。判据是跨度，不是内容——内容像不像归相似度管，这里只管它**是不是大得离谱**。
 *
 * 两条规则都要，因为它们抓的是不同的失控方式：
 * - **行数暴涨**：命中比 find 多出好几行。
 * - **字符暴涨**（仅多行 find）：`context` / `block-anchor` 只比行数与相似度，**不比行有多长**。
 *   于是 3 行短句能对上 3 行长段落——行数一样，吞掉的内容却多几十倍。只查行数会漏掉这一类。
 *
 * `reference` 是"模型实际意图的大小"，通常就是 find。**唯独 escape 级要传解转义后的 find**：
 * 那一级本来就是把字面 `\n` 展开成多行，拿原始 find 去比会把它当失控误杀——可那正是模型要的。
 */
function isDisproportionate(matched: string, reference: string): boolean {
  const refLines = lines(reference).length;
  const matchedLines = lines(matched).length;
  if (matchedLines >= Math.max(refLines + 3, refLines * 2)) return true;
  if (refLines === 1) return false; // 单行没有"行数暴涨"可言
  return matched.trim().length > Math.max(reference.trim().length + 500, reference.trim().length * 4);
}

export type ReplaceOutcome =
  | { ok: true; content: string; matched: string; level: MatchLevel; count: number }
  | { ok: false; output: string };

/**
 * 在 content 里找到 find 对应的**真实片段**，换成 replacement。
 *
 * `all=false`（默认）：命中必须唯一，否则拒绝并要求补上下文。
 * `all=true`：命中几处换几处（重命名变量那类用法）。
 *
 * 失败一律走返回值、不抛——文案是给模型的自愈线索（CLAUDE.md 的"模型能修的走 return"）。
 */
export function applyReplace(content: string, find: string, replacement: string, all = false): ReplaceOutcome {
  if (find === "") {
    return { ok: false, output: "find 不能为空——要整篇重写请用 write，要末尾追加请用 append。" };
  }
  if (find === replacement) {
    return { ok: false, output: "find 与 replace 相同，没有改动可做。" };
  }

  let sawCandidate = false;

  for (const { level, replacer } of LADDER) {
    for (const matched of replacer(content, find)) {
      const index = content.indexOf(matched);
      if (index === -1) continue;
      sawCandidate = true;

      // escape 级拿解转义后的 find 当基准，理由见 isDisproportionate
      const reference = level === "escape" ? unescape(find) : find;
      if (isDisproportionate(matched, reference)) {
        return {
          ok: false,
          output:
            `匹配到的一段比 find 大太多（命中 ${lines(matched).length} 行 / ${matched.trim().length} 字，` +
            `find 只有 ${lines(reference).length} 行 / ${reference.trim().length} 字），已拒绝——` +
            "这样换下去会吃掉不该动的部分。请把 find 换成更精确的原文（连它周围的上下文一起给）。",
        };
      }

      if (all) {
        // 用 split/join 而不是 replaceAll：字符串形式的替换值里 `$&`、`$1` 是**有含义的**，
        // 正文里出现 `$` 时会被悄悄展开。函数式替换（或 split/join）才把 replacement 当字面量。
        const parts = content.split(matched);
        return { ok: true, content: parts.join(replacement), matched, level, count: parts.length - 1 };
      }

      // 不唯一 → 换下一个候选，而不是就地报错：后面更宽松的级别可能给出唯一命中。
      if (content.indexOf(matched) !== content.lastIndexOf(matched)) continue;

      return {
        ok: true,
        content: content.slice(0, index) + replacement + content.slice(index + matched.length),
        matched,
        level,
        count: 1,
      };
    }
  }

  return sawCandidate
    ? {
        ok: false,
        output:
          "find 在文件里有多处命中，换哪一处不确定。请把 find 换成更长的原文——" +
          "连它前后各一行一起给，让它唯一；确实要全部替换就传 all。",
      }
    : {
        ok: false,
        output:
          "find 在文件里找不到（缩进、空白、行尾都算在内比对过了）。请先读一遍文档，" +
          "用你看到的原文重试——注意别把行号当成内容。",
      };
}
