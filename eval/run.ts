/**
 * 评测 runner：把 case 跑成一个可比较的 RunResult。
 *
 * 一条 run 的边界：临时 TALEMATE_HOME、固定时钟、固定 fixture、固定 replay cassette。
 * case 通过公开的 `openSession` / `post` 驱动；只有 prose case 需要预先放一份"已批准的规划"，
 * 那是 harness 状态，不是绕过被测系统。
 *
 * 用法：
 *   bun run eval:run --case workflow-proposal-gate --record   # 首次录制
 *   bun run eval:run --case workflow-proposal-gate            # 离线回放
 *   bun run eval:run                                           # 全部 case，默认 3 次重复
 *
 * 边界：不认识 checks 的实现细节，只负责快照与结果；报告在 report.ts。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_ROOTS, hasCredentials, loadModelConfig, projectPaths, sessionPaths, today } from "../src/core/config";
import { PLAN_KEY, type PendingProposal } from "../src/core/types";
import { openSession, type UserIO } from "../src/session/session";
import { enumerateDocs, readDoc } from "../src/storage/corpus";
import { createProject } from "../src/storage/project";
import { loadMessages } from "../src/storage/session-store";
import { readChanges } from "../src/storage/change_index";
import { eventLogFor, resetEventLogs } from "../src/telemetry/log";
import { readCassette } from "../src/llm/replay";
import { hashJson } from "../src/core/hash";
import type { AnyTraceEvent } from "../src/telemetry/events";
import { buildHarness } from "../src/probe/patches";
import { clearPromptOverrides } from "../src/prompts";
import type { Variant } from "../src/probe/patches";
import { runChecks } from "./checks";
import type { TurnSnapshot } from "./checks";
import { renderBaselineReport, renderComparisonReport } from "./report";
import type { EvalCase, FailureBucket, Manifest, RunResult } from "./types";
import { validateAll } from "./validate";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_ROOT, "..");

interface Options {
  cases: string[];
  repeat: number;
  record: boolean;
  clock: string;
  timeoutMs: number;
  maxTokens: number;
  report?: string;
  variant?: string;
  includeUnstable: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    cases: [],
    repeat: 3,
    record: false,
    clock: "2026-11-01",
    timeoutMs: 180_000,
    maxTokens: 500_000,
    includeUnstable: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 缺少值`);
      return value;
    };
    switch (arg) {
      case "--case":
        options.cases.push(...next().split(",").filter(Boolean));
        break;
      case "--repeat":
        options.repeat = Number(next());
        break;
      case "--record":
        options.record = true;
        break;
      case "--replay":
        options.record = false;
        break;
      case "--today":
        options.clock = next();
        break;
      case "--timeout":
        options.timeoutMs = Number(next());
        break;
      case "--max-tokens":
        options.maxTokens = Number(next());
        break;
      case "--report":
        options.report = next();
        break;
      case "--variant":
        options.variant = next();
        break;
      case "--include-unstable":
        options.includeUnstable = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "bun run eval:run [选项]",
            "  --case <id>[,<id>]  只跑这些 case；缺省 = 全部",
            "  --repeat <n>        每个 case 跑几次（默认 3）",
            "  --record            miss 时调真实模型并写 cassette",
            "  --replay            只读 cassette（默认）",
            "  --today <YYYY-MM-DD> 冻结 system prompt 的日期（默认 2026-11-01）",
            "  --timeout <ms>      单轮超时（默认 180000）",
            "  --max-tokens <n>    录制模式的总 token 上限（默认 500000）",
            "  --report <path>     报告落点",
            "  --variant <id>      跑 baseline 与 eval/variants/<id>.json 的对比",
            "  --include-unstable  连同 unstable case 一起跑（默认跳过）",
          ].join("\n"),
        );
        process.exit(0);
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }

  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("--repeat 必须是正整数");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.clock)) throw new Error("--today 必须是 YYYY-MM-DD");
  return options;
}

async function loadCases(selected: string[]): Promise<EvalCase[]> {
  const checked = await validateAll(EVAL_ROOT);
  if (checked.issues.length > 0) {
    throw new Error(`case 校验失败：\n${checked.issues.map((i) => `  ${i.where}：${i.message}`).join("\n")}`);
  }

  const dirs = (await readdir(join(EVAL_ROOT, "cases"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const cases: EvalCase[] = [];
  for (const dir of dirs) {
    const value = JSON.parse(await readFile(join(EVAL_ROOT, "cases", dir, "case.json"), "utf-8")) as EvalCase;
    if (selected.length > 0 && !selected.includes(value.id)) continue;
    cases.push(value);
  }

  const missing = selected.filter((id) => !cases.some((c) => c.id === id));
  if (missing.length > 0) throw new Error(`找不到 case：${missing.join("、")}`);
  if (cases.length === 0) throw new Error("没有可跑的 case");
  return cases;
}

async function loadVariant(id: string): Promise<Variant> {
  const file = join(EVAL_ROOT, "variants", `${id}.json`);
  let value: Variant;
  try {
    value = JSON.parse(await readFile(file, "utf-8")) as Variant;
  } catch (err) {
    throw new Error(`读不到变体 ${id}：${err instanceof Error ? err.message : String(err)}`);
  }
  if (value.id !== id) throw new Error(`变体 id 与文件名不一致：${value.id} vs ${id}`);
  // buildHarness 会在替换串没命中时抛——在花钱之前就把坏变体拦下
  buildHarness(value);
  return value;
}

/** 读一棵 fixture 树，返回"相对路径 → 内容"。也用来算 contextHash。 */
async function readTree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, await readTree(join(dir, entry.name), rel));
    else if (entry.isFile()) out[rel] = await readFile(join(dir, entry.name), "utf-8");
  }
  return out;
}

