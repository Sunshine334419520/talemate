/**
 * 文风测试台：固定用例、固定模型、固定提示，只换“写作底线”与“文风卡”，生成一组匿名样本，
 * 由人来盲评。它不是 `bun test`——要调真实模型、花 token、带随机性，只用于开发和调参。
 *
 * 规则有三种取法：
 *   literary —— `rules/literary.txt`，重构前那份文学向 prose.rules 的冻结副本，用来做“之前”的基线；
 *   base     —— `rules/relaxed.txt`，重构后的六条基础条款；
 *   none     —— 不给底线。
 * 只换文风卡的话，旧规则会在底下把它拽回去；这个测试台要能看出瓶颈到底在卡上还是在规则上。
 *
 * 用法：
 *   bun run experiments/style-bench/run.ts --dry-run
 *   bun run experiments/style-bench/run.ts --case 01-opening --samples 1
 *   bun run experiments/style-bench/run.ts --config wangwen-short-base --case 01-opening
 *
 * 输出：outputs/<时间戳>/<配置>/<用例>--s<序号>.md；另有一份 blind/（随机标签）与 key.json。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chat } from "../../src/llm/provider";
import { hasCredentials, loadModelConfig } from "../../src/core/config";
import { formatProse } from "../../src/framework/format_prose";
import { parseSkillFile } from "../../src/skill/parse";

type RulesMode = "literary" | "base" | "none";

interface BenchConfig {
  id: string;
  note: string;
  rules: RulesMode;
  /** 文风卡：`skills/<name>`、`cards/<file>.md`，或省略（不注入文风卡） */
  style?: string;
  /** 追加哪份声音范例：wangwen = 短促网文 */
  excerpts?: "wangwen" | "storytelling";
}

interface BenchCase {
  id: string;
  title: string;
  prompt: string;
}

const CONFIGS: BenchConfig[] = [
  { id: "baseline-literary", note: "旧文学向规则，不给文风卡", rules: "literary" },
  {
    id: "wangwen-long-literary",
    note: "旧文学向规则 + 现有网文长卡",
    rules: "literary",
    style: "style-01-wangwen",
  },
  { id: "baseline-base", note: "六条基础条款，不给文风卡", rules: "base" },
  {
    id: "wangwen-long-base",
    note: "六条基础条款 + 现有网文长卡",
    rules: "base",
    style: "style-01-wangwen",
  },
  {
    id: "wangwen-short-base",
    note: "六条基础条款 + 新短卡 + 范例",
    rules: "base",
    style: "cards/wangwen-short.md",
    excerpts: "wangwen",
  },
  {
    id: "wangwen-short-base-noex",
    note: "六条基础条款 + 新短卡，不给范例",
    rules: "base",
    style: "cards/wangwen-short.md",
  },
  {
    id: "storytelling-v1-base",
    note: "六条基础条款 + 讲述体卡 v1 + 讲述体范例（对照）",
    rules: "base",
    style: "cards/storytelling-v1.md",
    excerpts: "storytelling",
  },
  {
    id: "storytelling-base",
    note: "六条基础条款 + 讲述体卡 v2 + 讲述体范例",
    rules: "base",
    style: "storytelling",
    excerpts: "storytelling",
  },
  {
    id: "storytelling-base-noex",
    note: "六条基础条款 + 讲述体卡 v2，不给范例",
    rules: "base",
    style: "storytelling",
  },
  {
    id: "storytelling-none",
    note: "不给规则 + 讲述体卡 v2 + 讲述体范例",
    rules: "none",
    style: "storytelling",
    excerpts: "storytelling",
  },
  {
    id: "wangwen-short-none",
    note: "不给规则 + 新短卡 + 范例",
    rules: "none",
    style: "cards/wangwen-short.md",
    excerpts: "wangwen",
  },
  {
    id: "guyan-base",
    note: "六条基础条款 + 女频古言卡",
    rules: "base",
    style: "style-02-guyan",
  },
  { id: "excerpts-only", note: "不给规则、不给卡，只给短促网文范例", rules: "none", excerpts: "wangwen" },
];

