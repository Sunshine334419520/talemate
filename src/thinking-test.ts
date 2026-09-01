/**
 * 思考模式对比测试：同一场景、同一文风卡，4 种配置各生成一遍开篇。
 *   1. off      = 非思考 + 当前温度(1.5)
 *   2. low      = 思考 effort=low
 *   3. high     = 思考 effort=high
 *   4. max      = 思考 effort=max
 * 产物：experiments/output/styles-test/<label>.md
 */
import { readFile } from "node:fs/promises";
import { loadLLMConfig, chat } from "./llm";
import { loadCase, extractChapterBrief } from "./case";
import { writerPrompt } from "./prompts";
import { save } from "./storage";

const CASE_ID = "case-01-huangdao-qiusheng";
const STYLE = "style-05-touming";

async function main() {
  const configs: { label: string; reasoning: string; temperature?: string }[] = [
    { label: "off-temp15", reasoning: "off", temperature: "1.5" },
    { label: "think-low", reasoning: "low" },
    { label: "think-high", reasoning: "high" },
    { label: "think-max", reasoning: "max" },
  ];

  const novel = await loadCase(CASE_ID);
  const chapterBrief = extractChapterBrief(novel.outline, 1);
  const styleCard = await readFile(`experiments/styles/${STYLE}.md`, "utf-8");

  for (const c of configs) {
    const env: Record<string, string | undefined> = { ...process.env, TALEMATE_REASONING: c.reasoning };
    if (c.temperature) env.TALEMATE_TEMPERATURE = c.temperature;
    else delete env.TALEMATE_TEMPERATURE;
    const config = loadLLMConfig(env as NodeJS.ProcessEnv);
    console.log(
      `── ${c.label}（reasoning=${config.reasoning} temp=${config.temperature ?? "未设"} max_tokens=${config.maxTokens}）→`,
    );

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
    await save(`styles-test/${c.label}.md`, draft);
    console.log(`    已保存（${draft.length} 字）`);
  }

  console.log("\n产物目录：experiments/output/styles-test/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
