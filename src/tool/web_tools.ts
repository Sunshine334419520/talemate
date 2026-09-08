/**
 * web-tools：联网工具（webfetch / websearch）。
 *
 * 参考 opencode `packages/opencode/src/tool/webfetch.ts` 与 `websearch.ts` 的形状，
 * 去 Effect、去云侧付费搜索，落到自托管可跑：
 * - webfetch：http(s) 抓取 + UA + 大小上限 + 超时；HTML 按 format 转 markdown / text（turndown）。
 * - websearch：可插拔 provider（照 opencode selectWebSearchProvider）。后端选择：
 *     duckduckgo（默认，无 key，尽力而为——部分网络被反爬拦截）
 *     bocha 博查（国内直连，推荐）→ BOCHA_API_KEY
 *     tavily / exa（国外主流）→ TAVILY_API_KEY / EXA_API_KEY
 *   用 TALEMATE_WEBSEARCH_PROVIDER 切。无对应 key 时回退 duckduckgo。
 * 纯工具层：只用全局 fetch（Bun/Node 18+），不依赖 ToolContext 注入。
 */
import TurndownService from "turndown";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_OUTPUT_CHARS = 80_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

// ─── 工具：webfetch ───

type FetchFormat = "text" | "markdown" | "html";

/** 抓一个 URL 并按 format 返回内容。出错抛异常（runner 会包成 error part 让模型自纠）。 */
async function fetchUrl(url: string, format: FetchFormat, timeoutSec?: number): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error("URL 必须以 http:// 或 https:// 开头");
  const timeoutMs = Math.min((timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, MAX_TIMEOUT_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: acceptFor(format),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    // Cloudflare 反爬 403 → 用诚实 UA 重试一次（照 opencode）
    if (res.status === 403 && res.headers.get("cf-mitigated") === "challenge") {
      res = await fetch(url, {
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "User-Agent": "opencode", Accept: acceptFor(format) },
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error("响应超过 5MB 上限");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error("响应超过 5MB 上限");

    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    const mime = ctype.split(";")[0]?.trim() ?? "";
    if (mime.startsWith("image/") || mime === "application/pdf" || mime === "application/octet-stream") {
      throw new Error(`内容为 ${mime || "二进制"}，本工具只取文本网页`);
    }
    const body = new TextDecoder().decode(buf);
    const isHtml = mime.includes("html") || /<html[\s>]/i.test(body.slice(0, 512));
    if (!isHtml) return truncate(body);
    if (format === "html") return truncate(body);
    if (format === "text") return truncate(htmlToText(body));
    return truncate(htmlToMarkdown(body));
  } finally {
    clearTimeout(timer);
  }
}

function acceptFor(format: FetchFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1";
  }
}

/** HTML → 纯文本：剥 script/style/noscript + 标签，块级结尾补换行，解实体。 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/(<\/(?:p|div|li|h[1-6]|tr|section|article|blockquote|pre|table)>)/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return decodeEntities(s).trim();
}

const mdService = new TurndownService({ headingStyle: "atx", hr: "---", bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "*" });
mdService.remove(["script", "style", "meta", "link", "noscript", "iframe"]);

/** HTML → markdown（turndown，照 opencode）。转换失败退回纯文本。 */
export function htmlToMarkdown(html: string): string {
  try {
    const md = mdService.turndown(html).trim();
    return md || htmlToText(html);
  } catch {
    return htmlToText(html);
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…（内容过长，已截断到前 ${MAX_OUTPUT_CHARS} 字符）`;
}

export const webFetchTool: RegisteredTool<{ url: string; format?: FetchFormat; timeout?: number }> = defineTool<{
  url: string;
  format?: FetchFormat;
  timeout?: number;
}>({
  id: "webfetch",
  description: P("webfetch"),
  input: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (http/https)" },
      format: { type: "string", enum: ["text", "markdown", "html"], description: "Output format; default markdown" },
      timeout: { type: "number", description: "Timeout in seconds; default 30, max 120" },
    },
    required: ["url"],
  },
  async execute(args) {
    const content = await fetchUrl(args.url, args.format ?? "markdown", args.timeout);
    return { output: content, metadata: { url: args.url, format: args.format ?? "markdown" } };
  },
});

// ─── 工具：websearch ───

type SearchProvider = "duckduckgo" | "bocha" | "tavily" | "exa";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * provider 选择：
 * - 显式 TALEMATE_WEBSEARCH_PROVIDER 指定 → 用它；该 provider 没配 key → duckduckgo。
 * - 未显式指定 → 默认 tavily（有 TAVILY_API_KEY 时），否则 bocha/exa，最后 duckduckgo。
 */
export function selectWebSearchProvider(): SearchProvider {
  const keyOf: Record<SearchProvider, () => string | undefined> = {
    tavily: () => process.env.TAVILY_API_KEY,
    bocha: () => process.env.BOCHA_API_KEY,
    exa: () => process.env.EXA_API_KEY,
    duckduckgo: () => undefined,
  };
  const want = (process.env.TALEMATE_WEBSEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (want === "tavily" || want === "bocha" || want === "exa" || want === "duckduckgo") {
    if (want === "duckduckgo" || keyOf[want]()) return want as SearchProvider;
    return "duckduckgo";
  }
  // 未显式指定：默认 tavily；其次 bocha/exa；全无 key 才 duckduckgo
  if (keyOf.tavily()) return "tavily";
  if (keyOf.bocha()) return "bocha";
  if (keyOf.exa()) return "exa";
  return "duckduckgo";
}

async function searchWeb(query: string, numResults: number): Promise<{ provider: SearchProvider; results: SearchResult[] }> {
  const provider = selectWebSearchProvider();
  const n = Math.max(1, Math.min(10, numResults));
  const results =
    provider === "bocha"
      ? await bochaSearch(query, n)
      : provider === "tavily"
        ? await tavilySearch(query, n)
        : provider === "exa"
          ? await exaSearch(query, n)
          : await ddgSearch(query, n);
  return { provider, results };
}

/** 博查（国内直连，LLM 应用常用）——POST /v1/web-search，Bearer key。 */
async function bochaSearch(query: string, n: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.BOCHA_API_KEY}` },
    body: JSON.stringify({ query, freshness: "noLimit", summary: true, count: n }),
  });
  if (!res.ok) throw new Error(`Bocha HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: { webPages?: { name?: string; url?: string; snippet?: string; summary?: string }[] };
  };
  return (data?.data?.webPages ?? []).map((r) => ({
    title: r.name ?? "",
    url: r.url ?? "",
    snippet: r.summary ?? r.snippet ?? "",
  }));
}

async function tavilySearch(query: string, n: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: n, search_depth: "basic" }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: (r.content ?? "").slice(0, 400) }));
}

async function exaSearch(query: string, n: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.EXA_API_KEY}` },
    body: JSON.stringify({ query, numResults: n, type: "auto", contents: { text: { maxCharacters: 400 } } }),
  });
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; highlights?: string[]; text?: string }[] };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.highlights?.[0] ?? (r.text ?? "").slice(0, 400),
  }));
}

