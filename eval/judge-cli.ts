/**
 * judge 命令：对一份或多份正文按 rubric 打分；也可读 calibration.jsonl 做校准。
 *
 * 打分是真实模型调用，不进 `bun test`。没有人工分时只打印"未校准"，不冒充 κ。
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelConfig } from "../src/core/config";
import { judgeSample, meanAbsoluteError, publicModel, quadraticWeightedKappa, type JudgeScore } from "./judge";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(EVAL_ROOT, "..");

interface Args {
  samples: string[];
  rubric: string;
  out?: string;
  calibration?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { samples: [], rubric: "prose-chapter-basic" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} 缺少值`);
      return value;
    };
    switch (flag) {
      case "--sample":
        args.samples.push(next());
        break;
      case "--rubric":
        args.rubric = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--calibration":
        args.calibration = next();
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }
  return args;
}

interface CalibrationRow {
  id: string;
  sample: string;
  human: number | null;
}

async function readCalibration(path: string): Promise<CalibrationRow[]> {
  const text = await readFile(resolve(path), "utf-8");
  const rows: CalibrationRow[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`calibration 第 ${index + 1} 行不是 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof value !== "object" || value === null) throw new Error(`calibration 第 ${index + 1} 行不是对象`);
    const row = value as Partial<CalibrationRow>;
    if (typeof row.id !== "string" || typeof row.sample !== "string") {
      throw new Error(`calibration 第 ${index + 1} 行需要 id / sample`);
    }
    const human = typeof row.human === "number" ? row.human : null;
    rows.push({ id: row.id, sample: row.sample, human });
  }
  return rows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rubric = await readFile(join(EVAL_ROOT, "rubric", `${args.rubric}.md`), "utf-8");
  const model = { ...loadModelConfig(), reasoning: "high" as const, maxTokens: 8192 };

  const rows = args.calibration === undefined
    ? await Promise.all(
        args.samples.map(async (sample) => ({
          id: sample,
          sample,
          human: null as number | null,
        })),
      )
    : await readCalibration(args.calibration);

  if (rows.length === 0) throw new Error("没有样本：用 --sample 或 --calibration");

  const results: { id: string; sample: string; human: number | null; score: JudgeScore }[] = [];
  for (const row of rows) {
    const text = await readFile(resolve(row.sample), "utf-8");
    const score = await judgeSample({ sample: text, rubric, model });
    results.push({ ...row, score });
    console.log(`${row.id}  ${score.total}  ${JSON.stringify(score.dimensions)}  ${score.reason}`);
  }

  const labeled = results.filter((row): row is typeof row & { human: number } => typeof row.human === "number");
  if (labeled.length > 0) {
    const human = labeled.map((row) => row.human);
    const judge = labeled.map((row) => row.score.total);
    console.log(
      `\n校准：n=${labeled.length} · κ(quadratic)=${quadraticWeightedKappa(human, judge)} · MAE=${meanAbsoluteError(human, judge)}`,
    );
    if (labeled.length < 5) console.log("样本 < 5，κ 只能当方向看，不能当结论。");
  } else {
    console.log("\n校准：没有人工分（human 全为 null），本次只产出 judge 分。");
  }

  const out = resolve(args.out ?? join(REPO_ROOT, "reports", `judge-${new Date().toISOString().slice(0, 10)}.json`));
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ rubric: args.rubric, model: publicModel(model), results }, null, 2)}\n`, "utf-8");
  console.log(`\n写到：${out}`);
}

await main();
