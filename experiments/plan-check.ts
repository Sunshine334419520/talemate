/**
 * 一次性对照：**规划者会不会真的写出「放大点」**。
 *
 * 起因：`planner.system.txt` / `propose-plan.txt` 里原来只有一句很软的 `where the pace has to hold`，
 * 那格「放大点」（哪里慢镜头几百字、哪里半句带过）在迁移时丢了。补上之后要验的不是
 * "提示词里有这行字"，而是**模型交出来的规划里有没有这一步**——提示词改了而产出没变，
 * 等于没改。
 *
 * 直接喂 planner persona（不接工具，材料一次给全），产物落 experiments/output/plan-check/。
 *
 * 用法：bun run experiments/plan-check.ts
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadModelConfig } from "../src/core/config";
import { chat } from "../src/llm/provider";
import { readPrompt } from "../src/prompts";

const CASE_ID = "case-01-huangdao-qiusheng";
const OUT = "experiments/output/plan-check";

function section(text: string, heading: string): string {
  const chunks = text.split(/^## /m);
  const hit = chunks.slice(1).find((c) => c.startsWith(heading));
  return hit ? hit.slice(hit.indexOf("\n") + 1).trim() : "";
}

async function main(): Promise<void> {
  const model = loadModelConfig();
  if (!model.apiKey) throw new Error("未找到 API key（.env 里的 TALEMATE_API_KEY）");

  const raw = await readFile(`experiments/cases/${CASE_ID}.md`, "utf-8");
  const brief = raw.match(/\*\*第\s*1\s*章\*\*[：:]\s*(.+)/)?.[1] ?? "";

  const system = readPrompt("planner.system");
  const user = [
    `【本章意图】写第 1 章。${brief}`,
    `【手上已有的材料】`,
    `企划书：\n${section(raw, "企划书")}`,
    `前 3 章细纲：\n${section(raw, "前 3 章细纲")}`,
    "当前状态：state/ 还是空的，这是第 1 章；核心设定 / 世界观 / 角色卡也都还没落成文件。",
  ].join("\n\n");

  console.log(`[跑] planner persona · ${model.model}\n`);
  const t = Date.now();
  const r = await chat({ model, system, messages: [{ role: "user", text: user }] });
  const plan = r.text.trim();

  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/ch_1.md`, plan, "utf-8");
  console.log(plan);

  const checks: [string, boolean][] = [
    ["产出里有「放大点」这一格", plan.includes("放大点")],
    ["每一步都有（出现次数 ≥ 步数）", (plan.match(/放大点/g) ?? []).length >= 2],
    ["说的是具体那一刻，不是原则", /慢镜头|几百字|一句带过|半句带过|逐字|跟着写/.test(plan)],
  ];
  console.log("");
  for (const [what, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${what}`);
  console.log(`\n[${Math.round((Date.now() - t) / 1000)}s · ${plan.length} 字 → ${OUT}/ch_1.md]`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
