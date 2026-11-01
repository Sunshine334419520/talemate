/**
 * 变体装配：把 patch 应用在内存里的 agent / tool 定义上，不改仓库文件。
 *
 * probe 的单变量消融与 eval 的 `--variant` 共用这一份——两套各写一份，替换串迟早对不上。
 * `mustReplace` 是硬约束：原文没命中就直接抛，绝不让变体静默退化成 baseline（P4）。
 *
 * 边界：只认 agents / tools 的内存定义；不认识 Session、不认识文件系统。
 */
import { AgentRegistry, DEFAULT_AGENTS } from "../agent/registry";
import type { AgentDef } from "../core/types";
import { BUILTIN_TOOLS } from "../tool";
import { ToolRegistry } from "../tool/registry";

export type Patch =
  | { kind: "persona"; note: string; before: string; after: string }
  | { kind: "describe"; tool: string; note: string; before: string; after: string }
  | { kind: "dropTools"; note: string; names: string[] }
  /**
   * 给某工具的结果追加一句（加上去测，不是删）。
   *
   * 消融法测不出"缺失型病因"（删不掉不存在的东西），只能把它加进去看行为变不变。
   */
  | { kind: "appendResult"; tool: string; note: string; text: string };

export interface Variant {
  id: string;
  note: string;
  patches: Patch[];
}

/**
 * 替换必须命中：没命中说明原文变了、变体会静默退化成 baseline，整场实验就成了假的。
 *
 * 行尾容忍：patch 的字面量按 `\n` 写（git 里存的就是 LF），但检出到工作区可能是 CRLF
 * （本机 `core.autocrlf=true`）。不认这一层，整场 probe 会因为行尾而在第一处就抛。
 */
export function mustReplace(text: string, before: string, after: string, what: string): string {
  for (const [b, a] of [
    [before, after],
    [before.replace(/\n/g, "\r\n"), after.replace(/\n/g, "\r\n")],
  ]) {
    if (text.includes(b)) return text.replace(b, a);
  }
  throw new Error(`变体没生效（找不到要替换的原文）：${what}\n原文片段：${JSON.stringify(before.slice(0, 80))}`);
}

/** 变体只在内存里装配本次要用的 agents / tools，不改仓库里的任何文件。 */
export function buildHarness(variant: Variant): { agents: AgentRegistry; tools: ToolRegistry } {
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
