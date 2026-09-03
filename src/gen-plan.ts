/**
 * 章规划：把本章任务切成带功能的节拍序列，落盘成章节大纲。
 * 这是"生成前"的结构规划（替代旧三联式事后审判）；生成方式（逐拍/整章）后续再定。
 * 用法：bun run src/gen-plan.ts [caseId] [chapterNum] [styleId]
 *   可选 styleId：experiments/styles/<styleId>.md，只抽"结构约束行"喂规划（视角/基调等硬规则）。
 * 产物：experiments/output/<caseId>/plan_ch<num>.md
 */
import { readFile } from "node:fs/promises";
import { loadLLMConfig, chat } from "./llm";
import { loadCase, extractChapterBrief, extractPreviousHook } from "./case";
import { chapterPlanPrompt, extractStyleConstraint } from "./prompts";
import { save } from "./storage";

const DEFAULT_CASE = "case-01-huangdao-qiusheng";
const DEFAULT_CH = 1;
/** 章规划是轻量分析，low 思考即可（省预算）；如需更细可调高 */
const PLAN_OPTS = { reasoning: "low" as const };

async function main() {
  const caseId = process.argv[2] ?? DEFAULT_CASE;
  const chapterNum = Number(process.argv[3]) || DEFAULT_CH;
  const styleId = process.argv[4];
  const config = loadLLMConfig();

  // 可选文风：只抽"结构约束行"（影响拍/内容选什么的硬规则），不塞完整声音层
  const styleConstraint = styleId
    ? extractStyleConstraint(await readFile(`experiments/styles/${styleId}.md`, "utf-8"))
    : undefined;

  const hasCreds =
    config.apiKey || (config.provider === "anthropic" && process.env.ANTHROPIC_API_KEY);
  if (!hasCreds) {
    console.error("✗ 未找到 API key：设置 TALEMATE_API_KEY（anthropic 也可用 ANTHROPIC_API_KEY），或复制 .env.example 为 .env 填写。");
    console.error("  参考：bun run src/gen-plan.ts");
    process.exit(1);
  }

  const novel = await loadCase(caseId);
  const chapterBrief = extractChapterBrief(novel.outline, chapterNum);
  const previousHook = extractPreviousHook(novel.outline, chapterNum);

  console.log(`[talemate] provider=${config.provider} model=${config.model} reasoning=${PLAN_OPTS.reasoning}`);
  console.log(`[talemate] 用例=${caseId} 规划第 ${chapterNum} 章`);
  console.log(`[talemate] 上一章钩子=${previousHook ?? "无"}`);
  console.log(`[talemate] 文风约束=${styleId ?? "无"}${styleConstraint ? `（${styleConstraint.length} 字）` : ""}`);
  console.log("");

  const p = chapterPlanPrompt({
    caseTitle: novel.title,
    ideaBook: novel.ideaBook,
    outline: novel.outline,
    chapterNum,
    chapterBrief,
    ...(previousHook ? { previousHook } : {}),
    ...(styleConstraint ? { styleConstraint } : {}),
  });
  const res = await chat(config, p.system, p.user, PLAN_OPTS);
  const plan = res.content;
  await save(`${caseId}/plan_ch${chapterNum}.md`, plan);
  console.log(`已保存：experiments/output/${caseId}/plan_ch${chapterNum}.md（${plan.length} 字）`);
  if (res.reasoning) {
    await save(`${caseId}/plan_ch${chapterNum}-reasoning.md`, res.reasoning);
    console.log(`思考过程已保存：experiments/output/${caseId}/plan_ch${chapterNum}-reasoning.md`);
  }
  console.log("\n" + plan);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
