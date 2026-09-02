/**
 * P1a 单章编辑循环 CLI。
 * 用法：
 *   bun run src/run.ts [caseId]     # 默认 case-01-huangdao-qiusheng
 * 流程：写手起草 v0 → 审判三遍（拆情节 → 逐情节深审 → 汇总）→ 写手按改稿报告改写 v1/v2。
 * 停止机制：审判汇总时判定"是否还有必须修的硬伤"（JUDGE: NEEDS_FIX / CLEAN），无硬伤即停。
 * 产物：experiments/output/<caseId>/ 下各版本稿 + 审判报告。
 */
import { loadLLMConfig, chat, type LLMConfig } from "./llm";
import { loadCriteria } from "./criteria";
import { loadCase, extractChapterBrief } from "./case";
import { writerPrompt, segmentPrompt, beatReviewPrompt, synthesizePrompt } from "./prompts";
import { save } from "./storage";

const DEFAULT_CASE = "case-01-huangdao-qiusheng";
const MAX_ROUNDS = 3;
const CHAPTER_NUM = 1;

/** 审判三遍用 high 思考 + 足量预算（high 思考会大量吃 max_tokens，预算不足会触发截断报错） */
const JUDGE_OPTS = { reasoning: "high" as const, maxTokens: 64000 };

interface Beat {
  index: number;
  start: number;
  end: number;
  label: string;
  summary: string;
}

interface JudgeResult {
  report: string;
  needsFix: boolean;
}

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
  console.log("[talemate] 审判=拆情节→逐情节深审→汇总；停止=无必须修的硬伤");
  console.log("");

  const criteria = await loadCriteria(); // 情节标准 + 段落标准，逐情节深审用
  const novel = await loadCase(caseId);
  const chapterBrief = extractChapterBrief(novel.outline, CHAPTER_NUM);

  const drafts: string[] = [];
  const reports: string[] = [];
  let bestIdx = 0; // 最后一份被审判判为无硬伤的稿子；都没判过则取最后一版

  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(`── 第 ${round + 1} 轮：写手${round === 0 ? "起草" : "改写"} →`);

    const w = writerPrompt({
      caseTitle: novel.title,
      ideaBook: novel.ideaBook,
      outline: novel.outline,
      chapterNum: CHAPTER_NUM,
      chapterBrief,
      previousDraft: drafts[drafts.length - 1],
      critique: reports[reports.length - 1],
    });
    const draft = (await chat(config, w.system, w.user)).content;
    drafts.push(draft);
    await save(`${caseId}/draft_v${round}.md`, draft);
    console.log(`    v${round} 已保存（${draft.length} 字）`);

    console.log(`── 审判 v${round} →`);
    const judge = await judgeChapter(config, criteria, novel, CHAPTER_NUM, chapterBrief, draft);
    reports.push(judge.report);
    await save(`${caseId}/critique_v${round}.md`, judge.report);
    bestIdx = round;
    console.log(`    判定：${judge.needsFix ? "NEEDS_FIX（有硬伤，需再改）" : "CLEAN（无硬伤，可定稿）"}`);

    if (!judge.needsFix) break;
    console.log("");
  }

  console.log("\n── 汇总 ──");
  console.log(
    `各版审判：${reports.map((r, i) => `v${i}=${parseNeedsFix(r) ? "NEEDS_FIX" : "CLEAN"}`).join(" ; ")}`,
  );
  console.log(`最佳稿：v${bestIdx}`);
  console.log(`产物目录：experiments/output/${caseId}/`);
}

/** 三遍式审判：拆情节 → 逐情节深审 → 汇总，返回改稿报告 + 是否还需修改。 */
async function judgeChapter(
  config: LLMConfig,
  criteria: string,
  novel: { title: string; ideaBook: string },
  chapterNum: number,
  chapterBrief: string,
  draft: string,
): Promise<JudgeResult> {
  // 第一遍：标段号 + 拆情节
  const paras = numberParagraphs(draft);
  const numbered = paras.join("\n\n");
  const seg = segmentPrompt({
    caseTitle: novel.title,
    ideaBook: novel.ideaBook,
    chapterNum,
    chapterBrief,
    draft: numbered,
  });
  const segText = (await chat(config, seg.system, seg.user, JUDGE_OPTS)).content;
  const beats = parseBeats(segText) ?? [{ index: 1, start: 1, end: paras.length, label: "整章", summary: "" }];
  console.log(
    `    拆出 ${beats.length} 个情节：${beats.map((b) => `${b.index}:${b.label}[段${b.start}-${b.end}]`).join("  ")}`,
  );

  // 第二遍：逐情节深审（每个情节一次调用，只看本情节原文）
  const reviews: string[] = [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const start = Math.max(1, b.start);
    const end = Math.min(paras.length, b.end);
    const beatText = paras.slice(start - 1, end).join("\n\n");
    const prevBeat = i > 0 ? beats[i - 1] : null;
    const nextBeat = i < beats.length - 1 ? beats[i + 1] : null;
    const br = beatReviewPrompt({
      criteria,
      caseTitle: novel.title,
      ideaBook: novel.ideaBook,
      chapterNum,
      chapterBrief,
      beatIndex: i + 1,
      beatLabel: b.label,
      beatText,
      prevTail: prevBeat ? paras[Math.min(paras.length, prevBeat.end) - 1] : undefined,
      nextHead: nextBeat ? paras[Math.min(paras.length, nextBeat.start) - 1] : undefined,
    });
    const review = (await chat(config, br.system, br.user, JUDGE_OPTS)).content;
    reviews.push(review);
    console.log(`    情节 ${b.index}（${b.label}）已审`);
  }

  // 第三遍：汇总 + 停止信号
  const syn = synthesizePrompt({
    caseTitle: novel.title,
    chapterNum,
    chapterBrief,
    reviews,
  });
  const report = (await chat(config, syn.system, syn.user, JUDGE_OPTS)).content;
  return { report, needsFix: parseNeedsFix(report) };
}

/** 把正文切成标了段号 [N] 的段落；优先按空行分，空行不够再按单个换行分。 */
function numberParagraphs(draft: string): string[] {
  const paras = draft
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const source = paras.length > 1 ? paras : draft.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  return source.map((p, i) => `[${i + 1}] ${p}`);
}

/** 解析拆情节输出（BEATS: 之后的 "序号|起止段号|功能标签|一句话概括" 行）；失败返回 null。 */
function parseBeats(text: string): Beat[] | null {
  const beats: Beat[] = [];
  let inBeats = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "BEATS:") {
      inBeats = true;
      continue;
    }
    if (!inBeats || t === "") continue;
    const m = t.match(/^(\d+)\|(\d+)(?:-(\d+))?\|([^|]+)\|(.*)$/);
    if (m) {
      const start = +m[2];
      const end = m[3] ? +m[3] : start; // 单段情节写成 "13" 时 end=start
      beats.push({ index: +m[1], start, end, label: m[4].trim(), summary: m[5].trim() });
    }
  }
  return beats.length ? beats : null;
}

/** 解析汇总的停止信号（JUDGE: NEEDS_FIX / CLEAN）；解析失败默认从严当有硬伤。 */
function parseNeedsFix(report: string): boolean {
  const m = report.match(/JUDGE:\s*(NEEDS_FIX|CLEAN)/);
  if (m) return m[1] === "NEEDS_FIX";
  if (/还有必须修/.test(report)) return true;
  if (/无必须修/.test(report)) return false;
  return true;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
