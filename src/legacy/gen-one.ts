/**
 * 单发生成：用当前默认写手 prompt（无文风卡）跑一段开篇，快速看效果。
 * 用法：bun run src/gen-one.ts [caseId]
 * 产物：experiments/output/gen-one-opening.md + gen-one-reasoning.md（思考过程）
 */
import { loadLLMConfig, chat } from "./llm";
import { loadCase, extractChapterBrief } from "./case";
import { writerPrompt } from "./prompts";
import { save } from "./storage";

async function main() {
  const caseId = process.argv[2] ?? "case-01-huangdao-qiusheng";
  const config = loadLLMConfig();
  const novel = await loadCase(caseId);
  const brief = extractChapterBrief(novel.outline, 1);

  console.log(`[talemate] provider=${config.provider} model=${config.model} reasoning=${config.reasoning} temp=${config.temperature ?? "未设"}`);
  const w = writerPrompt({
    caseTitle: novel.title,
    ideaBook: novel.ideaBook,
    outline: novel.outline,
    chapterNum: 1,
    chapterBrief: brief,
    openingOnly: true,
  });
  console.log(`system prompt 长度：${w.system.length} 字`);
  const res = await chat(config, w.system, w.user);
  const draft = res.content;
  await save("gen-one-opening.md", draft);
  console.log(`\n已保存：experiments/output/gen-one-opening.md（${draft.length} 字）`);
  if (res.reasoning) {
    await save("gen-one-reasoning.md", res.reasoning);
    console.log(`思考过程已保存：experiments/output/gen-one-reasoning.md（${res.reasoning.length} 字）`);
  } else {
    console.log("（本次无思考过程——可能 reasoning 未开启）");
  }
  console.log("\n" + draft);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
