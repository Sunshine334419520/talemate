/**
 * 探针 · 材料用完之后，它会不会自己开新的一层。
 *
 * 打真实模型做**单变量消融**：同一段 pitch、同样的回话，一次只改一处，看行为变没变。
 * **不是单元测试、不进 `bun test`**（随机、要花 token）；结论看率，不看单次。
 *
 * ## 驱动
 *
 * 只在真有提案待批时才回「没问题」。正常流程恰好 3 个 post（pitch → 批 core → 批 world），
 * 第三个 post 里就能看到它下一步想干什么。
 *
 * ## 判定（只认硬证据，不读文本）
 *
 * 窗口 = **最后一次落盘之后**（哪一轮 `design/` 多了层文件，以真落盘为准，不猜）。
 *   advanced = 从那一轮起对角色层动手了：`design-spec(characters)` / 任何写 `characters/` 的工具
 *   stopped  = 落完盘没对角色层动手（把球交回用户）
 *   diverged = 一层都没落上盘（场景没复现，先查探针而不是查产品）
 *
 * ## 用法
 *
 *   bun run probe --check                      # 只校验每个变体的替换串命中，不调模型（花 token 前先跑这个）
 *   bun run probe                              # 全部变体 × 3 次
 *   bun run probe baseline all-off             # 只跑指定变体
 *   TALEMATE_PROBE_RUNS=1 bun run probe        # 每个变体跑几次
 *
 * 产物：`experiments/output/probe/<variant>-<run>/`（含该次完整 TALEMATE_HOME，可读 messages.jsonl
 * 看它的思考）+ 同目录 `report-<时间>.md`（含逐轮轨迹）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentRegistry, DEFAULT_AGENTS } from "../agent/registry";
import { loadModelConfig } from "../core/config";
import type { AgentDef, LLMEvent, ModelConfig } from "../core/types";
import { BUILTIN_TOOLS } from "../tool";
import { ToolRegistry } from "../tool/registry";
import { Session, type UserIO } from "../session/session";
import { createProject, listDesigns, loadProjectMeta } from "../storage/project";

// ─────────────────────────── 被测场景 ───────────────────────────

/** 与手工实测用的是同一段 pitch。 */
const PITCH =
  "我想写一个主角在武汉老城区接手一家濒临倒闭的旧书店，整理旧书时发现每本二手书的空白扉页，" +
  "都写着一行只有他能看见的\"未完成遗言\"。这些遗言对应的人，全是近几年在本地被定性为\"意外死亡\"的逝者。" +
  "他顺着遗言线索拼凑真相，却慢慢发现，自己十年前那场被遗忘的车祸，才是所有死亡事件的共同起点。";

/** 只在真有提案待批时才说这句（见文件头「怎么驱动」）。 */
const APPROVE = "没问题";
/** 最多几个 post（正常流程是 3）。 */
const MAX_TURNS = 4;

// ─────────────────────────── 变体（单变量消融） ───────────────────────────

type Patch =
  | { kind: "persona"; note: string; before: string; after: string }
  | { kind: "describe"; tool: string; note: string; before: string; after: string }
  | { kind: "dropTools"; note: string; names: string[] }
  /**
   * 给某工具的结果追加一句（**加**上去测，不是删）。
   *
   * 消融法测不出"缺失型病因"（删不掉不存在的东西），只能把它加进去看行为变不变。
   */
  | { kind: "appendResult"; tool: string; note: string; text: string };

interface Variant {
  id: string;
  note: string;
  patches: Patch[];
}

/**
 * 变体只做"减"与"加"两种：改 persona / 改工具描述 / 去工具 / 往工具结果追加一句。
 * 已进产品的规则不再做"加上它"的变体——baseline 里已经有它了。
 */

/** design-spec 描述里「一段想法讨论通常碰到核心设定与世界观」——可能是「两层一起做」的暗示源。 */
const P_DESIGNSPEC_PAIR: Patch = {
  kind: "describe",
  tool: "design-spec",
  note: "design-spec.txt：去掉「一段想法讨论通常碰到核心设定与世界观」",
  before:
    "A story-idea discussion usually touches 核心设定\nand 世界观; a design pass usually touches one layer. ",
  after: "",
};

/**
 * 曾经的 `P_ADDCHAR_FIELDS`（把 add-character 描述里的两层格枚举抹掉，看行为变不变）已随
 * `add-character` 本身一起删除（2026-09-19）——那个 patch 的替换目标不复存在，留着会让
 * `--check` 直接抛。角色层现在的写入靠 `propose-design`，它的描述不列格。
 */