async function snapshot(projectId: string, sessionId: string): Promise<TurnSnapshot> {
  const files: Record<string, string> = {};
  for (const root of DOC_ROOTS) {
    for (const path of await enumerateDocs(projectId, `${root}/`)) {
      const text = await readDoc(projectId, path);
      if (text !== undefined) files[path] = text;
    }
  }
  return {
    files,
    messages: await loadMessages(projectId, sessionId),
    events: await eventLogFor(projectId, sessionId).read(),
    changes: await readChanges(projectId, sessionId),
  };
}

function withTimeout<T>(run: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`单轮超时（${ms}ms）`));
    }, ms);
    run.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function failureBucketOf(results: { id: string; ok: boolean }[], verdict: RunResult["verdict"]): FailureBucket {
  if (verdict === "timeout") return "timeout";
  if (verdict === "error") return "provider-error";
  const failed = results.find((result) => !result.ok);
  if (failed === undefined) return "other";
  if (failed.id.startsWith("budget:")) return "budget-exceeded";
  if (failed.id.startsWith("tool-called") || failed.id.startsWith("tool-order")) return "no-tool";
  if (failed.id.startsWith("turn-halted")) return "approval-skipped";
  if (failed.id.startsWith("file-") || failed.id.startsWith("change-recorded")) return "file-wrong";
  if (failed.id.startsWith("max-")) return "budget-exceeded";
  return "other";
}

function codeCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

