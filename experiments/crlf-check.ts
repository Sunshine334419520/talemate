/**
 * 一次性对照：**那份文风纪律在不在上下文里，正文有多少差别**。
 *
 * 起因是一个 bug：`skills/prose/SKILL.md` 在 Windows 检出后是 CRLF，而 `parseSkillFile` 的正则
 * 写死了 `\n`，于是 frontmatter 解析失败 → 缺 name 抛错 → 被 scanDir 的 catch 吞掉 →
 * `discoverSkills` 返回空数组。结果是**文风纪律从来没被加载过**（`<available_skills>` 里连目录
 * 条目都没有）。修的是行尾归一，这个脚本量的是修之前和修之后。
 *
 * 两组**同材料、同模型、同提示词**，唯一变量是 B 组多一块正文写作窗口——就是 harness 现在
 * 注入 system 的那两层：**规范（跨文风恒定）+ 这本书的文风卡**。为省 token 只写开篇 500 字上下。
 *
 * 用法：bun run experiments/crlf-check.ts
 * 产物：experiments/output/crlf-check/{A-without,B-with}.md
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadModelConfig } from "../src/core/config";
import { chat } from "../src/llm/provider";
import { discoverSkills, loadSkillByName } from "../src/skill/discovery";
import { parseSkillFile } from "../src/skill/parse";
import { readPrompt } from "../src/prompts";

const CASE_ID = "case-01-huangdao-qiusheng";
const OUT = "experiments/output/crlf-check";

/** 按 `## <标题>` 取小节——只服务这个脚本，用例文件的形状变了就跟着改。 */
function section(text: string, heading: string): string {
  const chunks = text.split(/^## /m);
  const hit = chunks.slice(1).find((c) => c.startsWith(heading));
  return hit ? hit.slice(hit.indexOf("\n") + 1).trim() : "";
}

async function main(): Promise<void> {
  const model = loadModelConfig();
  if (!model.apiKey) throw new Error("未找到 API key（.env 里的 TALEMATE_API_KEY）");

  // 修复是否生效：目录里得能看见 prose，正文得能取到
  const skills = await discoverSkills(undefined);
  const prose = await loadSkillByName(undefined, "prose");
  console.log(`[查] discoverSkills 发现：${skills.map((s) => s.name).join(", ") || "（空）"}`);
  console.log(`[查] prose 正文可取：${prose ? `${prose.body.length} 字` : "取不到"}`);
  if (!prose) throw new Error("prose 取不到——CRLF 修复没生效，这个对照没有意义");

  const raw = await readFile(`experiments/cases/${CASE_ID}.md`, "utf-8");
  const ideaBook = section(raw, "企划书");
  const outline = section(raw, "前 3 章细纲");
  // 顺带验一下：CRLF 的 SKILL.md 解析出来和 LF 一致（这是被修的那个点）
  const crlfSame = parseSkillFile((await readFile("skills/prose/SKILL.md", "utf-8")), "prose").name === "prose";
  console.log(`[查] CRLF 的 SKILL.md 能解出 name：${crlfSame}\n`);

  const system = [
    "你是 talemate 的小说写手。根据材料写这一章的开篇正文。",
    "只输出正文本身：不要标题、章号、小节标题，不要解释或元信息。",
  ].join("\n");

  const user = [
    `【作品】都市荒岛求生`,
    `【企划书】\n${ideaBook}`,
    `【前 3 章细纲】\n${outline}`,
    `【本章任务】第 1 章开篇：${outline.match(/\*\*第\s*1\s*章\*\*[：:]\s*(.+)/)?.[1] ?? ""}`,
    `【输出要求】只写开篇 500 字左右，到第一个悬念出现为止。只输出正文。`,
  ].join("\n\n");

  const groups = [
    { tag: "A-without", label: "A组·无文风纪律（复现 bug 之前）", extra: "" },
    {
      tag: "B-with",
      label: "B组·有正文写作窗口（规范 + 文风卡）",
      extra: `【正文规范】（跨文风恒定）\n${readPrompt("prose.rules")}\n\n【这本书的文风】${prose.name}\n${prose.body}`,
    },
  ];

  await mkdir(OUT, { recursive: true });
  for (const g of groups) {
    const userText = g.extra ? `${user}\n\n${g.extra}` : user;
    console.log(`──── ${g.label} ────`);
    const t = Date.now();
    const r = await chat({ model, system, messages: [{ role: "user", text: userText }] });
    const ms = Date.now() - t;
    await writeFile(`${OUT}/${g.tag}.md`, r.text, "utf-8");
    console.log(r.text.trim());
    console.log(`\n[${Math.round(ms / 1000)}s · ${r.text.length} 字 → ${OUT}/${g.tag}.md]\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
