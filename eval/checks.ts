/**
 * 判据执行：把 case 里的 Check 折成 pass/fail + 证据。
 *
 * 只读一次 run 的快照（每轮结束时的文件、消息、事件、改动索引），不调模型、不碰 Session。
 * 判据失败要给出"期望什么、实际什么"，否则报告只能看到一条红叉。
 *
 * 边界：不认识 runner；`afterTurn` 的上限由调用方保证。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantPart, StoredMessage } from "../src/core/types";
import type { AnyTraceEvent } from "../src/telemetry/events";
import type { ChangeRecord } from "../src/storage/change_index";
import type { Check, EvalCase } from "./types";

export interface TurnSnapshot {
  /** 项目相对路径 → 内容；只收作品三个根 */
  files: Record<string, string>;
  messages: StoredMessage[];
  events: AnyTraceEvent[];
  changes: ChangeRecord[];
}

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

type ToolPart = Extract<AssistantPart, { type: "tool" }>;

function toolParts(messages: readonly StoredMessage[]): ToolPart[] {
  const parts: ToolPart[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === "tool") parts.push(part);
    }
  }
  return parts;
}

function countEvents(events: readonly AnyTraceEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function usageOf(events: readonly AnyTraceEvent[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const event of events) {
    if (event.type === "step/end" && event.data.usage !== undefined) {
      input += event.data.usage.input;
      output += event.data.usage.output;
    }
  }
  return { input, output };
}

function labelOf(check: Check): string {
  switch (check.kind) {
    case "file-exists":
    case "file-absent":
    case "file-equals":
    case "file-not-contains":
    case "file-unchanged":
    case "file-contains":
    case "file-matches":
    case "change-recorded":
      return `${check.kind}:${check.path}`;
    case "tool-called":
    case "tool-not-called":
      return `${check.kind}:${check.name}`;
    case "tool-order":
      return `tool-order:${check.names.join("→")}`;
    case "turn-halted":
      return `turn-halted:${check.afterTool}`;
    case "max-steps":
      return `max-steps:${check.n}`;
    case "max-tokens":
      return `max-tokens:${check.n}`;
    case "event-exists":
    case "event-count-at-most":
      return `${check.kind}:${check.type}`;
    case "assistant-text-contains":
      return `assistant-text-contains:${check.text}`;
  }
}

const fixtures = new Map<string, string | undefined>();

async function fixtureContent(root: string, path: string): Promise<string | undefined> {
  const key = join(root, path);
  if (fixtures.has(key)) return fixtures.get(key);
  let content: string | undefined;
  try {
    content = await readFile(key, "utf-8");
  } catch {
    content = undefined;
  }
  fixtures.set(key, content);
  return content;
}

/**
 * 跑一条判据。`fixtureRoot` 是 case 的 fixtures/ 目录——`file-unchanged` 要拿它当基准。
 *
 * `afterTurn` 缺省 = 最后一轮；文件类判据看那一轮的快照，工具/事件类判据看截至那一轮的历史。
 */
async function evaluate(
  check: Check,
  snapshots: readonly TurnSnapshot[],
  fixtureRoot: string,
): Promise<CheckResult> {
  const index = check.afterTurn ?? snapshots.length - 1;
  const snap = snapshots[index];
  if (snap === undefined) {
    return { id: labelOf(check), ok: false, detail: `afterTurn=${index} 超出实际轮数（${snapshots.length}）` };
  }

  const parts = toolParts(snap.messages);
  const file = (path: string): string | undefined => snap.files[path];

  switch (check.kind) {
    case "file-exists": {
      const content = file(check.path);
      return content === undefined
        ? { id: labelOf(check), ok: false, detail: `文件不存在：${check.path}` }
        : { id: labelOf(check), ok: true, detail: `${check.path} 存在` };
    }

    case "file-absent": {
      const content = file(check.path);
      return content === undefined
        ? { id: labelOf(check), ok: true, detail: `${check.path} 不存在` }
        : { id: labelOf(check), ok: false, detail: `${check.path} 存在（不该有）` };
    }

    case "file-unchanged": {
      const expected = await fixtureContent(fixtureRoot, check.path);
      if (expected === undefined) {
        return { id: labelOf(check), ok: false, detail: `fixture 里没有 ${check.path}` };
      }
      const actual = file(check.path);
      if (actual === undefined) {
        return { id: labelOf(check), ok: false, detail: `文件不存在：${check.path}` };
      }
      return actual === expected
        ? { id: labelOf(check), ok: true, detail: "与 fixture 一致" }
        : { id: labelOf(check), ok: false, detail: `与 fixture 不同（${actual.length} 字 vs ${expected.length} 字）` };
    }

    case "file-equals": {
      const actual = file(check.path);
      if (actual === undefined) {
        return { id: labelOf(check), ok: false, detail: `文件不存在：${check.path}` };
      }
      const expected = check.text.replace(/\r\n/g, "\n");
      const got = actual.replace(/\r\n/g, "\n");
      return got === expected
        ? { id: labelOf(check), ok: true, detail: `${check.path} 完全一致` }
        : { id: labelOf(check), ok: false, detail: `${check.path} 与期望不同（期望 ${expected.length} 字，实际 ${got.length} 字）` };
    }

    case "file-not-contains": {
      const actual = file(check.path);
      if (actual === undefined) {
        return { id: labelOf(check), ok: false, detail: `文件不存在：${check.path}` };
      }
      return actual.includes(check.text)
        ? { id: labelOf(check), ok: false, detail: `仍包含「${check.text}」` }
        : { id: labelOf(check), ok: true, detail: `不含「${check.text}」` };
    }

    case "file-contains": {
      const actual = file(check.path);
      if (actual === undefined) {
        return { id: labelOf(check), ok: false, detail: `文件不存在：${check.path}` };
      }
      return actual.includes(check.text)
        ? { id: labelOf(check), ok: true, detail: `包含「${check.text}」` }
        : { id: labelOf(check), ok: false, detail: `不包含「${check.text}」` };
    }

    case "file-matches": {
      const actual = file(check.path);
      if (actual === undefined) {
        return { id: labelOf(check), ok: false, detail: `文件不存在：${check.path}` };
      }
      let re: RegExp;
      try {
        re = new RegExp(check.pattern);
      } catch {
        return { id: labelOf(check), ok: false, detail: `正则无法编译：${check.pattern}` };
      }
      return re.test(actual)
        ? { id: labelOf(check), ok: true, detail: "匹配" }
        : { id: labelOf(check), ok: false, detail: `不匹配 /${check.pattern}/` };
    }

    case "tool-called": {
      const called = parts.some((part) => part.name === check.name);
      return called
        ? { id: labelOf(check), ok: true, detail: `调用了 ${check.name}` }
        : { id: labelOf(check), ok: false, detail: `没有调用 ${check.name}（调用过：${parts.map((p) => p.name).join("、") || "无"}）` };
    }

    case "tool-not-called": {
      const called = parts.some((part) => part.name === check.name);
      return called
        ? { id: labelOf(check), ok: false, detail: `不该调用 ${check.name}，但调了` }
        : { id: labelOf(check), ok: true, detail: `没有调用 ${check.name}` };
    }

    case "tool-order": {
      let cursor = 0;
      for (const part of parts) {
        if (cursor < check.names.length && part.name === check.names[cursor]) cursor++;
      }
      return cursor === check.names.length
        ? { id: labelOf(check), ok: true, detail: `顺序命中：${check.names.join("→")}` }
        : { id: labelOf(check), ok: false, detail: `只命中前 ${cursor} 个：${check.names.slice(0, cursor).join("→") || "无"}` };
    }

    case "turn-halted": {
      const halted = parts.some((part) => part.name === check.afterTool && part.halt === true);
      return halted
        ? { id: labelOf(check), ok: true, detail: `${check.afterTool} 后回合结束` }
        : { id: labelOf(check), ok: false, detail: `${check.afterTool} 后没有 halt` };
    }

    case "change-recorded": {
      const hit = snap.changes.find(
        (record) => record.path === check.path && (check.changeKind === undefined || record.kind === check.changeKind),
      );
      return hit === undefined
        ? { id: labelOf(check), ok: false, detail: `改动索引里没有 ${check.path}` }
        : { id: labelOf(check), ok: true, detail: `${check.path} 记为 ${hit.kind}` };
    }

    case "max-steps": {
      const steps = countEvents(snap.events, "step/start");
      return steps <= check.n
        ? { id: labelOf(check), ok: true, detail: `${steps} 步` }
        : { id: labelOf(check), ok: false, detail: `${steps} 步，超过 ${check.n}` };
    }

    case "max-tokens": {
      const usage = usageOf(snap.events);
      const total = usage.input + usage.output;
      return total <= check.n
        ? { id: labelOf(check), ok: true, detail: `${total} token` }
        : { id: labelOf(check), ok: false, detail: `${total} token，超过 ${check.n}` };
    }

    case "event-exists": {
      const count = countEvents(snap.events, check.type);
      return count > 0
        ? { id: labelOf(check), ok: true, detail: `${check.type} × ${count}` }
        : { id: labelOf(check), ok: false, detail: `没有 ${check.type} 事件` };
    }

    case "assistant-text-contains": {
      const text = [...snap.messages]
        .reverse()
        .find((message) => message.role === "assistant")
        ?.parts?.filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      if (text === undefined || text.trim() === "") {
        return { id: labelOf(check), ok: false, detail: "没有助手正文" };
      }
      return text.includes(check.text)
        ? { id: labelOf(check), ok: true, detail: `包含「${check.text}」` }
        : { id: labelOf(check), ok: false, detail: `不包含「${check.text}」（正文 ${text.length} 字）` };
    }

    case "event-count-at-most": {
      const count = countEvents(snap.events, check.type);
      return count <= check.n
        ? { id: labelOf(check), ok: true, detail: `${check.type} × ${count}` }
        : { id: labelOf(check), ok: false, detail: `${check.type} × ${count}，超过 ${check.n}` };
    }
  }
}

export async function runChecks(
  _case: EvalCase,
  snapshots: readonly TurnSnapshot[],
  fixtureRoot: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of _case.checks) {
    try {
      results.push(await evaluate(check, snapshots, fixtureRoot));
    } catch (err) {
      results.push({
        id: labelOf(check),
        ok: false,
        detail: `判据自身抛错：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}