const ROOT = resolve(import.meta.dir, "../..");

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** `--case a,b` 或重复写 `--case a --case b`。 */
function argList(name: string): string[] | undefined {
  const values: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg === name && process.argv[i + 1]) values.push(...process.argv[i + 1].split(",").map((s) => s.trim()));
  });
  return values.length ? values : undefined;
}

function selected<T extends { id: string }>(items: T[], wants: string[] | undefined): T[] {
  if (!wants) return items;
  const hit = items.filter((x) => wants.some((w) => x.id === w || x.id.startsWith(`${w}--`)));
  if (!hit.length) {
    throw new Error(`没有这些 id：${wants.join(" / ")}（可选：${items.map((x) => x.id).join(" / ")}）`);
  }
  return hit;
}

async function loadCases(): Promise<BenchCase[]> {
  const dir = join(import.meta.dir, "cases");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const out: BenchCase[] = [];
  for (const file of files) {
    const raw = (await readFile(join(dir, file), "utf-8")).trim();
    const lines = raw.split("\n");
    const title = lines[0]?.replace(/^#+\s*/, "") ?? file;
    // 用例标题只给测试台自己看；别让模型把它当成正文标题照抄
    const prompt = lines[0]?.startsWith("#") ? lines.slice(1).join("\n").trim() : raw;
    out.push({ id: file.replace(/\.md$/, ""), title, prompt });
  }
  if (!out.length) throw new Error("cases/ 里没有用例");
  return out;
}

async function loadStyleCard(spec: string): Promise<{ name: string; body: string }> {
  const candidates = spec.includes("/") || spec.endsWith(".md")
    ? [resolve(ROOT, spec), resolve(import.meta.dir, spec)]
    : [resolve(ROOT, "skills", spec, "SKILL.md"), resolve(import.meta.dir, "cards", `${spec}.md`)];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf-8");
      if (raw.startsWith("---")) {
        const skill = parseSkillFile(raw, path);
        return { name: skill.title ?? skill.name, body: skill.body };
      }
      const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
      return { name: title ?? spec.replace(/\.md$/, ""), body: raw.trim() };
    } catch {
      // 下一个候选
    }
  }
  throw new Error(`找不到文风卡：${spec}`);
}

async function loadRules(mode: RulesMode): Promise<string> {
  if (mode === "none") return "";
  if (mode === "literary") {
    return (await readFile(join(import.meta.dir, "rules/literary.txt"), "utf-8")).trim();
  }
  return (await readFile(join(import.meta.dir, "rules/relaxed.txt"), "utf-8")).trim();
}

