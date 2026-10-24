/**
 * 正文排版：把一段里的多个句子切成“一句一段”。
 *
 * 这是排版，不是写作。模型按声音把整段写完，落盘前由这里按句号切行——这样“一句一段”
 * 是确定的，不靠模型自觉，也不会为了让模型数句号而牺牲叙述。
 *
 * 只认句号 `。`；问号、感叹号、省略号都不触发换行。对话引号内的句号不拆：一个引号里的
 * 连续讲话算一段，避免切出没有开引号的残片；引号结束后的叙述照常按句号切。标题、列表、
 * 引用、表格、代码围栏原样保留。
 */
export function formatProse(text: string): string {
  const ending = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const blocks: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue; // 段间统一由 \n\n 生成
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      blocks.push(line);
      continue;
    }
    if (inFence || isStructural(trimmed)) {
      blocks.push(line);
      continue;
    }
    for (const sentence of splitSentences(trimmed)) {
      if (sentence) blocks.push(sentence);
    }
  }

  const out = blocks.join(ending === "\n" ? "\n\n" : "\r\n\r\n");
  return out ? `${out}${ending}` : "";
}

/** 不是散文行的 Markdown 结构：标题、列表、引用、表格、分隔线、代码围栏。 */
function isStructural(line: string): boolean {
  return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||```|---+$)/.test(line);
}

/**
 * 只按句号 `。` 切一句一段。引号里的句子保持完整：引号内出现 `。` 不切，等闭引号再判断
 * 这一整段讲话是否以 `。` 收尾。这样 `“走吧。”她没动。` 会切成两句，而
 * `“行不行，得拆开看。您要是信不过我，现在就可以换人。”` 仍是一段完整讲话。
 * 问号、感叹号、省略号不是触发点；紧跟句号后的 ！？ 归这一句。
 */
function splitSentences(line: string): string[] {
  const out: string[] = [];
  const stop = "。";
  let buf = "";
  let quoteDepth = 0;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    buf += ch;

    if (ch === "“") {
      quoteDepth++;
      i++;
      continue;
    }

    if (ch === "”") {
      if (quoteDepth > 0) quoteDepth--;
      if (quoteDepth === 0 && buf.slice(0, -1).trimEnd().endsWith(stop)) {
        out.push(buf.trim());
        buf = "";
      }
      i++;
      continue;
    }

    if (ch === stop && quoteDepth === 0) {
      // 只认句号。紧跟在句号后的 ！？ 归这一句，不单独触发换行。
      while (i + 1 < line.length && (line[i + 1] === "！" || line[i + 1] === "？")) {
        i++;
        buf += line[i];
      }
      while (i + 1 < line.length && (line[i + 1] === "”" || line[i + 1] === "’")) {
        i++;
        buf += line[i];
      }
      out.push(buf.trim());
      buf = "";
    }

    i++;
  }

  if (buf.trim()) out.push(buf.trim());
  return out;
}
