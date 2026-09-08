/**
 * 离线测试（不打网络）：webfetch 的 HTML→text/markdown 转换 + websearch 的 DuckDuckGo 解析。
 * 只测纯函数；真联网行为不打测试。
 */
import { describe, test, expect } from "bun:test";
import { htmlToText, htmlToMarkdown, parseDuckDuckGo } from "./web_tools";

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