async function manifestOf(
  evalCase: EvalCase,
  runId: string,
  replayFile: string,
  usedKeysFile: string,
  events: readonly AnyTraceEvent[],
  fixtures: Record<string, string>,
  clock: string,
): Promise<Manifest> {
  const entries = await readCassette(replayFile);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const usedKeys = await readFile(usedKeysFile, "utf-8")
    .then((text) => text.split("\n").map((line) => line.trim()).filter(Boolean))
    .catch(() => [] as string[]);
  // 真正跑过的第一条请求才是这次 run 的 prompt；cassette 里可能还留着旧 case 的历史条目
  const request = usedKeys.map((key) => byKey.get(key)).find((entry) => entry !== undefined)?.request ?? entries[0]?.request;
  // 在线事件里的 request/header 与 cassette 的第一条请求应该一致；优先用前者，
  // 这样 manifest 不再依赖"cassette 里还剩什么"，在线 trace 与 eval 也能互相指认。
  const header = events.find((event) => event.type === "request/header");
  const h = header?.type === "request/header" ? header.data : undefined;
  const promptParts: Record<string, string> = h === undefined
    ? request === undefined
      ? {}
      : {
          system: hashJson(request.system),
          tools: hashJson(request.tools),
          messages: hashJson(request.messages),
        }
    : { system: h.systemHash, tools: h.toolsHash, messages: h.messagesHash };
  return {
    runId,
    caseHash: hashJson(evalCase),
    promptHash: h?.promptHash ?? (request === undefined ? "" : hashJson({ system: request.system, tools: request.tools })),
    promptParts,
    contextHash: hashJson(fixtures),
    toolsHash: h?.toolsHash ?? (request === undefined ? "" : hashJson(request.tools)),
    model: {
      provider: h?.provider ?? request?.provider ?? "unknown",
      model: h?.model ?? request?.model ?? "unknown",
      ...((h?.reasoning ?? request?.reasoning) === undefined ? {} : { reasoning: h?.reasoning ?? request?.reasoning }),
      ...((h?.temperature ?? request?.temperature) === null || (h?.temperature ?? request?.temperature) === undefined
        ? {}
        : { temperature: (h?.temperature ?? request?.temperature) as number }),
      maxTokens: h?.maxTokens ?? request?.maxTokens ?? 0,
    },
    codeCommit: codeCommit(),
    bun: process.versions.bun ?? "unknown",
    clock,
  };
}

/**
 * 评测里的"用户"：审批一律放行，提问一律回答"按你的判断来"。
 *
 * 不这么做的话，模型一问问题（哪怕问得对），默认 `autoIO` 会返回 cancelled 并结束回合，
 * case 就永远停在提问上——那是评测环境缺了一个用户，不是产品的失败。
 */
const EVAL_IO: UserIO = {
  onEvent() {},
  async confirm() {
    return "once";
  },
  async askUser(req) {
    return {
      kind: "answered",
      answers: req.questions.map((question) => ({
        id: question.id,
        selected: [],
        custom: "按你的判断来，直接继续。",
      })),
    };
  },
};

