/**
 * markdown 渲染的唯一实现：对话正文、提问正文、问答回看共用同一道 DOMPurify。
 *
 * 外部文本进渲染层，而渲染层有网络——一个 <img onerror> 就够把稿子送出去。右栏的批注视图
 * 另有自己的渲染（它要往标记里插批注锚点），但净化这一步与这里同一条边界。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  return <div className={className ?? "md"} dangerouslySetInnerHTML={{ __html: html }} />;
}
