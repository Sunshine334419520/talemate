/**
 * P1a 单章编辑循环 CLI。
 * 用法：
 *   bun run src/run.ts [caseId]     # 默认 case-01-shichang-zhichang
 * 流程：写手起草 v0 → 批评者四件套 → 写手改写 v1/v2 → 每轮后【盲评并排】决定是否继续（新版不赢就停）→ 头条盲评 v0 vs 最佳稿。
 * 停止机制：主信号 = 盲评并排。绝对分数（合格线/优秀区）只做收敛曲线参考，不再作为停止条件——LLM 法官给绝对分天然偏高。
 * 产物：experiments/output/<caseId>/ 下各版本稿 + 批评报告 + 盲评。
 */
import { loadLLMConfig, chat, type LLMConfig } from "./llm";
import { loadCriteria, loadWriterCriteria } from "./criteria";
import { loadCase, extractChapterBrief } from "./case";
import { writerPrompt, criticPrompt, comparatorPrompt } from "./prompts";
import { save } from "./storage";

const DEFAULT_CASE = "case-01-shichang-zhichang";
const MAX_ROUNDS = 3;
const CHAPTER_NUM = 1;

interface Score {
  pass: number; // 合格线通过数 0-9
  excellent: number; // 优秀区通过数 0-6
  total: number; // 1-10 副产物
}

type Verdict = "A" | "B" | "TIE";

async function main() {
  const caseId = process.argv[2] ?? DEFAULT_CASE;
  const config = loadLLMConfig();

  const hasCreds =
    config.apiKey || (config.provider === "anthropic" && process.env.ANTHROPIC_API_KEY);
  if (!hasCreds) {
    console.error("✗ 未找到 API key：设置 TALEMATE_API_KEY（anthropic 也可用 ANTHROPIC_API_KEY），或复制 .env.example 为 .env 填写。");
    console.error("  参考：bun run src/run.ts");
    process.exit(1);
  }

  console.log(`[talemate] provider=${config.provider} model=${config.model}`);
  console.log(`[talemate] 用例=${caseId} 章节=第${CHAPTER_NUM}章 轮数上限=${MAX_ROUNDS}`);
  console.log("[talemate] 停止机制=每轮盲评并排（新版不赢即停）；绝对分数仅作参考");
  console.log("");

  const criteria = await loadCriteria(); // 完整判据（含检查协议），给批评者逐句执行
  const writerCriteria = await loadWriterCriteria(); // 精简判据，写手自检用，不给写手加负担
  const novel = await loadCase(caseId);
  const chapterBrief = extractChapterBrief(novel.outline, CHAPTER_NUM);

  const drafts: string[] = [];
  const reports: string[] = [];
  const scores: Score[] = [];
  const compares: { aIdx: number; bIdx: number; verdict: Verdict }[] = [];
  let bestIdx = 0; // 最后一版在盲评中胜出的稿子下标

  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(`── 第 ${round + 1} 轮：写手${round === 0 ? "起草" : "改写"} →`);

    const w = writerPrompt({
      criteria: writerCriteria,
      caseTitle: novel.title,
      ideaBook: novel.ideaBook,
      outline: novel.outline,
      chapterNum: CHAPTER_NUM,
      chapterBrief,
      previousDraft: drafts[drafts.length - 1],
      critique: reports[reports.length - 1],
    });
    const draft = await chat(config, w.system, w.user);
    drafts.push(draft);
    await save(`${caseId}/draft_v${round}.md`, draft);
    console.log(`    v${round} 已保存（${draft.length} 字）`);

    console.log(`── 批评者评审 v${round} →`);
    const c = criticPrompt({
      criteria,
      caseTitle: novel.title,
      ideaBook: novel.ideaBook,
      chapterNum: CHAPTER_NUM,
      chapterBrief,
      draft,
    });
    const report = await chat(config, c.system, c.user);
    reports.push(report);
    await save(`${caseId}/critique_v${round}.md`, report);

    const s = parseScores(report);
    scores.push(s);
    console.log(`    分数（参考）：total=${s.total}  合格线=${s.pass}/9  优秀区=${s.excellent}/6`);

    // 第 1 轮起：盲评并排是停止决策的主信号
    if (round >= 1) {
      const res = await blindCompare(config, caseId, drafts[round - 1], drafts[round], round - 1, round);
      compares.push({ aIdx: round - 1, bIdx: round, verdict: res.winner });
      const newerWins = res.winner === "B"; // workB = 新版
      console.log(`    盲评 v${round - 1} vs v${round}：${newerWins ? `新版 v${round} 胜 → 继续` : "新版未胜 → 停止"}`);
      if (newerWins) {
        bestIdx = round;
      } else {
        break;
      }
    }
    console.log("");
  }

  // 头条盲评：v0 vs 最佳稿（bestIdx 复用已有对比，避免重复调用）
  if (bestIdx === 0) {
    console.log("\n── 头条盲评 ──");
    console.log("    首轮改写未胜 v0，最佳稿 = v0，无头条对比。");
  } else if (!compares.some((c) => c.aIdx === 0 && c.bIdx === bestIdx)) {
    console.log("\n── 头条盲评 v0 vs 最佳稿 →");
    const res = await blindCompare(config, caseId, drafts[0], drafts[bestIdx], 0, bestIdx);
    console.log(`    v0 vs v${bestIdx}：${res.winner === "B" ? `v${bestIdx} 胜` : res.winner === "A" ? "v0 胜" : "不相上下"}`);
  } else {
    console.log("\n── 头条盲评 ──");
    console.log(`    复用已有盲评：v0 vs v${bestIdx}（见 blind_v0_vs_v${bestIdx}.md）`);
  }

  console.log("\n── 汇总 ──");
  scores.forEach((s, i) =>
    console.log(`v${i}: total=${s.total}  pass=${s.pass}/9  excellent=${s.excellent}/6`),
  );
  console.log(`分数曲线（参考）：${scores.map((s) => s.total).join(" → ")}`);
  console.log(
    `盲评链（主信号）：${compares.map((c) => `v${c.aIdx} vs v${c.bIdx}=${c.verdict}`).join(" ; ") || "无"}`,
  );
  console.log(`最佳稿：v${bestIdx}`);
  console.log(`产物目录：experiments/output/${caseId}/`);
}

