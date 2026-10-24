/**
 * 离线测试（不打网络）：webfetch 的 HTML→text/markdown 转换 + websearch 的 DuckDuckGo 解析。
 * 只测纯函数；真联网行为不打测试。
 */
import { describe, test, expect } from "bun:test";
import {
  deepSeekFetchBody,
  deepSeekSearchBody,
  htmlToText,
  htmlToMarkdown,
  parseDeepSeekSearch,
  parseDuckDuckGo,
  renderDeepSeekPage,
  selectWebSearchProvider,
} from "../src/tool/web_tools";
import { deepSeekWebTarget } from "../src/core/web";

const HTML = `<!doctype html><html><head><title>T</title>
<style>body{color:red}</style><script>alert(1)</script></head>
<body>
<h1>荒岛求生</h1>
<p>一座<strong>无人</strong>岛，水源在<a href="https://a.example/x">北边山洞</a>。</p>
<ul><li>淡水有限</li><li>季风决定救援窗口</li></ul>
</body></html>`;

describe("webfetch 转换", () => {
  test("htmlToText：剥标签/script/style，保留正文，解实体", () => {
    const text = htmlToText(`<p>猫 &amp; 狗 &#39;ok&#39;</p>`);
    expect(text).toContain("猫 & 狗 'ok'");
    const t = htmlToText(HTML);
    expect(t).toContain("荒岛求生");
    expect(t).toContain("无人");
    expect(t).not.toContain("<");
    expect(t).not.toContain("alert");
    expect(t).not.toContain("color:red");
  });

  test("htmlToMarkdown：转 markdown（标题/链接/列表），无残留标签", () => {
    const md = htmlToMarkdown(HTML);
    expect(md).toContain("# 荒岛求生");
    expect(md).toContain("[北边山洞](https://a.example/x)");
    expect(md).toMatch(/[-*]\s+淡水有限/);
    expect(md).not.toContain("<p>");
  });
});

describe("websearch DuckDuckGo 解析", () => {
  test("parseDuckDuckGo：抽 title/url/uddg 还原 + snippet", () => {
    const html = `
<div class="result results_links results_links_deep web-result">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example &amp; A</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x&amp;rut=y">Some <b>bold</b> snippet &mdash; text.</a>
</div>`;
    const [r] = parseDuckDuckGo(html);
    expect(r).toBeDefined();
    expect(r.title).toBe("Example & A");
    expect(r.url).toBe("https://example.com/a");
    expect(r.snippet).toContain("bold");
  });
});

describe("DeepSeek Search / Fetch", () => {
  test("有 key 就用 DeepSeek；没 key 不当成配置好了", () => {
    expect(deepSeekWebTarget({ deepseek: { apiKey: "sk-test" } }, {})).toMatchObject({
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com/v1/tools",
      count: 10,
    });
    expect(deepSeekWebTarget({}, {})).toBeUndefined();
    expect(deepSeekWebTarget({}, { DEEPSEEK_API_KEY: "env-key" })?.apiKey).toBe("env-key");
  });

  test("base 归一到 tools 前缀：旧 origin 补 /v1/tools，完整前缀原样保留", () => {
    const t = (baseURL: string) => deepSeekWebTarget({ deepseek: { apiKey: "k", baseURL } }, {})?.baseURL;
    expect(t("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1/tools");
    expect(t("https://api.deepseek.com/v1/tools")).toBe("https://api.deepseek.com/v1/tools");
    expect(t("https://api.deepseek.com/v1/tools/")).toBe("https://api.deepseek.com/v1/tools");
    // 直接粘完整端点也认：去掉最后一段，程序自己追加 /search
    expect(t("https://api.deepseek.com/v1/tools/search")).toBe("https://api.deepseek.com/v1/tools");
  });

  test("结果数：默认 10，1–50 有效，越界回默认", () => {
    const count = (n?: number) => deepSeekWebTarget({ deepseek: { apiKey: "k", ...(n === undefined ? {} : { count: n }) } }, {})?.count;
    expect(count()).toBe(10);
    expect(count(25)).toBe(25);
    expect(count(100)).toBe(10);
    expect(count(0)).toBe(10);
  });

  test("设置里的 DeepSeek 优先于 .env 的默认后端（否则设置会被静默作废）", () => {
    const settings = { deepseek: { apiKey: "sk-test" } };
    expect(selectWebSearchProvider(settings, {})).toBe("deepseek");
    // 用户在界面上刚配的，不该被一行 TALEMATE_WEBSEARCH_PROVIDER=tavily 压掉
    expect(selectWebSearchProvider(settings, { TALEMATE_WEBSEARCH_PROVIDER: "bocha", BOCHA_API_KEY: "b" })).toBe("deepseek");
    // 没有 DeepSeek 时，显式 provider 照旧生效
    expect(selectWebSearchProvider({}, { TALEMATE_WEBSEARCH_PROVIDER: "bocha", BOCHA_API_KEY: "b" })).toBe("bocha");
  });

  test("Search 请求只要摘要，不拉整页正文", () => {
    expect(deepSeekSearchBody("栾氏 灭族", 6)).toEqual({ query: "栾氏 灭族", count: 6, need_content: false });
    expect(deepSeekFetchBody("https://example.com/a")).toEqual({ url: "https://example.com/a" });
  });

  test("Search 响应优先用 summary（给模型读的长摘要）", () => {
    const results = parseDeepSeekSearch({
      results: [{ title: "T", url: "https://a", snippet: "短", summary: "长摘要" }],
    });
    expect(results).toEqual([{ title: "T", url: "https://a", snippet: "长摘要" }]);
  });

  test("Fetch 响应补标题，且不重复已有的 H1", () => {
    expect(renderDeepSeekPage({ title: "标题", content: "正文" })).toBe("# 标题\n\n正文");
    expect(renderDeepSeekPage({ title: "标题", content: "# 标题\n\n正文" })).toBe("# 标题\n\n正文");
  });
});