async function ddgSearch(query: string, n: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(25_000),
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const results = parseDuckDuckGo(await res.text()).slice(0, n);
  if (!results.length) {
    throw new Error("DuckDuckGo 未返回结果（可能被反爬拦截）。可设 TALEMATE_WEBSEARCH_PROVIDER=bocha(国内)+BOCHA_API_KEY，或 tavily/exa + 对应 key。");
  }
  return results;
}

/** 解析 DuckDuckGo html 端点（title/href/url + snippet），导出供离线测试。 */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => htmlToText(m[1]).replace(/\s+/g, " "));
  return titles.map((m, i) => ({
    title: htmlToText(m[2]).replace(/\s+/g, " "),
    url: cleanSearchUrl(m[1]),
    snippet: snippets[i] ?? "",
  }));
}

function cleanSearchUrl(href: string): string {
  const h = decodeEntities(href);
  try {
    const u = new URL(h.startsWith("//") ? `https:${h}` : h);
    const g = u.searchParams.get("uddg");
    return g || u.href;
  } catch {
    return h;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, d: string) => String.fromCodePoint(parseInt(d, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

function renderResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title || "(无标题)"}\n   ${r.url}\n   ${r.snippet || ""}`)
    .join("\n\n");
}

export const webSearchTool: RegisteredTool<{ query: string; numResults?: number }> = defineTool<{
  query: string;
  numResults?: number;
}>({
  id: "websearch",
  description: P("websearch"),
  input: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      numResults: { type: "number", description: "Number of results; default 6, max 10" },
    },
    required: ["query"],
  },
  async execute(args) {
    const { provider, results } = await searchWeb(args.query, args.numResults ?? 6);
    const body = results.length ? renderResults(results) : "没有搜到结果，换个搜索词试试。";
    return { output: `（搜索后端：${provider}）\n${body}`, metadata: { provider, count: results.length } };
  },
});

export const WEB_TOOLS: RegisteredTool[] = [webFetchTool, webSearchTool];