/** 盲评并排：workA=旧版、workB=新版，评分 agent 不知道版本。返回 A（旧版胜）/B（新版胜）/TIE。 */
async function blindCompare(
  config: LLMConfig,
  caseId: string,
  workA: string,
  workB: string,
  aIdx: number,
  bIdx: number,
): Promise<{ winner: Verdict }> {
  const comp = comparatorPrompt({ workA, workB });
  const report = await chat(config, comp.system, comp.user);
  const winner = parseVerdict(report);
  await save(`${caseId}/blind_v${aIdx}_vs_v${bIdx}.md`, report);
  return { winner };
}

/** 解析批评者报告末尾的 SCORES 行；失败则回退按中文标签匹配。 */
function parseScores(report: string): Score {
  const m = report.match(/SCORES:\s*(\{[^}]+\})/);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      return {
        pass: Number(j.pass) || 0,
        excellent: Number(j.excellent) || 0,
        total: Number(j.total) || 0,
      };
    } catch {
      /* fall through to label matching */
    }
  }
  const num = (label: string) => {
    const mm = report.match(new RegExp(`${label}[：:]\\s*(\\d+)(?:\\s*/\\s*(\\d+))?`));
    return mm ? Number(mm[1]) : 0;
  };
  return { pass: num("合格线通过数"), excellent: num("优秀区通过数"), total: num("总分") };
}

/** 解析盲评 VERDICT 行；失败则按中文标签匹配。 */
function parseVerdict(report: string): Verdict {
  const m = report.match(/VERDICT:\s*(A|B|TIE)/);
  if (m) return m[1] as Verdict;
  if (report.includes("作品A更好") || report.includes("作品 A 更好")) return "A";
  if (report.includes("作品B更好") || report.includes("作品 B 更好")) return "B";
  return "TIE";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
