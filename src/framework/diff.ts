/**
 * diff：两份文本的行级差异，用于**落盘前给用户看的材料**。
 *
 * 为什么自己写而不是引 `diff` 包：需要的不是通用 unified diff，而是"改了哪几行、上下留几行上下文"
 * 这一件事，LCS 加一段裁剪就够，而这个仓库的依赖表刻意只有两个 SDK 加一个 html 转换器。
 *
 * 关键的一步是**先裁掉公共首尾**：正文的改动通常集中在中间一小段，裁完之后 LCS 只需在两小段上跑，
 * 长篇也不会退化。裁不掉（整篇重写）时有一道规模兜底，见 `TOO_BIG`。
 */
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** 1 基行号；add 只有 newNo，del 只有 oldNo，ctx 两个都有 */
  oldNo?: number;
  newNo?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

/** LCS 的规模上限。超了就不做最小编辑脚本，直接"整段删 + 整段加"——结果仍然诚实，只是不好看。 */
const TOO_BIG = 4_000_000;

/**
 * 切行，**换行符跟着行走**（`"甲\n乙\n"` → `["甲\n","乙\n"]`）。
 *
 * 不用 `split("\n")`：那样 `"甲\n乙\n"` 会多出一个幽灵尾行 `""`——它会在每一份 diff 的末尾
 * 冒出一行莫名其妙的上下文。而且它还分不出 `"甲\n乙"` 与 `"甲\n乙\n"`（真正的"末尾少一个换行"），
 * 把一处真实差异静默吞掉。
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * 逐行比对。行号按原始文本算（1 基），所以渲染出来可以直接说"第 42 行"。
 */
export function diffLines(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 公共前缀 / 后缀：改动集中的文档在这里就被削到只剩中间那一小段
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  const mid = middle(midA, midB);

  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ kind: "ctx", text: a[i] });
  out.push(...mid);
  for (let i = 0; i < suf; i++) out.push({ kind: "ctx", text: a[a.length - suf + i] });

  // 编号在**组装之后**一次做完：中间段是按切片算的，各自从 1 数会漏掉前缀的偏移。
  let oldNo = 1;
  let newNo = 1;
  for (const l of out) {
    if (l.kind === "ctx") {
      l.oldNo = oldNo++;
      l.newNo = newNo++;
    } else if (l.kind === "del") {
      l.oldNo = oldNo++;
    } else {
      l.newNo = newNo++;
    }
  }

  return {
    lines: out,
    additions: out.filter((l) => l.kind === "add").length,
    deletions: out.filter((l) => l.kind === "del").length,
  };
}

/** 中间那一段的编辑脚本（LCS 回溯）。 */
function middle(a: string[], b: string[]): DiffLine[] {
  if (!a.length && !b.length) return [];
  if (!a.length) return b.map((text) => ({ kind: "add" as const, text }));
  if (!b.length) return a.map((text) => ({ kind: "del" as const, text }));

  if (a.length * b.length > TOO_BIG) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  // lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out; // 行号由 diffLines 统一编号（这里拿不到前缀偏移）
}

/** 行的展示前缀。`+`/`-`/` ` 与 unified diff 一致，人一眼认得出。 */
const MARK: Record<DiffLine["kind"], string> = { add: "+", del: "-", ctx: " " };

/**
 * 渲染成人看的文本。
 *
 * `context` 是每处改动上下各留几行——留 0 会看不懂改在哪，留太多则和整篇没区别。
 * 相隔较远的改动之间用 `…` 省略，并在那段省略前打一行"跳了 N 行"，免得人以为改到一块去了。
 */
export function renderDiff(result: DiffResult, context = 2): string {
  const { lines } = result;
  if (!lines.some((l) => l.kind !== "ctx")) return "（无改动）";

  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind === "ctx") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k);
  });

  const out: string[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) {
      skipped++;
      continue;
    }
    if (skipped) {
      out.push(`  …（跳过 ${skipped} 行）`);
      skipped = 0;
    }
    // 行自带换行符（见 splitLines），渲染时去掉——换行由 join 负责，否则会多出空行
    out.push(`${MARK[lines[i].kind]}${lines[i].text.replace(/\n$/, "")}`);
  }
  if (skipped) out.push(`  …（跳过 ${skipped} 行）`);
  return out.join("\n");
}
