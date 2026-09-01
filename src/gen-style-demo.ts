/**
 * 单次文风试写：用指定文风卡生成 case-01 第 1 章开篇，打印正文并落盘。
 * 用法：
 *   bun run src/gen-style-demo.ts [styleId]      # styleId 默认 style-01-wangwen
 * 产物：experiments/output/styles-demo/<styleId>.md
 */
import { readFile } from "node:fs/promises";
import { loadLLMConfig, chat } from "./llm";
import { loadCase, extractChapterBrief } from "./case";
import { writerPrompt } from "./prompts";
import { save } from "./storage";

const CASE_ID = "case-01-huangdao-qiusheng";
const DEFAULT_STYLE = "style-01-wangwen";

async function main() {
  const styleId = process.argv[2] ?? DEFAULT_STYLE;
  const config = loadLLMConfig();
  if (!config.apiKey) {
    console.error("✗ 未找到 API key：设置 TALEMATE_API_KEY，或复制 .env.example 为 .env 填写。");
    process.exit(1);
  }

  const novel = await loadCase(CASE_ID);
  const chapterBrief = extractChapterBrief(novel.outline, 1);
  const styleCard = await readFile(`experiments/styles/${styleId}.md`, "utf-8");

  console.log(`[demo] provider=${config.provider} model=${config.model}`);
  console.log(`[demo] 用例=${CASE_ID} 文风=${styleId}（开篇 400-500 字）`);
  console.log("");

  const w = writerPrompt({
    caseTitle: novel.title,
    ideaBook: novel.ideaBook,
    outline: novel.outline,
    chapterNum: 1,
    chapterBrief,
    styleCard,
    openingOnly: true,
  });
  const draft = (await chat(config, w.system, w.user)).content;

  console.log("───── 正文 ─────");
  console.log(draft);
  console.log("----------------");
  const full = await save(`styles-demo/${styleId}.md`, draft);
  console.log(`\n已保存：${full}（${draft.length} 字）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
