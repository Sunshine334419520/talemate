import { readFile } from "node:fs/promises";

export interface NovelCase {
  id: string;
  title: string;
  ideaBook: string;
  outline: string;
}

/** 从 experiments/cases/<id>.md 解析用例（企划书 + 前 3 章细纲） */
export async function loadCase(id: string): Promise<NovelCase> {
  const text = await readFile(`experiments/cases/${id}.md`, "utf-8");
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? id;
  return {
    id,
    title,
    ideaBook: extractSection(text, "企划书") ?? "",
    outline: extractSection(text, "前 3 章细纲") ?? "",
  };
}

/** 取出本章任务描述（如 "**第 1 章**：…" 一行） */
export function extractChapterBrief(outline: string, chapterNum: number): string {
  const re = new RegExp(`\\*\\*第\\s*${chapterNum}\\s*章\\*\\*[：:]\\s*(.+)`);
  const m = outline.match(re);
  return m?.[1]?.trim() ?? `写第 ${chapterNum} 章`;
}

/** 取出上一章（chapterNum-1）的结尾钩子（章末钩子回收规则的输入）；第 1 章无上章返回 undefined */
export function extractPreviousHook(outline: string, chapterNum: number): string | undefined {
  if (chapterNum <= 1) return undefined;
  const re = new RegExp(`\\*\\*第\\s*${chapterNum - 1}\\s*章\\*\\*.*?结尾钩子[：:]\\s*(.+)`);
  const m = outline.match(re);
  return m?.[1]?.trim() || undefined;
}

/** 按 "## <标题>" 切分后取对应小节（自然处理末段到文件尾的情况） */
function extractSection(text: string, heading: string): string | null {
  const chunks = text.split(/^## /m);
  for (const chunk of chunks.slice(1)) {
    const nl = chunk.indexOf("\n");
    const h = nl === -1 ? chunk.trim() : chunk.slice(0, nl).trim();
    if (h === heading) {
      return nl === -1 ? "" : chunk.slice(nl + 1).trim();
    }
  }
  return null;
}
