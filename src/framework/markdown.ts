/**
 * markdown 区块手术：以 `#{2,}` heading 为单位做 查/取/改/删/加。
 *
 * "区块"语义：一个 heading（如 `## 主角`）起，到"下一个 level ≤ 它的 heading"之前结束——
 * 因此 `## 主角` 覆盖其下的 `### 想要什么`；寻址 `### 想要什么` 则只动它一格。
 * section 参数 = heading 标题文本（如 "主角" / "角色：沈越" / "想要什么"），不匹配报错并列出可用 heading（自愈）。
 */
export interface Heading {
  title: string;
  level: number;
  /** 该 heading 所在行号（0 基） */
  line: number;
  /** 区块结束行号（0 基，独占） */
  end: number;
}

// `#{1,}`：H1 也要能匹配——否则 `listHeadings(content, 1)`（取文档标题）永远拿不到 H1，
// 与"列出 level ≥ minLevel 的 heading"这条契约不符。默认 minLevel=2 的调用方行为不变。
const HEADING_RE = /^(\#{1,})\s+(.*?)\s*$/;

/** 列出 content 里 level ≥ minLevel 的全部 heading（minLevel 默认 2）。跳过 `<!-- -->` 注释块（注释里别放模板 heading）。 */
export function listHeadings(content: string, minLevel = 2): Heading[] {
  const lines = content.split("\n");
  const out: Heading[] = [];
  let inComment = false;
  const commentEnd = (line: string): boolean => line.includes("-->");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inComment) {
      if (commentEnd(t)) inComment = false;
      continue;
    }
    if (t.startsWith("<!--")) {
      if (!commentEnd(t)) inComment = true;
      continue;
    }
    const m = lines[i].match(HEADING_RE);
    if (!m) continue;
    const level = m[1].length;
    if (level < minLevel) continue;
    const title = m[2].trim();
    let end = lines.length;
    let c2 = inComment;
    for (let j = i + 1; j < lines.length; j++) {
      const tj = lines[j].trim();
      if (c2) {
        if (commentEnd(tj)) c2 = false;
        continue;
      }
      if (tj.startsWith("<!--")) {
        if (!commentEnd(tj)) c2 = true;
        continue;
      }
      const nm = lines[j].match(HEADING_RE);
      if (nm && nm[1].length <= level) {
        end = j;
        break;
      }
    }
    out.push({ title, level, line: i, end });
  }
  return out;
}

/** 按标题精确找 heading（首条）。 */
export function findHeading(content: string, title: string, minLevel = 2): Heading | undefined {
  const t = title.trim();
  return listHeadings(content, minLevel).find((h) => h.title === t);
}

export interface SectionLookup {
  found: boolean;
  heading?: Heading;
  /** 该区块的正文（不含 heading 行），trimEnd 后 */
  body?: string;
  /** 该区块整段（含 heading 行） */
  block?: string;
  /** 可选：找不到时给模型看的所有可用 heading */
  available?: string[];
}

/** 取一个区块的正文与整段。找不到 → found:false + available 列表（供工具回给模型自愈）。 */
export function getSection(content: string, title: string, minLevel = 2): SectionLookup {
  const h = findHeading(content, title, minLevel);
  if (!h) return { found: false, available: listHeadings(content, minLevel).map((x) => x.title) };
  const lines = content.split("\n");
  const blockLines = lines.slice(h.line, h.end);
  const body = blockLines.slice(1).join("\n").trimEnd();
  return { found: true, heading: h, body, block: blockLines.join("\n") };
}

