/**
 * Plan → 正文（单次成文）：
 *   读章规划（体验工程图），用一次调用直接写出整章正文。
 *   规划已承载结构与读者体验（中枢问题/环账本/放大点/这章不许/每一拍的读者此刻），写手只负责执行。
 * 质量由 STRUCTURE_SPEC（结构/剧情）+ PROSE_SPEC（文笔）在生成时直接要求。
 * 用法：bun run src/gen-chapter.ts [caseId] [chapterNum] [styleId]
 *   styleId：experiments/styles/<styleId>.md，提供则带完整文风卡（声口）；不带则按默认。
 * 前置：先运行 src/gen-plan.ts 生成 plan_ch<N>.md（不存在会报错并提示）
 * 产物：experiments/output/<caseId>/chapter_v1.md
 */
import { readFile } from "node:fs/promises";
import { loadLLMConfig, chat } from "./llm";
import { loadCase, extractChapterBrief } from "./case";
import { chapterWritePrompt } from "./prompts";
import { save } from "./storage";

const DEFAULT_CASE = "case-01-huangdao-qiusheng";
const DEFAULT_CH = 1;
/** 单次成文：写作任务用 low 思考省预算（结构/文笔都靠规划+规格支撑） */
const CH_OPTS = { reasoning: "low" as const };

async function main() {
  const caseId = process.argv[2] ?? DEFAULT_CASE;
  const chapterNum = Number(process.argv[3]) || DEFAULT_CH;
  const styleId = process.argv[4];
  const config = loadLLMConfig();

  const hasCreds =
    config.apiKey || (config.provider === "anthropic" && process.env.ANTHROPIC_API_KEY);
  if (!hasCreds) {
    console.error("✗ 未找到 API key：设置 TALEMATE_API_KEY（anthropic 也可用 ANTHROPIC_API_KEY），或复制 .env.example 为 .env 填写。");
    console.error("  参考：bun run src/gen-chapter.ts");
    process.exit(1);
  }

  const novel = await loadCase(caseId);
  const chapterBrief = extractChapterBrief(novel.outline, chapterNum);

  const planPath = `experiments/output/${caseId}/plan_ch${chapterNum}.md`;
  const beatsPlan = await readFile(planPath, "utf-8").catch(() => null);
  if (!beatsPlan) {
    console.error(`✗ 没找到 ${planPath}，请先运行：bun run src/gen-plan.ts ${caseId} ${chapterNum}`);
    process.exit(1);
  }

  // 可选文风：提供则带完整文风卡（声口），不带则按默认
  const styleCard = styleId
    ? await readFile(`experiments/styles/${styleId}.md`, "utf-8")
    : undefined;

  console.log(`[talemate] provider=${config.provider} model=${config.model} reasoning=${CH_OPTS.reasoning}`);
  console.log(`[talemate] 用例=${caseId} 第 ${chapterNum} 章：plan → 正文（单次）`);
  console.log(`[talemate] 文风=${styleId ?? "无"}`);
  console.log("");

  const p = chapterWritePrompt({
    caseTitle: novel.title,
    ideaBook: novel.ideaBook,
    outline: novel.outline,
    chapterNum,
    chapterBrief,
    beatsPlan,
    ...(styleCard ? { styleCard } : {}),
  });
  const res = await chat(config, p.system, p.user, CH_OPTS);
  const chapter = res.content.trim();

  await save(`${caseId}/chapter_v1.md`, chapter);
  console.log(`已保存：experiments/output/${caseId}/chapter_v1.md（${chapter.length} 字）`);
  if (res.reasoning) {
    await save(`${caseId}/chapter_v1-reasoning.md`, res.reasoning);
    console.log(`思考过程已保存：experiments/output/${caseId}/chapter_v1-reasoning.md（${res.reasoning.length} 字）`);
  }
  console.log("\n" + chapter);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