async function runOnce(
  evalCase: EvalCase,
  repeat: number,
  options: Options,
  variant: Variant | undefined,
  variantId: string,
): Promise<RunResult> {
  clearPromptOverrides();
  const caseDir = join(EVAL_ROOT, "cases", evalCase.id);
  const fixtures = evalCase.fixtures === true ? await readTree(join(caseDir, "fixtures")) : {};
  const runId = variantId === "baseline" ? `${evalCase.id}-r${repeat}` : `${evalCase.id}-${variantId}-r${repeat}`;
  const cassetteName = variant !== undefined && variant.patches.length > 0 ? `${variantId}.jsonl` : "baseline.jsonl";
  const replayFile = join(EVAL_ROOT, "cassettes", evalCase.id, cassetteName);
  const traceDir = join(REPO_ROOT, "traces", runId);

  const home = await mkdtemp(join(tmpdir(), "talemate-eval-"));
  const prevHome = process.env.TALEMATE_HOME;
  const prevToday = process.env.TALEMATE_TODAY;
  const prevReplay = process.env.TALEMATE_REPLAY_FILE;
  const prevRecord = process.env.TALEMATE_RECORD;
  const prevReasoning = process.env.TALEMATE_REASONING;
  const prevTemperature = process.env.TALEMATE_TEMPERATURE;
  const prevMaxTokens = process.env.TALEMATE_MAX_TOKENS;
  const prevUsed = process.env.TALEMATE_REPLAY_USED;
  const prevEnv = new Map(Object.keys(evalCase.env ?? {}).map((key) => [key, process.env[key]]));

  process.env.TALEMATE_HOME = home;
  process.env.TALEMATE_TODAY = options.clock;
  process.env.TALEMATE_REPLAY_FILE = replayFile;
  process.env.TALEMATE_REPLAY_USED = join(home, "used-keys.txt");
  // case 里钉死的参数优先：评测不能跟着 .env 漂，否则同一份 case 今天 high、明天 low，cassette 全 miss
  if (evalCase.model?.reasoning !== undefined) process.env.TALEMATE_REASONING = evalCase.model.reasoning;
  if (evalCase.model?.temperature !== undefined) process.env.TALEMATE_TEMPERATURE = String(evalCase.model.temperature);
  if (evalCase.model?.maxTokens !== undefined) process.env.TALEMATE_MAX_TOKENS = String(evalCase.model.maxTokens);
  for (const [key, value] of Object.entries(evalCase.env ?? {})) process.env[key] = value;
  if (options.record) process.env.TALEMATE_RECORD = "1";
  else delete process.env.TALEMATE_RECORD;

  let projectId = "";
  let sessionId = "";
  let error: string | undefined;
  let timedOut = false;
  const startedAt = Date.now();
  const snapshots: TurnSnapshot[] = [];

  try {
    const project = await createProject({ title: evalCase.id });
    projectId = project.id;
    const root = projectPaths(home, projectId).root;

    for (const [path, content] of Object.entries(fixtures)) {
      const abs = join(root, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }

    const model = loadModelConfig();
    if (options.record && model.provider === "mock") {
      throw new Error("录制模式不能用 mock provider；请配置真实模型（TALEMATE_PROVIDER / API key）");
    }
    if (options.record && !hasCredentials(model)) {
      throw new Error("录制模式缺少 API key；先配置 TALEMATE_API_KEY / ANTHROPIC_API_KEY");
    }

    const harness = variant === undefined ? undefined : buildHarness(variant);
    const session = await openSession({
      projectId,
      title: evalCase.id,
      model,
      ...(harness === undefined ? {} : { agents: harness.agents, tools: harness.tools }),
      ...(evalCase.answerer === true ? { io: EVAL_IO } : {}),
    });
    sessionId = session.sessionId;

    if (evalCase.prosePlanChapter !== undefined) {
      const plan: PendingProposal = {
        name: PLAN_KEY,
        content: evalCase.prosePlanContent ?? `# 第 ${evalCase.prosePlanChapter} 章规划\n`,
        chapter: evalCase.prosePlanChapter,
        approved: true,
        at: Date.now(),
      };
      session.pending.set(PLAN_KEY, plan);
    }
    // 先种规划再进模式：prose/draft 的 system 依赖当前章节的 plan
    if (evalCase.mode !== undefined) session.setMode(evalCase.mode);

    const prompts = [evalCase.brief, ...(evalCase.followUps ?? [])];
    if (prompts.length > evalCase.budget.maxTurns) {
      throw new Error(`case 有 ${prompts.length} 轮，超过 budget.maxTurns=${evalCase.budget.maxTurns}`);
    }

    for (const prompt of prompts) {
      try {
        await withTimeout(session.post(prompt), options.timeoutMs, () => session.abortCurrent());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("超时")) timedOut = true;
        error = message;
        break;
      }
      snapshots.push(await snapshot(projectId, sessionId));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (prevHome === undefined) delete process.env.TALEMATE_HOME;
    else process.env.TALEMATE_HOME = prevHome;
    if (prevToday === undefined) delete process.env.TALEMATE_TODAY;
    else process.env.TALEMATE_TODAY = prevToday;
    if (prevReplay === undefined) delete process.env.TALEMATE_REPLAY_FILE;
    else process.env.TALEMATE_REPLAY_FILE = prevReplay;
    if (prevRecord === undefined) delete process.env.TALEMATE_RECORD;
    else process.env.TALEMATE_RECORD = prevRecord;
    if (prevReasoning === undefined) delete process.env.TALEMATE_REASONING;
    else process.env.TALEMATE_REASONING = prevReasoning;
    if (prevTemperature === undefined) delete process.env.TALEMATE_TEMPERATURE;
    else process.env.TALEMATE_TEMPERATURE = prevTemperature;
    if (prevMaxTokens === undefined) delete process.env.TALEMATE_MAX_TOKENS;
    else process.env.TALEMATE_MAX_TOKENS = prevMaxTokens;
    if (prevUsed === undefined) delete process.env.TALEMATE_REPLAY_USED;
    else process.env.TALEMATE_REPLAY_USED = prevUsed;
    for (const [key, value] of prevEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const last = snapshots.at(-1);
  const checkResults = last === undefined || error !== undefined
    ? [{ id: "run", ok: false, detail: error ?? "没有产生任何一轮快照" }]
    : await runChecks(evalCase, snapshots, join(caseDir, "fixtures"));

  if (last !== undefined) {
    const steps = last.events.filter((event) => event.type === "step/start").length;
    if (steps > evalCase.budget.maxSteps) {
      checkResults.push({
        id: "budget:maxSteps",
        ok: false,
        detail: `${steps} 步，超过 budget.maxSteps=${evalCase.budget.maxSteps}`,
      });
    }
    const usage = last.events.reduce(
      (sum, event) =>
        event.type === "step/end" && event.data.usage !== undefined
          ? { input: sum.input + event.data.usage.input, output: sum.output + event.data.usage.output }
          : sum,
      { input: 0, output: 0 },
    );
    if (usage.input + usage.output > evalCase.budget.maxTokens) {
      checkResults.push({
        id: "budget:maxTokens",
        ok: false,
        detail: `${usage.input + usage.output} token，超过 budget.maxTokens=${evalCase.budget.maxTokens}`,
      });
    }
  }

  const verdict: RunResult["verdict"] = timedOut
    ? "timeout"
    : error !== undefined
      ? "error"
      : checkResults.every((result) => result.ok)
        ? "pass"
        : "fail";

  const usage = last?.events.reduce(
    (sum, event) =>
      event.type === "step/end" && event.data.usage !== undefined
        ? { input: sum.input + event.data.usage.input, output: sum.output + event.data.usage.output }
        : sum,
    { input: 0, output: 0 },
  ) ?? { input: 0, output: 0 };
  const steps = last?.events.filter((event) => event.type === "step/start").length ?? 0;
  const wallMs = Date.now() - startedAt;

  const result: RunResult = {
    runId,
    caseId: evalCase.id,
    family: evalCase.family,
    base: evalCase.base,
    ...(evalCase.rubric === undefined ? {} : { rubric: evalCase.rubric }),
    variantId,
    repeat,
    manifest: await manifestOf(
      evalCase,
      runId,
      replayFile,
      join(home, "used-keys.txt"),
      snapshots.at(-1)?.events ?? [],
      fixtures,
      options.clock,
    ),
    checks: checkResults,
    verdict,
    ...(verdict === "pass" ? {} : { failureBucket: failureBucketOf(checkResults, verdict) }),
    steps,
    usage,
    costYuan: 0,
    wallMs,
    tracePath: join("traces", runId),
  };

  // 现场留档：事件与改动索引是调查失败的第一手材料；trace 可 gitignore
  await mkdir(traceDir, { recursive: true });
  await writeFile(join(traceDir, "result.json"), JSON.stringify(result, null, 2), "utf-8");
  if (sessionId !== "") {
    const sp = sessionPaths(home, projectId, sessionId);
    await readFile(sp.events, "utf-8")
      .then((text) => writeFile(join(traceDir, "events.jsonl"), text, "utf-8"))
      .catch(() => {});
    await readFile(sp.changes, "utf-8")
      .then((text) => writeFile(join(traceDir, "changes.jsonl"), text, "utf-8"))
      .catch(() => {});
  }
  // 最后一轮的作品文件也留一份：prose case 的样本要靠它做人工评分，不能只留在临时 HOME 里
  if (last !== undefined) {
    for (const [path, content] of Object.entries(last.files)) {
      const abs = join(traceDir, "files", path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }
  }

  await rm(home, { recursive: true, force: true }).catch(() => {});
  resetEventLogs();
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const allCases = await loadCases(options.cases);
  const cases = options.includeUnstable ? allCases : allCases.filter((c) => c.unstable === undefined);
  const skipped = allCases.length - cases.length;
  if (skipped > 0) console.log(`跳过 ${skipped} 个 unstable case（--include-unstable 可跑）`);
  const variant = options.variant === undefined ? undefined : await loadVariant(options.variant);
  const variantId = variant?.id ?? "baseline";

  const results: RunResult[] = [];
  let spent = 0;
  for (const [index, evalCase] of cases.entries()) {
    const variants: { variant: Variant | undefined; id: string }[] = variant === undefined
      ? [{ variant: undefined, id: "baseline" }]
      : [
          { variant: undefined, id: "baseline" },
          { variant, id: variant.id },
        ];
    for (const entry of variants) {
      for (let repeat = 0; repeat < options.repeat; repeat++) {
        process.stdout.write(
          `[${index + 1}/${cases.length}] ${evalCase.id} ${entry.id === "baseline" ? "" : `${entry.id} `}r${repeat} … `,
        );
        const result = await runOnce(evalCase, repeat, options, entry.variant, entry.id);
        results.push(result);
        console.log(result.verdict);
        if (entry.id !== "baseline" && repeat === 0) spent += result.usage.input + result.usage.output;
        if (options.record && spent > options.maxTokens) {
          console.error(`\n✘ 录制 token 已超过上限 ${options.maxTokens}（约 ${spent}）。停止。`);
          break;
        }
      }
    }
    if (options.record && spent > options.maxTokens) break;
  }

  const reportPath = options.report === undefined
    ? join(REPO_ROOT, "reports", `${options.clock}-${variantId}.md`)
    : resolve(options.report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    variant === undefined
      ? renderBaselineReport(results, options.clock)
      : renderComparisonReport(results, options.clock, variant.id, variant.note),
    "utf-8",
  );

  const failed = results.filter((result) => result.verdict !== "pass");
  const broken = results.filter((result) => result.verdict === "error" || result.verdict === "timeout");
  const baselineFailed = failed.filter((result) => result.variantId === "baseline");
  const variantFailed = failed.filter((result) => result.variantId !== "baseline");

  console.log(`\n报告：${reportPath}`);
  if (variant === undefined) {
    if (failed.length > 0) {
      console.error(`✘ ${failed.length}/${results.length} 条 run 未通过`);
      process.exit(1);
    }
    console.log(`✔ ${results.length} 条 run 全部通过`);
  } else {
    // 变体失败是实验结果，不是命令失败；只有 baseline 坏/runtime 坏才非零退出
    if (baselineFailed.length > 0 || broken.length > 0) {
      console.error(`✘ baseline ${baselineFailed.length} 条未通过 · runtime ${broken.length} 条`);
      process.exit(1);
    }
    console.log(
      variantFailed.length === 0
        ? `✔ baseline 全过；${variant.id} 也没有判据差异（${results.length} 条 run）`
        : `✔ baseline 全过；${variant.id} 有 ${variantFailed.length} 条 run 判据失败（见报告，这是实验结果）`,
    );
  }
}

await main();