/**
 * 曾经的 `P_NO_CHAR_TOOLS`（把 `remove-character` 从白名单去掉，看角色层动不动）**已随那一系列工具
 * 一起删除**：`add/update-character` 2026-09-19 删，`remove-character` 2026-09-23 删——删一份文档
 * 现在就是通用的 `delete`，**再也没有"角色专用工具"这个东西**，那个变体没有靶子了。
 *
 * 留着的话 `--check` 抓不到（它只校验描述替换串命不命中，**不校验 `dropTools` 的名字**），
 * 变体会静默退化成 baseline。所以这里删掉而不是改个名。
 *
 * 同理 `all-off`（原本是"这几个全关"）也随之退化成与 `designspec-no-pair` 重复，一并删除。
 * **该补什么变体是这个实验的设计决定，不由代码单方面决定**——见 `docs/roadmap.md`。
 */

/**
 * **加上**一个交回契约（而不是删掉什么）：落盘的结果里写明"这一层到此为止"。
 * 这是唯一能证伪"缺失型病因"的手段——如果加了它行为就变，说明病在"没东西让它交回"。
 */
const P_APPLY_HANDBACK: Patch = {
  kind: "appendResult",
  tool: "apply-design",
  note: "apply-design 结果里补上「这一层到此为止」的交回契约",
  text: "\n（这一层到此为止——把球交回用户：说一句这层落好了，其余几层等他点名。）",
};

const VARIANTS: Variant[] = [
  { id: "baseline", note: "原样 = 当前产品（persona 那条规则已在里面，所以它就是新基线）", patches: [] },
  { id: "apply-handback", note: "【加】落盘结果里补交回契约", patches: [P_APPLY_HANDBACK] },
  { id: "designspec-no-pair", note: "去掉「核心设定与世界观」那句暗示", patches: [P_DESIGNSPEC_PAIR] },
];

// ─────────────────────────── 消融的落地 ───────────────────────────

/**
 * 替换必须命中：没命中说明原文变了、变体会静默退化成 baseline，整场实验就成了假的。
 *
 * 行尾容忍：patch 的字面量按 `\n` 写（git 里存的就是 LF），但检出到工作区可能是 CRLF
 * （本机 `core.autocrlf=true`）。不认这一层，整场 probe 会因为行尾而在第一处就抛。
 */
function mustReplace(text: string, before: string, after: string, what: string): string {
  for (const [b, a] of [
    [before, after],
    [before.replace(/\n/g, "\r\n"), after.replace(/\n/g, "\r\n")],
  ]) {
    if (text.includes(b)) return text.replace(b, a);
  }
  throw new Error(`变体没生效（找不到要替换的原文）：${what}\n原文片段：${JSON.stringify(before.slice(0, 80))}`);
}

/** 按变体造出这次要用的 agents / tools（不改仓库里的任何文件）。 */
function buildHarness(variant: Variant): { agents: AgentRegistry; tools: ToolRegistry } {
  const patched = BUILTIN_TOOLS.map((t) => {
    let description = t.description;
    for (const p of variant.patches) {
      if (p.kind === "describe" && p.tool === t.id) {
        description = mustReplace(description, p.before, p.after, `${variant.id}/${p.tool}: ${p.note}`);
      }
    }
    return { ...t, description };
  });
  const dropped = new Set(variant.patches.flatMap((p) => (p.kind === "dropTools" ? p.names : [])));
  const appended = new Map<string, string[]>();
  for (const p of variant.patches) {
    if (p.kind === "appendResult") appended.set(p.tool, [...(appended.get(p.tool) ?? []), p.text]);
  }
  const tools = new ToolRegistry();
  for (const t of patched) {
    if (dropped.has(t.id)) continue;
    const extra = appended.get(t.id);
    if (!extra) {
      tools.register(t);
      continue;
    }
    const orig = t.execute.bind(t);
    tools.register({
      ...t,
      execute: async (args, ctx) => {
        const r = await orig(args, ctx);
        return { ...r, output: r.output + extra.join("") };
      },
    });
  }

  const mate = DEFAULT_AGENTS.find((a) => a.id === "mate")!;
  let system = mate.system;
  for (const p of variant.patches) {
    if (p.kind === "persona") system = mustReplace(system, p.before, p.after, `${variant.id}/persona: ${p.note}`);
  }
  const patchedMate: AgentDef = { ...mate, system, tools: mate.tools.filter((id) => !dropped.has(id)) };
  const agents = new AgentRegistry(DEFAULT_AGENTS.map((a) => (a.id === "mate" ? patchedMate : a)));
  return { agents, tools };
}

