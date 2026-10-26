/**
 * 文风排查 C/D：只测“产品静态 system”对同一场景的影响，不带工具和历史。
 *
 * C = 产品 system + 第一章计划
 * D = 产品 system（去掉第一章专属的 pending 计划）+ 退婚局用例
 *
 * 这样 C/D 与 A/B 的差别只剩 system 文本；工具/历史另开实验。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chat } from "../../src/llm/provider";
import { hasCredentials, loadModelConfig } from "../../src/core/config";
import { projectPaths, talemateHome } from "../../src/core/config";
import { formatProse } from "../../src/framework/format_prose";
import type { ToolSchema } from "../../src/llm/types";

const ROOT = resolve(import.meta.dir, "../..");
const CASE_06 = join(ROOT, "experiments/style-bench/cases/06-guyan.md");
const CASE_07 = join(ROOT, "experiments/style-bench/cases/07-chapter1.md");
const PRODUCT_SYSTEM = join(import.meta.dir, "prompts/chapter1-system.txt");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function withoutPendingPlan(system: string): string {
  return system.replace(/<pending-proposal>[\s\S]*?<\/pending-proposal>\n?/g, "").trimEnd();
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(arg("--out") ?? join(import.meta.dir, "outputs", stamp));
  const product = await readFile(PRODUCT_SYSTEM, "utf-8");
  const proseSystem = await readFile(join(ROOT, "prompts/prose.system.txt"), "utf-8");
  const bench = await readFile(join(import.meta.dir, "prompts/bench-guyan-system.txt"), "utf-8");
  const case06 = await readFile(CASE_06, "utf-8");
  const case07 = await readFile(CASE_07, "utf-8");
  const case08 = await readFile(join(ROOT, "experiments/style-bench/cases/08-chapter1-revised.md"), "utf-8");
  const case09 = await readFile(join(ROOT, "experiments/style-bench/cases/09-chapter1-brief.md"), "utf-8");
  const case10 = await readFile(join(ROOT, "experiments/style-bench/cases/10-chapter1-planner-brief.md"), "utf-8");

  const noTone = product.replace(
    "- Output goes to a command line. Write in Chinese, plainly and directly.",
    "When talking to the user, write in Chinese, plainly and directly; this is the chat register, not the prose register. Novel prose is governed by the prose window.",
  );
  const voice = [
    "【声口优先级】",
    "这是小说正文，不是聊天回复。以下优先于计划里压制声音的措辞（例如“不给爽感/只给看清”）：",
    "- 叙述者始终在场，有判断、有态度，不是冷冰冰的镜头。",
    "- 以中长句为主；不要把每个动作切成单独一句。",
    "- 即使场景安静，也要写出在场的人想要什么、在挡什么；心理要落在人与人的关系上。",
  ].join("\n");
  const c2System = product.replace(
    '<prose-window chapter="1">\n',
    `<prose-window chapter="1">\n${voice}\n\n`,
  );
  const c3System = c2System.replace(
    /【常驻设定 · design\/core\.md】[\s\S]*?(?=Skills provide specialized instructions)/,
    "",
  );
  const proseExperiment = proseSystem
    .replace(
      "The user has already approved the chapter plan; it is in <pending-proposal> and the plan artifact.",
      "The user has already approved the chapter plan; all of its prerequisites are already landed. Write the chapter now.",
    )
    .replace(
      "- Follow the approved plan's 产物（按序）. If it names a character card or a world page that does not exist yet, create it with propose-design first and stop for the user's review. Do not write prose around a missing prerequisite.\n",
      "- Do not create cards or world pages; they are already landed. Write the chapter now.\n",
    );
  const c4System = c2System
    .replace(
      /You are talemate's writing partner\.[\s\S]*?(?=【常驻设定 · design\/core\.md】)/,
      `${proseExperiment}\n\n`,
    )
    .replace(/<pending-proposal>[\s\S]*?<\/pending-proposal>\n?/g, "");
  const writeTool: ToolSchema = {
    name: "write",
    description: "Write a file. Use it for the chapter prose.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative path" },
        content: { type: "string", description: "The file content" },
      },
      required: ["path", "content"],
    },
  };
  type Variant = { id: string; system: string; user: string; tools?: ToolSchema[] };
  // C9a：prose mode + brief，不加载 core/world/角色。
  const c9NoContext = c4System.replace(
    /【常驻设定 · design\/core\.md】[\s\S]*?(?=Skills provide specialized instructions)/,
    "",
  );
  // C9b：在 C9a 之外，把角色卡、wiki 专题页、卷纲/序列纲都加载进来。
  const projectRoot = projectPaths(talemateHome(), "novel-a556").root;
  const contextRels: string[] = [];
  for (const dir of ["design/characters", "design/wiki"]) {
    try {
      for (const file of (await readdir(join(projectRoot, dir))).filter((f) => f.endsWith(".md")).sort()) {
        contextRels.push(`${dir}/${file}`);
      }
    } catch {
      // 目录不存在就跳过
    }
  }
  contextRels.push("design/outline/vol_1.md", "design/outline/vol_1/s1.md");
  const contextBlocks: string[] = [];
  for (const rel of contextRels) {
    try {
      const text = (await readFile(join(projectRoot, rel), "utf-8")).trim();
      if (text) contextBlocks.push(`【${rel}】\n${text}`);
    } catch {
      // 缺文件就跳过
    }
  }
  const c9Context = `${c9NoContext}\n\n${contextBlocks.join("\n\n")}`;

  const variants: Variant[] = [
    { id: "C10a-prose-planner-brief", system: c9NoContext, user: case10, tools: [writeTool] },
    { id: "C10b-prose-planner-brief-context", system: c9Context, user: case10, tools: [writeTool] },
    { id: "C9a-prose-brief", system: c9NoContext, user: case09, tools: [writeTool] },
    { id: "C9b-prose-brief-context", system: c9Context, user: case09, tools: [writeTool] },
    { id: "B3-bench-chapter1-revised", system: `${bench}\n\n${voice}`, user: case08 },
    { id: "C6-prose-mode-guyan", system: c4System, user: case06, tools: [writeTool] },
    { id: "C5-prose-mode-chapter1-revised", system: c4System, user: case08, tools: [writeTool] },
    { id: "C4-prose-system-chapter1", system: c4System, user: case07, tools: [writeTool] },
    { id: "B2-bench-chapter1-voice", system: `${bench}\n\n${voice}`, user: case07 },
    { id: "C2-product-chapter1-voice", system: c2System, user: case07 },
    { id: "C3-product-chapter1-voice-no-resident", system: c3System, user: case07 },
    { id: "C-product-chapter1", system: product, user: case07 },
    { id: "C1-product-chapter1-no-tone", system: noTone, user: case07 },
    { id: "D-product-guyan", system: withoutPendingPlan(product), user: case06 },
  ].filter((v) => arg("--only") === undefined || v.id === arg("--only"));

  const model = { ...loadModelConfig(), temperature: 0.8, maxTokens: Math.max(loadModelConfig().maxTokens, 8000) };
  if (!dryRun && !hasCredentials(model)) throw new Error("没有可用凭据");

  await mkdir(outDir, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    model: { provider: model.provider, model: model.model, temperature: model.temperature },
    variants: variants.map((v) => ({ id: v.id, systemChars: v.system.length, userChars: v.user.length })),
    files: [] as string[],
  };

  for (const v of variants) {
    const dir = join(outDir, v.id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "output.md");
    const promptFile = join(dir, "prompt.txt");
    await writeFile(promptFile, `${v.system}\n\n---\n\n${v.user}`, "utf-8");
    if (dryRun) {
      console.log(`[dry] ${v.id} → ${promptFile}`);
      continue;
    }
    console.log(`[run] ${v.id}`);
    const result = await chat({
      model,
      system: v.system,
      messages: [{ role: "user", text: v.user }],
      ...(v.tools === undefined ? {} : { tools: v.tools }),
    });
    const writeCall = result.toolCalls.find((c) => c.name === "write");
    const raw = writeCall?.input.content;
    const text = formatProse(typeof raw === "string" ? raw.trim() : result.text.trim());
    if (!text) throw new Error(`空输出：${v.id}`);
    await writeFile(file, text, "utf-8");
    manifest.files.push(file);
    console.log(`[done] ${v.id} → ${file}`);
  }

  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  console.log(`输出：${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
