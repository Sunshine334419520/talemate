/**
 * frontmatter：资产文件的头部元数据（`---` 块）的解析与序列化。
 *
 * 只支持资产真需要的那一小撮 YAML：标量（字符串 / 数字 / 布尔 / null）、字符串或数字列表、
 * 块列表。**不支持嵌套映射**——资产字段是平的，嵌套只会在 `assets.ts` 的注册表里多长一层，
 * 而那一层没有任何消费者。碰到嵌套就报 problem，不静默吞掉。
 *
 * 为什么手写而不引 YAML 库：资产头部是产品格式，不是外部输入格式。手写这一百来行能把
 * "字段顺序稳定、未知字段原样保留、坏行带行号"三件事钉死；引一个库则要跟着它的小版本行为走。
 *
 * 边界：只管文本 ↔ 数据，不认识资产种类、路径与校验（那些在 `framework/assets.ts`）。
 */

export type FrontmatterScalar = string | number | boolean | null;

/** 一个字段的值。列表只允许标量项——嵌套列表没有消费者。 */
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[];

export type Frontmatter = Record<string, FrontmatterValue>;

export interface FrontmatterParse {
  data: Frontmatter;
  /** 逐行报的坏行，带 1 起的行号（相对整个文件，便于用户直接跳过去改） */
  problems: string[];
}

export interface SplitDocument {
  /** `---` 块里的原始文本；没有头部时为 undefined */
  raw?: string;
  /** 去掉头部之后的正文（开头那一个空行已剥掉） */
  body: string;
}

/**
 * 切开头部与正文。只有**第一行**是 `---`（允许前后空白）才算头部；不闭合就当没有头部，
 * 正文原样返回——"文件没写完"与"文件没有头"在读取层不该有区别。
 */
export function splitFrontmatter(text: string): SplitDocument {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: clean };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return { body: clean };
  const raw = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n").replace(/^\r?\n/, "");
  return { raw, body };
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const LITERALS = new Set(["true", "false", "null"]);

/** 一行 `key: value` 的 value → 值。引号内的内容按 JSON 转义解（双引号）或字面量（单引号）。 */
function parseValue(text: string, lineNo: number, problems: string[]): FrontmatterValue {
  const raw = text.trim();
  if (raw === "") return "";
  if (raw.startsWith('"')) {
    try {
      return String(JSON.parse(raw));
    } catch {
      problems.push(`第 ${lineNo} 行：双引号字符串没闭合或转义不合法：${raw}`);
      return raw;
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) {
      problems.push(`第 ${lineNo} 行：单引号字符串没闭合：${raw}`);
      return raw;
    }
    return raw.slice(1, -1).replaceAll("\\'", "'");
  }
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) {
      problems.push(`第 ${lineNo} 行：行内列表没闭合：${raw}`);
      return raw;
    }
    return splitInlineList(raw.slice(1, -1), lineNo, problems).map((item) => parseScalar(item, lineNo, problems));
  }
  return parseScalar(raw, lineNo, problems);
}

function parseScalar(raw: string, lineNo: number, problems: string[]): FrontmatterScalar {
  const text = raw.trim();
  if (text === "" || text === "~") return null;
  if (text.startsWith('"')) {
    try {
      return String(JSON.parse(text));
    } catch {
      problems.push(`第 ${lineNo} 行：双引号字符串没闭合或转义不合法：${text}`);
      return text;
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replaceAll("\\'", "'");
  }
  if (text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (NUMBER_RE.test(text)) return Number(text);
  if (text.startsWith("{") || text.startsWith("|") || text.startsWith(">")) {
    problems.push(`第 ${lineNo} 行：不支持嵌套映射与块标量：${text}`);
  }
  return text;
}

/** 行内列表按逗号切，逗号在引号里不算分隔符。 */
function splitInlineList(inner: string, lineNo: number, problems: string[]): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const ch of inner) {
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote !== undefined) problems.push(`第 ${lineNo} 行：列表项引号没闭合`);
  out.push(current);
  return out.map((s) => s.trim()).filter((s, i, all) => !(all.length === 1 && s === ""));
}

