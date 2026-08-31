/**
 * 文风对比演示：同一用例、同一场景，用不同内置文风卡各写一遍开篇。
 * 用法：
 *   bun run src/styles-demo.ts [caseId] [styleId]
 *     caseId 默认 case-01-shichang-zhichang
 *     styleId 可选（如 style-02-noir）；不传则跑全部文风卡
 * 产物：experiments/output/styles/<styleId>.md
 */
import { readFile, readdir } from "node:fs/promises";
import { loadLLMConfig, chat } from "./llm";
import { loadCriteria, loadWriterCriteria } from "./criteria";
import { loadCase, extractChapterBrief } from "./case";
import { writerPrompt } from "./prompts";
import { save } from "./storage";

const STYLES_DIR = "experiments/styles";

async function main() {
  const caseId = process.argv[2] ?? "case-01-shichang-zhichang";
  const styleArg = process.argv[3];
  const config = loadLLMConfig();

  const writerCriteria = await loadWriterCriteria();
  const novel = await loadCase(caseId);
  const chapterBrief = extractChapterBrief(novel.outline, 1);

  let files = (await readdir(STYLES_DIR)).filter((f) => f.endsWith(".md"));
  if (styleArg) {
    const hit = files.find((f) => f.includes(styleArg));
    if (!hit) {
      console.error(`✗ 未找到文风卡：${styleArg}（可用：${files.join("、")}）`);
      process.exit(1);
    }
    files = [hit];
  }

  console.log(`[talemate] provider=${config.provider} model=${config.model}`);
  console.log(`[talemate] 用例=${caseId} 文风数=${files.length}（开篇 400-500 字）`);
  console.log("");

  for (const file of files) {
    const styleCard = await readFile(`${STYLES_DIR}/${file}`, "utf-8");
    const styleId = file.replace(/\.md$/, "");
    console.log(`── 文风 ${styleId} →`);
    const w = writerPrompt({
      criteria: writerCriteria,
      caseTitle: novel.title,
      ideaBook: novel.ideaBook,
      outline: novel.outline,
      chapterNum: 1,
      chapterBrief,
      styleCard,
      openingOnly: true,
    });
    const draft = await chat(config, w.system, w.user);
    await save(`styles/${styleId}.md`, draft);
    console.log(`    已保存（${draft.length} 字）`);
  }

  console.log("\n产物目录：experiments/output/styles/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