// ─────────────────────────── 一次运行 ───────────────────────────

interface TurnLog {
  tools: { name: string; input: string }[];
  reasoning: string;
  text: string;
  /** 这一轮里 design/ 多了文件（= 这一轮真的落盘了一层） */
  landedHere: boolean;
}

/**
 * 判定只认硬证据：最后一次落盘之后，有没有对角色层动手。
 * 正文不进定类——列菜单（交回）与推荐某层（已替你决定）的正文都含"角色"二字，关键词分不开；
 * 正文照原样打进报告供人眼复核。
 * 窗口取"最后一次落盘之后"：有些改法会让它在核心层落盘后就交回，世界层压根不做，那也是正确行为。
 */
type Verdict = "advanced" | "stopped" | "diverged";

interface RunResult {
  variant: string;
  run: number;
  verdict: Verdict;
  /** 落到盘上的层文件（按顺序，人眼可判它走到了哪一层） */
  landedFiles: string[];
  turns: TurnLog[];
  dir: string;
}

/**
 * 会落到 `characters/` 上的工具。**按"这个工具能不能写那个目录"列，不按"这个工具是不是角色专用"**——
 * 后者已经不存在了（角色专用工具全删，删卡就是通用的 `delete`）。
 *
 * `write` / `edit` 是新增的两条主路径，从前没有，"对角色层动手"漏了它们就漏掉大半信号。
 */
const CHAR_WRITERS = new Set(["write", "edit", "delete", "propose-design", "apply-design"]);

/** 硬证据：真的对角色层动手了（加载它的规范 / 建卡改卡删卡 / 写它的目录）。 */
const isCharTool = (t: { name: string; input: string }): boolean =>
  (t.name === "design-spec" && t.input.includes("characters")) ||
  (CHAR_WRITERS.has(t.name) && t.input.includes("characters/"));

const charAction = (log: TurnLog): boolean => log.tools.some(isCharTool);

const blank = (): TurnLog => ({ tools: [], reasoning: "", text: "", landedHere: false });

/**
 * design/ 里已有的层文档。core/world 是单文件；情节层是"一卷一个文件"，所以认 `outline/vol_<N>.md`——
 * **不认序列纲**，那是卷内的下一层，探针只关心"走到哪一层了"。
 */
const layerFiles = (all: string[]): string[] => all.filter((f) => /(^|\/)(core|world)\.md$|^outline\/vol_\d+\.md$/.test(f));

async function runOnce(variant: Variant, run: number, outRoot: string, model: ModelConfig): Promise<RunResult> {
  const dir = join(outRoot, `${variant.id}-${run}`);
  await mkdir(dir, { recursive: true });
  process.env.TALEMATE_HOME = dir; // talemateHome() 每次调用现读 env，改了即生效

  const { agents, tools } = buildHarness(variant);
  const meta = await createProject({ title: `probe-${variant.id}-${run}` });
  const projectId = meta.id;

  let cur = blank();
  const io: UserIO = {
    onEvent: (e: LLMEvent) => {
      if (e.type === "tool-call") cur.tools.push({ name: e.name, input: e.input });
      else if (e.type === "reasoning.delta") cur.reasoning += e.text;
      else if (e.type === "text.delta") cur.text += e.text;
    },
    confirm: async () => "once",
    // 中性：既不授权也不阻止——真实的用户被问到时未必答得上来。
    askUser: async () => "（探针：这个我还没想好）",
  };

  const session = new Session({
    projectId,
    model,
    io,
    meta: await loadProjectMeta(projectId),
    agents,
    tools,
  });
  await session.saveMeta(`probe:${variant.id}`);

  const turns: TurnLog[] = [];
  let prevLayers: string[] = [];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (turn > 1 && session.pending.size === 0) break; // 没有待批的了 → 上一个 post 就是"材料用完"那一刻
    if (turns.some(charAction)) break; // 已经动手了，目的达到

    cur = blank();
    await session.post(turn === 1 ? PITCH : APPROVE);

    const layers = layerFiles(await listDesigns(projectId));
    cur.landedHere = layers.length > prevLayers.length;
    prevLayers = layers;
    turns.push({ ...cur });
  }

  const landedFiles = prevLayers;
  const lastLand = turns.map((t, i) => (t.landedHere ? i : -1)).filter((i) => i >= 0).pop();
  let verdict: Verdict;
  if (lastLand === undefined) verdict = "diverged"; // 一层都没落上盘 → 场景没复现，先查探针
  else if (turns.slice(lastLand).some(charAction)) verdict = "advanced";
  else verdict = "stopped"; // 落完盘没对角色层动手 → 交回用户了

  return { variant: variant.id, run, verdict, landedFiles, turns, dir };
}

