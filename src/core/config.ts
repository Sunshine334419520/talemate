/**
 * 配置与路径解析。
 * - TALEMATE_HOME：受管根目录（默认 ~/.talemate），其下 novels/<project-id> 一小说一目录。
 * - 模型配置沿用现有环境变量（TALEMATE_PROVIDER/MODEL/REASONING/MAX_TOKENS/…），兼容已有 .env。
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelConfig, Provider, Reasoning } from "./types";

export function talemateHome(env = process.env): string {
  return env.TALEMATE_HOME || join(homedir(), ".talemate");
}

/** 受管根目录下的目录/文件路径 */
export function paths(home = talemateHome()) {
  return {
    home,
    novelsRoot: join(home, "novels"),
    globalSkills: join(home, "skills"),
    globalAgents: join(home, "AGENTS.md"),
  };
}

/**
 * 作品的三个根。
 *
 * 读口与写口共用这一份清单：加根只改这一行，两边同时到位。若分成两份，漏改一处的后果是
 * 写得进去读不回来（或反过来）且不报错——正是 CLAUDE.md 里"绝不手抄一份能推出来的清单"要防的事。
 *
 * 三个根的分工：`design/` 与 `chapters/` 是作品（设定与正文），`state/` 是当前状态
 * （每章都在变的东西：谁在场、谁知道什么、伏笔收到哪了）。判据见 `docs/state.md`。
 */
export const DOC_ROOTS = ["design", "chapters", "state"] as const;

export type DocRoot = (typeof DOC_ROOTS)[number];

/**
 * 某个根在某项目下的绝对目录——唯一一处"根 → 目录"的映射。
 *
 * 不能用 `root === "design" ? pp.design : pp.chapters` 这种三元：加第三个根时它会把 state
 * 静默地指到 chapters/；改成按键取之后，"根没有对应目录"是编译期错误。
 */
export function rootAbs(projectId: string, root: DocRoot): string {
  return projectPaths(talemateHome(), projectId)[root];
}

/**
 * 仓库自带的 skill 库（`<repo>/skills/`）——随产品发布的那一份，如默认文风卡 `prose`。
 *
 * 它与 `paths().globalSkills`（用户全局库）不是一回事：这个跟着代码走、改了要发版，
 * 那个是作者的、跨作品积累的。所以它排在发现顺序的最后——用户自己的同名 skill 压得过它，
 * 而它压不过任何人。相对 `import.meta.url` 解析，不依赖 cwd（同 `prompts.ts`）。
 */
export function builtinSkillsDir(): string {
  return join(resourceRoot() ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."), "skills");
}

/**
 * 随包数据（`prompts/` 与 `skills/`）的根。
 *
 * 默认从 `import.meta.url` 往上推——源码旁边就是它们，所以 CLI 与测试什么都不用做。但打包之后
 * 那个 URL 指向 bundle 内部（`out/main/index.js` 旁边当然没有 prompts），于是这两个目录会被算到
 * 构建产物旁边。现象是"提示词读不到、skill 一个都没有"——而且不报错：skill 扫描本来就把
 * "目录不存在"当空库（`skill/discovery.ts` 的 `scanDir`），一个都不会被发现。
 *
 * 所以给外壳一个钉子：启动时 `setResourceRoot(app.isPackaged ? process.resourcesPath : 仓库根)`。
 * 它必须在第一次读取之前调用，而"第一次读取"发生在模块加载之外——所以下面每一处都是惰性
 * 求值（函数里算，不在模块顶层算）：顶层算过的话，import 提升会让外壳永远来不及钉。
 */
let pinned: string | undefined;

export function setResourceRoot(dir: string | undefined): void {
  pinned = dir;
}

/**
 * 钉住的随包数据根；没钉 = `undefined`，由调用方按自己那个文件往上推算（各处的层数不同：
 * 本文件在 `src/core/` 是两层，`prompts.ts` 在 `src/` 是一层——这一层不替它们算，算错了
 * 是静默地指到仓库外面去）。
 */
export function resourceRoot(): string | undefined {
  return pinned;
}

/** 项目目录与内部结构 */
export function projectPaths(home: string, projectId: string) {
  const root = join(home, "novels", projectId);
  const design = join(root, "design");
  return {
    root,
    meta: join(root, "talemate.json"),
    agents: join(root, "AGENTS.md"),
    design,
    wiki: join(design, "wiki"),
    characters: join(design, "characters"),
    outline: join(design, "outline"),
    chapters: join(root, "chapters"),
    // 状态层：每章都在变的东西（谁在场、谁知道什么、伏笔收到哪了）。与作品平级而不是
    // 在 design/ 下面——它是"现在到哪了"，不是"这本书是什么样"，同一条边界也把规划工件
    // 挡在 .talemate/ 里。判据见 docs/state.md。
    state: join(root, "state"),
    skills: join(root, "skills"),
    sessions: join(root, ".talemate", "sessions"),
    // 章节规划工件（框架章节生产那条链的中间态）。归 .talemate/ 而不是 design/：
    // design/ 与 chapters/ 是作品（用户审阅、进版本控制），这一份是引擎的工作区。
    plans: join(root, ".talemate", "plans"),
    // 考据本：researcher 查证过的结论（一题一份）。同 `.talemate/` 的道理，而且更强——这本
    // 账的全部意义就是不打扰用户，所以它既不是作品、也不该有任何审阅环节。读口只有
    // `recall` 一个（它进不了 DOC_ROOTS，`read`/`list`/`search` 都够不着）。见 `storage/notes.ts`。
    research: join(root, ".talemate", "research"),
  };
}

export function sessionPaths(home: string, projectId: string, sessionId: string) {
  const dir = join(home, "novels", projectId, ".talemate", "sessions", sessionId);
  return { dir, meta: join(dir, "session.json"), messages: join(dir, "messages.jsonl") };
}

/** 从环境变量加载项目默认模型（各角色可覆盖） */
export function loadModelConfig(env = process.env): ModelConfig {
  const provider = (env.TALEMATE_PROVIDER as Provider) || "anthropic";
  const reasoning = (env.TALEMATE_REASONING as Reasoning) || "off";
  const userMaxTokens = Number(env.TALEMATE_MAX_TOKENS) || 16000;
  // 思考模式会先烧大量 token 做推理；开着思考时抬高输出预算防截断
  const maxTokens = reasoning !== "off" ? Math.max(userMaxTokens, 32000) : userMaxTokens;
  const temperature = env.TALEMATE_TEMPERATURE ? Number(env.TALEMATE_TEMPERATURE) : undefined;
  return {
    provider,
    apiKey: env.TALEMATE_API_KEY || undefined,
    model:
      env.TALEMATE_MODEL ||
      (provider === "anthropic" ? "claude-opus-5" : provider === "openai" ? "gpt-4o" : "mock-1"),
    baseURL: env.TALEMATE_API_BASE || undefined,
    maxTokens,
    reasoning,
    temperature,
  };
}

/** 是否具备可用凭据（mock 不需 key，供离线冒烟） */
export function hasCredentials(cfg: ModelConfig, env = process.env): boolean {
  if (cfg.provider === "mock") return true;
  return Boolean(cfg.apiKey || (cfg.provider === "anthropic" && env.ANTHROPIC_API_KEY));
}
