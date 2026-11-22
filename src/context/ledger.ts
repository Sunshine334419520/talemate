/**
 * 账本：证据账、决定账——都是确定性的，能从事件与工具 part 算出来，所以不交给模型生成。
 *
 * 证据账回答"压掉的正文去哪重读"；决定账回答"用户拍过什么板"。模型只写 `<session>` 那一段
 * 对话叙事，两份账由这里派生（D5）。
 *
 * 边界：纯函数，只吃消息与事件；不读文件、不调模型。
 */
import type { DecisionEntry, EvidenceEntry, StoredMessage } from "../core/types";
import type { AnyTraceEvent } from "../telemetry/events";

/** 按工具名归类；未知工具不记账（写类工具不产生"重读坐标"）。 */
function kindOf(name: string): EvidenceEntry["kind"] | undefined {
  switch (name) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "task":
      return "task";
    case "recall":
      return "recall";
    case "skill":
      return "skill";
    case "webfetch":
    case "websearch":
      return "web";
    default:
      return undefined;
  }
}

function parseInput(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstLine(text: string | undefined, max = 120): string | undefined {
  if (text === undefined) return undefined;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? undefined : line.length > max ? `${line.slice(0, max)}…` : line;
}

/** task 的结论在 `<task_result>` 里；证据行要的是结论，不是外壳标签。 */
function conclusionDigest(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const inner = /<task_result>\s*([\s\S]*?)<\/task_result>/.exec(output)?.[1];
  return firstLine(inner ?? output);
}

/** read 的输出头里有路径与小节；rev 从 `@rev` / `rev:` 里取，取不到就不编。 */
function revFrom(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const m = /@([0-9a-f]{4,64})\b/.exec(output) ?? /\brev[:=]\s*([0-9a-f]{4,64})\b/i.exec(output);
  return m?.[1];
}

/** 证据账的保留条数。超出时按"最近使用"丢弃最老的——规则确定性，不靠模型判断。 */
export const EVIDENCE_MAX = 30;

/** 被压段里的工具调用 → 证据账。同 kind+path+section 只留最新一条。 */
export function evidenceFrom(messages: readonly StoredMessage[]): EvidenceEntry[] {
  const byKey = new Map<string, EvidenceEntry>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool" || p.state !== "completed") continue;
      const kind = kindOf(p.name);
      if (kind === undefined) continue;
      const input = parseInput(p.input);
      const path = typeof input.path === "string" ? input.path : kind === "web" && typeof input.url === "string" ? input.url : undefined;
      const section = typeof input.section === "string" ? input.section : undefined;
      const label =
        kind === "task"
          ? typeof input.agent === "string"
            ? input.agent
            : "task"
          : kind === "skill"
            ? typeof input.name === "string"
              ? input.name
              : "skill"
            : kind === "search" || kind === "recall"
              ? typeof input.query === "string"
                ? input.query
                : p.name
              : kind === "web"
                ? typeof input.query === "string"
                  ? input.query
                  : typeof input.url === "string"
                    ? input.url
                    : p.name
                : p.name;
      const rev = kind === "read" ? revFrom(p.output) : undefined;
      const entry: EvidenceEntry = {
        kind,
        label,
        chars: p.output?.length ?? 0,
        ...(path === undefined ? {} : { path }),
        ...(section === undefined ? {} : { section }),
        ...(rev === undefined ? {} : { rev }),
        ...(kind === "task" || kind === "search" || kind === "recall"
          ? { digest: kind === "task" ? conclusionDigest(p.output) : firstLine(p.output) }
          : {}),
      };
      byKey.set(`${kind}\u0000${path ?? ""}\u0000${section ?? ""}`, entry);
    }
  }
  return [...byKey.values()].slice(-EVIDENCE_MAX);
}

/** 会话内的拍板事件 → 决定账（原文保留，不重写）。 */
export function decisionsFrom(events: readonly AnyTraceEvent[]): DecisionEntry[] {
  return events
    .filter((e): e is Extract<AnyTraceEvent, { type: "proposal/decision" }> => e.type === "proposal/decision")
    .map((e) => e.data);
}

/** 一行证据的渲染：`read design/characters/林晚.md §档案 @9f2c1a`。 */
export function renderEvidenceLine(e: EvidenceEntry): string {
  const parts: string[] = [e.kind];
  if (e.path !== undefined) parts.push(e.path);
  if (e.section !== undefined) parts.push(`§${e.section}`);
  else if (e.path === undefined) parts.push(e.label);
  if (e.rev !== undefined) parts.push(`@${e.rev}`);
  const head = parts.join(" ");
  return e.digest === undefined || e.digest === "" ? head : `${head} — ${e.digest}`;
}