// ─────────────────────────── 主流程 ───────────────────────────

const fmtTurn = (t: TurnLog, i: number): string => {
  // ★ = 对角色层动手的调用
  const tools = t.tools.map((x) => (isCharTool(x) ? `${x.name}★` : x.name)).join(", ") || "（无工具）";
  const text = t.text.replace(/\s+/g, " ").slice(0, 80);
  return `  - turn${i + 1}: ${tools}${t.landedHere ? "  [本轮落盘]" : ""}${text ? ` | ${text}` : ""}`;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check");
  const picked = argv.filter((a) => !a.startsWith("--"));
  const selected = picked.length ? VARIANTS.filter((v) => picked.includes(v.id)) : VARIANTS;
  if (!selected.length) {
    console.error(`没有匹配的变体。可用：${VARIANTS.map((v) => v.id).join(", ")}`);
    process.exit(1);
  }

  // 先把所有变体装配一遍：替换串没命中会在这里就抛，不花一分钱 token
  for (const v of selected) {
    try {
      buildHarness(v);
      console.log(`✓ ${v.id.padEnd(20)} ${v.note}`);
    } catch (e) {
      console.error(`✗ ${v.id.padEnd(20)} ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }
  if (checkOnly) {
    console.log("\n（--check 只校验替换串命中，未调用模型）");
    return;
  }

  const runs = Number(process.env.TALEMATE_PROBE_RUNS ?? 3);
  const outRoot = resolve("experiments/output/probe");
  const model = loadModelConfig();
  console.log(`\n模型：${model.provider}/${model.model} · 每个变体 ${runs} 次 · 产物：${outRoot}\n`);

  const results: RunResult[] = [];
  for (const v of selected) {
    for (let i = 1; i <= runs; i++) {
      const r = await runOnce(v, i, outRoot, model);
      results.push(r);
      console.log(
        `${v.id.padEnd(20)} run${i}  ${r.verdict.padEnd(9)} turns=${r.turns.length}` +
          ` 落盘=[${r.landedFiles.join(", ") || "无"}]`,
      );
    }
  }

  const lines: string[] = [
    "# 探针报告 · 材料用完之后会不会自己开新的一层",
    "",
    `模型：\`${model.provider}/${model.model}\` · 每个变体 ${runs} 次 · ${new Date().toISOString()}`,
    "",
    "| 变体 | 说明 | advanced（对角色层动手） | stopped（交回用户） | diverged（没复现） | 平均落盘层数 |",
    "|---|---|---|---|---|---|",
  ];
  for (const v of selected) {
    const rs = results.filter((r) => r.variant === v.id);
    const n = (x: Verdict): string => `${rs.filter((r) => r.verdict === x).length}/${rs.length}`;
    const avg = (rs.reduce((s, r) => s + r.landedFiles.length, 0) / rs.length).toFixed(1);
    lines.push(`| \`${v.id}\` | ${v.note} | ${n("advanced")} | ${n("stopped")} | ${n("diverged")} | ${avg} |`);
  }
  lines.push("", "## 逐次轨迹", "");
  for (const r of results) {
    lines.push(`### \`${r.variant}\` run${r.run} → **${r.verdict}**`);
    r.turns.forEach((t, i) => lines.push(fmtTurn(t, i)));
    lines.push(`- 产物：\`${r.dir}\``, "");
  }
  const reportPath = join(outRoot, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  await mkdir(outRoot, { recursive: true });
  await writeFile(reportPath, lines.join("\n") + "\n", "utf-8");

  console.log("\n" + lines.slice(0, lines.indexOf("## 逐次轨迹")).join("\n"));
  console.log(`\n报告：${reportPath}`);
}

await main();