/** 是否"这个文档基本是空骨架"（只有 heading + 待定占位/注释）。用于填充度判断。 */
export function isSkeleton(content: string | undefined): boolean {
  if (!content) return true;
  const body = content
    .split("\n")
    .filter((l) => !/^#/.test(l.trim()) && !/^<!--/.test(l.trim()) && !/^-->/.test(l.trim()))
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  // 只余“待定”占位/引用块引导语 → 视为未填充
  const meaningful = body
    .replace(/（待定[^）]*）/g, "")
    .replace(/^>.*$/gm, "")
    .trim();
  return meaningful.length === 0;
}

/**
 * 空行 / 说明行 / （待定…）占位 —— 都不算"填了"。
 * 原在 report.ts；挪到这里是因为 characters.ts 也要用它，而 report → characters 已有依赖，
 * 反向 import 会成环。report.ts re-export 以保住原有调用点。
 */
export function isFiller(line: string): boolean {
  const t = line.trim();
  return !t || t.startsWith("### ") || t.startsWith(">") || t.startsWith("<!--") || /^（待定.*）$/.test(t);
}

/** 取一个区块正文的第一句有效内容（跳过占位/空行/引用），超过 max 字截断。用于"简要输出"与角色总表派生。 */
export function leadLine(content: string, heading: string, max = 60): string | undefined {
  const s = getSection(content, heading);
  if (!s.found) return undefined;
  const line = (s.body ?? "").split("\n").find((l) => !isFiller(l))?.trim();
  return line ? (line.length > max ? `${line.slice(0, max)}…` : line) : undefined;
}

/** 文档里有没有 level 2 的标题（`##`，不含 `###`）。角色卡拿它做陷阱检查，见 characters.rejectShallowHeading。 */
export function matchesLevel2Heading(content: string): string | undefined {
  const m = content.match(/^##(?!#)\s+(.*)$/m);
  return m ? m[1].trim() : undefined;
}

/**
 * 替换一个区块的正文。newBody 不含 heading 行；返回新全文。
 * 找不到 → throw（消息带 available，工具层再包成自愈文案）。
 */
export function replaceSection(content: string, title: string, newBody: string): string {
  const h = findHeading(content, title);
  if (!h) {
    throw new Error(`没有找到小节「${title}」。可用小节：${listHeadings(content).map((x) => x.title).join("、")}`);
  }
  const lines = content.split("\n");
  // 与 removeSection 同一套拼法：块与块之间恒为一个空行。
  // （旧实现只补一个 "\n"，改完的小节会和下一节的标题黏在一起——整卡重建时看不出来，
  //   外科改之后每次都会出现。）
  const head = lines.slice(0, h.line).join("\n").trimEnd();
  const tail = lines.slice(h.end).join("\n").trimStart();
  return [head, `${lines[h.line]}\n\n${newBody.trim()}`, tail].filter((s) => s.length > 0).join("\n\n");
}

/** 删除一个区块（含其 heading）。找不到 → throw。 */
export function removeSection(content: string, title: string): string {
  const h = findHeading(content, title);
  if (!h) {
    throw new Error(`没有找到小节「${title}」。可用小节：${listHeadings(content).map((x) => x.title).join("、")}`);
  }
  const lines = content.split("\n");
  const before = lines.slice(0, h.line).join("\n").trimEnd();
  const after = lines.slice(h.end).join("\n").trimStart();
  // 两个非空块之间用一个空行隔开
  return [before, after].filter((s) => s.length > 0).join("\n\n");
}

/** 在文档末尾追加一个区块（blockText 通常自带 `## ` heading；无需 confirm 的非破坏操作）。 */
export function appendBlock(content: string, blockText: string): string {
  const base = content.trimEnd();
  return base.length ? base + "\n\n" + blockText.trim() + "\n" : blockText.trim() + "\n";
}

/** 一行命中（供 search 展示） */
export function findInContent(content: string, query: string): { line: number; heading?: string; text: string }[] {
  const q = query.toLowerCase();
  const hits: { line: number; heading?: string; text: string }[] = [];
  const headings = listHeadings(content);
  const lines = content.split("\n");
  let active: Heading | undefined;
  for (let i = 0; i < lines.length; i++) {
    const hi = headings.find((h) => h.line === i);
    if (hi) active = hi;
    if (lines[i].toLowerCase().includes(q)) {
      hits.push({ line: i + 1, heading: active?.title, text: lines[i].trim().slice(0, 120) });
    }
  }
  return hits;
}