function buildSystem(opts: { rules: string; styleBody?: string; styleName?: string; excerpts?: string }): string {
  const parts = [
    "你在写中文网络小说的正文。只输出正文，不要标题、提纲、说明、评价、前言后语。",
    "写完后不要总结，不要解释你用了什么风格。",
  ];
  if (opts.rules) parts.push("", "【写作底线】", opts.rules);
  if (opts.styleBody) parts.push("", `【文风：${opts.styleName ?? "指定声口"}】`, opts.styleBody);
  if (opts.excerpts) {
    parts.push("", "【声音范例：模仿节奏与措辞，不要抄内容，也不要沿用范例里的人名】", opts.excerpts);
  }
  return parts.join("\n");
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const cases = selected(await loadCases(), argList("--case"));
  const configs = selected(CONFIGS, argList("--config"));
  const samples = Math.max(1, Number(argValue("--samples") ?? 1));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(argValue("--out") ?? join(import.meta.dir, "outputs", stamp));
  const excerptTexts = {
    wangwen: (await readFile(join(import.meta.dir, "references/wangwen-excerpts.md"), "utf-8")).trim(),
    storytelling: (
      await readFile(join(import.meta.dir, "references/storytelling-excerpts.md"), "utf-8")
    ).trim(),
  };

  const model = loadModelConfig();
  if (!dryRun && !hasCredentials(model)) {
    throw new Error(
      "没有可用凭据。先在 .env 里配 TALEMATE_PROVIDER / TALEMATE_API_KEY / TALEMATE_MODEL，或先跑 --dry-run 看提示。",
    );
  }
  const temperature = Number(process.env.TALEMATE_TEMPERATURE ?? 0.8);
  const benchModel = { ...model, temperature, maxTokens: Math.max(model.maxTokens, 8000) };

  await ensureDir(outDir);
  const manifest = {
    createdAt: new Date().toISOString(),
    model: { provider: benchModel.provider, model: benchModel.model, temperature },
    configs: configs.map((c) => ({
      id: c.id,
      note: c.note,
      rules: c.rules,
      style: c.style ?? null,
      excerpts: c.excerpts ?? null,
    })),
    cases: cases.map((c) => c.id),
    samples,
    dryRun,
    files: [] as string[],
  };

  for (const config of configs) {
    const rules = await loadRules(config.rules);
    const card = config.style ? await loadStyleCard(config.style) : undefined;
    const system = buildSystem({
      rules,
      styleBody: card?.body,
      styleName: card?.name,
      excerpts: config.excerpts ? excerptTexts[config.excerpts] : undefined,
    });

    for (const testCase of cases) {
      for (let sample = 1; sample <= samples; sample++) {
        const fileName = `${testCase.id}--s${sample}.md`;
        const dir = join(outDir, dryRun ? "prompts" : config.id);
        await ensureDir(dir);
        const file = join(dir, dryRun ? `${config.id}--${fileName}` : fileName);
        const user = testCase.prompt;
        const fullPrompt = `${system}\n\n---\n\n${user}`;

        if (dryRun) {
          await writeFile(file, fullPrompt, "utf-8");
          manifest.files.push(file);
          console.log(`[dry] ${config.id} · ${testCase.id} · s${sample} → ${file}`);
          continue;
        }

        console.log(`[run] ${config.id} · ${testCase.id} · s${sample}`);
        const result = await chat({
          model: benchModel,
          system,
          messages: [{ role: "user", text: user }],
        });
        const text = formatProse(result.text.trim());
        if (!text) throw new Error(`空输出：${config.id} / ${testCase.id} / s${sample}`);
        await writeFile(file, text, "utf-8");
        manifest.files.push(file);
      }
    }
  }

  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  if (!dryRun) {
    // 匿名副本：每个用例内随机打乱标签，比较时看不到配置名
    const key: Record<string, { config: string; case: string; sample: number; file: string }> = {};
    for (const testCase of cases) {
      const rows = manifest.files
        .filter((f) => f.includes(`/${testCase.id}--`))
        .map((f) => ({
          file: f,
          config: f.split("/").slice(-2)[0] ?? "",
          case: testCase.id,
          sample: Number(f.match(/--s(\d+)\.md$/)?.[1] ?? 1),
        }));
      for (let i = rows.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rows[i], rows[j]] = [rows[j], rows[i]];
      }
      const blindDir = join(outDir, "blind", testCase.id);
      await ensureDir(blindDir);
      for (let i = 0; i < rows.length; i++) {
        const label = String.fromCharCode(65 + i);
        const source = rows[i];
        const text = await readFile(source.file, "utf-8");
        await writeFile(join(blindDir, `${label}.md`), text, "utf-8");
        key[label] = { config: source.config, case: source.case, sample: source.sample, file: source.file };
      }
    }
    await writeFile(join(outDir, "key.json"), `${JSON.stringify(key, null, 2)}\n`, "utf-8");
    await writeFile(
      join(outDir, "compare.md"),
      [
        "# 盲评",
        "",
        "同目录下的 `blind/<用例>/` 是匿名样本，`key.json` 是映射（先别看）。",
        "评分见 `experiments/style-bench/rubric.md`；每项 1–5，先读三遍再打分。",
        "",
        cases.map((c) => `- ${c.id}：${c.title}`).join("\n"),
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  console.log(`\n输出：${outDir}`);
  if (dryRun) console.log("这是 dry-run，没有调用模型。检查 prompts/ 里的拼装结果。");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