/**
 * 解析头部文本。`data` 的键顺序按出现顺序（序列化时由调用方给稳定顺序，不靠这里）。
 * 未知字段一律保留——"资产以后加字段"不该让旧版本的写回把它们丢掉。
 */
export function parseFrontmatter(raw: string): FrontmatterParse {
  const problems: string[] = [];
  const data: Frontmatter = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    i += 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      problems.push(`第 ${lineNo} 行：不属于任何字段的缩进行：${line.trim()}`);
      continue;
    }
    const m = KEY_RE.exec(line);
    if (!m) {
      problems.push(`第 ${lineNo} 行：不是 key: value 形式：${line}`);
      continue;
    }
    const key = m[1] as string;
    const rest = (m[2] as string).trim();
    if (Object.prototype.hasOwnProperty.call(data, key)) problems.push(`第 ${lineNo} 行：字段 ${key} 重复，取最后一次`);
    if (rest !== "") {
      data[key] = parseValue(rest, lineNo, problems);
      continue;
    }
    // `key:` 后面跟 `- item` 就是块列表；否则是空字符串
    const items: string[] = [];
    while (i < lines.length) {
      const next = lines[i] as string;
      if (!/^\s*-\s?/.test(next)) break;
      items.push(next.replace(/^\s*-\s?/, "").trim());
      i += 1;
    }
    if (items.length === 0) {
      data[key] = "";
      continue;
    }
    data[key] = items.map((item, idx) => parseScalar(item, lineNo + idx, problems));
  }
  return { data, problems };
}

const BARE_RE = /^[A-Za-z0-9_一-鿿][A-Za-z0-9_一-鿿 .:;!?()（）《》、·/-]*$/;
const NUMBER_LIKE = /^-?\d+(?:\.\d+)?$/;

function quoteString(value: string): string {
  if (value === "") return '""';
  const force = LITERALS.has(value) || NUMBER_LIKE.test(value) || value.startsWith("- ") || /^\s|\s$/.test(value);
  if (!force && BARE_RE.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\t", "\\t")}"`;
}

function scalarText(value: FrontmatterScalar): string {
  if (value === null) return "null";
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return value ? "true" : "false";
}

/**
 * 序列化成 `---` 块里的行。`order` 是调用方给的字段顺序（资产注册表的字段声明序），
 * 未列出的字段按字典序排在后面——旧文件里多出来的字段不会因为一次写回就换位置。
 */
export function serializeFrontmatter(data: Frontmatter, order: readonly string[] = []): string {
  const keys = Object.keys(data);
  const known = order.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !order.includes(k)).sort();
  const lines: string[] = [];
  for (const key of [...known, ...rest]) {
    const value = data[key] as FrontmatterValue;
    if (Array.isArray(value)) {
      const items = value.map((item) => scalarText(item));
      lines.push(`${key}: [${items.join(", ")}]`);
      continue;
    }
    lines.push(`${key}: ${scalarText(value)}`);
  }
  return lines.join("\n");
}

/**
 * 头部与正文拼回整份文件。正文末尾统一留一个换行，头部之后空一行——`splitFrontmatter`
 * 反向剥掉的正是这一行，所以 round-trip 是逐字节稳定的（测试钉着）。
 */
export function withFrontmatter(data: Frontmatter, body: string, order: readonly string[] = []): string {
  const head = serializeFrontmatter(data, order);
  const trimmed = body.replace(/\s+$/, "");
  return head === "" ? `${trimmed}\n` : `---\n${head}\n---\n\n${trimmed}\n`;
}

/** 数组值统一读成字符串数组（数字/布尔按文本），给 list 与 UI 用。 */
export function asStringList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

/** 标量值统一读成字符串；数组取第一个（标题这类字段不该是列表）。 */
export function asString(value: FrontmatterValue | undefined): string | undefined {
  if (value === undefined || value === null || Array.isArray(value)) return undefined;
  return String(value);
}

/** 标量值读成数字；不是数字或不是整数时返回 undefined（校验层再报 problem）。 */
export function asInteger(value: FrontmatterValue | undefined): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}