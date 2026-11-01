/**
 * 评测系统的契约：case、判据、manifest、运行结果、变体。
 *
 * 这些类型是 runner / replay / report / CI 的共同接口；先定它们，再写实现。
 * 设计说明见 `docs/eval-system.md`，实现从 M1 开始。
 *
 * 边界：只有类型与运行时常量（family / check kind 清单），不读文件、不认识 Session。
 */

export const FAMILIES = ["workflow", "prose", "design", "context", "routing", "safety"] as const;

export type Family = (typeof FAMILIES)[number];

export const CHECK_KINDS = [
  "file-exists",
  "file-absent",
  "file-unchanged",
  "file-contains",
  "file-not-contains",
  "file-matches",
  "tool-called",
  "tool-not-called",
  "tool-order",
  "turn-halted",
  "change-recorded",
  "max-steps",
  "max-tokens",
  "event-exists",
  "event-count-at-most",
  "assistant-text-contains",
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

/** 每条判据都可在某一轮结束后看；缺省 = 整个 case 跑完。 */
interface CheckBase {
  /** 0 起；用来断言"拍板前"与"拍板后"两种状态 */
  afterTurn?: number;
}

export type Check = CheckBase &
  (
    | { kind: "file-exists"; path: string }
    | { kind: "file-absent"; path: string }
    | { kind: "file-unchanged"; path: string; against: "fixture" | "before" }
    | { kind: "file-contains"; path: string; text: string }
    | { kind: "file-not-contains"; path: string; text: string }
    | { kind: "file-matches"; path: string; pattern: string }
    | { kind: "tool-called"; name: string }
    | { kind: "tool-not-called"; name: string }
    | { kind: "tool-order"; names: string[] }
    | { kind: "turn-halted"; afterTool: string }
    | { kind: "change-recorded"; path: string; changeKind?: "created" | "modified" | "deleted" }
    | { kind: "max-steps"; n: number }
    | { kind: "max-tokens"; n: number }
    | { kind: "event-exists"; type: string }
    | { kind: "event-count-at-most"; type: string; n: number }
    | { kind: "assistant-text-contains"; text: string }
  );

export interface EvalCase {
  /** `<family>-<slug>`，全局唯一 */
  id: string;
  family: Family;
  /** 稳定、确定性、每次提交都要过 */
  base: boolean;
  /** 只在验收时看，不参与调参 */
  holdout?: boolean;
  /** 第一句用户输入 */
  brief: string;
  /** 后续用户回话；省略 = 单轮 */
  followUps?: string[];
  /** case 目录下有 fixtures/ 要预置进临时项目 */
  fixtures?: boolean;
  /** prose case：跑之前先放一份"已批准、未执行"的第 N 章规划，正文窗口才会打开 */
  prosePlanChapter?: number;
  /** 上面那份规划的正文；省略 = 一句话占位 */
  prosePlanContent?: string;
  /** 跑之前把会话切到这个模式（draft / accept-edits / prose）；省略 = 默认 */
  mode?: "draft" | "accept-edits" | "prose";
  /** 评测用户是否回答提问；false = 沿用 autoIO（无回答方），true = 一律答"按你的判断来" */
  answerer?: boolean;
  /** 本 case 专用的环境变量（如压低的压缩阈值）；跑完恢复 */
  env?: Record<string, string>;
  /** 钉死模型参数：评测不能跟着 `.env` 漂，否则 cassette 全是 miss */
  model?: {
    reasoning?: "off" | "low" | "high" | "max";
    temperature?: number;
    maxTokens?: number;
  };
  /** 硬判据（L1/L2），全过才算 pass */
  checks: Check[];
  /** L4 评分表 id，指向 eval/rubric/<id>.md */
  rubric?: string;
  /** 锚点样本，给人和 judge 共用 */
  anchors?: { low: string; mid: string; high: string };
  budget: { maxTurns: number; maxSteps: number; maxTokens: number };
  tags?: string[];
}

/** 一次 run 的钉扎信息；报告里原样抄一份。 */
export interface Manifest {
  runId: string;
  caseHash: string;
  /** 装配后的 system + tools 全量 hash */
  promptHash: string;
  /** 分段 hash：mate / tools / modes / skills */
  promptParts: Record<string, string>;
  /** 常驻文档 hash，≠ prompt */
  contextHash: string;
  toolsHash: string;
  model: { provider: string; model: string; reasoning?: string; temperature?: number; maxTokens: number };
  codeCommit: string;
  bun: string;
  /** 固定时钟（TALEMATE_TODAY）；报告里可见 */
  clock: string;
}

export type FailureBucket =
  | "no-tool"
  | "wrong-tool"
  | "approval-skipped"
  | "file-wrong"
  | "constraint-lost"
  | "timeout"
  | "provider-error"
  | "budget-exceeded"
  | "other";

export interface RunResult {
  runId: string;
  caseId: string;
  family: Family;
  /** 这条 case 是否是回归门 */
  base: boolean;
  /** 附带的 L4 评分表；M1 只记录，不自动打分 */
  rubric?: string;
  /** baseline | 变体名 */
  variantId: string;
  repeat: number;
  manifest: Manifest;
  checks: { id: string; ok: boolean; detail?: string }[];
  verdict: "pass" | "fail" | "error" | "timeout";
  failureBucket?: FailureBucket;
  steps: number;
  usage: { input: number; output: number };
  costYuan: number;
  wallMs: number;
  /** traces/<runId>/，可 gitignore */
  tracePath: string;
}

/**
 * 变体 patch：唯一实现是 `src/probe/patches.ts`，probe 与 eval 共用。
 * `VariantPatch` 保留旧名，避免调用方一起改。
 */
export type { Patch as VariantPatch, Variant } from "../src/probe/patches";
