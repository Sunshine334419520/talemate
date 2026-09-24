/**
 * Agent 注册表的路由契约守卫（与 `docs.test.ts` / `specs.test.ts` 同一路数：让约定长在 CI 里，
 * 而不是靠人记得）。`prompts/README.md` 是这些约定的正文，这里是它的执行器。
 *
 * 守的是 subagent **加多了之后会烂**的地方。每加一个，它的 description 就被拼进**同一份** `task`
 * 目录（`AgentRegistry.subagentCatalog()`），模型要在那一份目录里选谁。所以：
 *
 *   1. **有触发条件**（"Use this when"）——没有它，这行目录对路由毫无贡献；
 *   2. **有"何时不用我"**——只有一个 subagent 时可选，两个以上必需；两份都写着
 *      "Use this when…" 的 description，等于让模型在目录里瞎猜；
 *   3. **自己 deny 掉 `question`**——这条最要紧。`AgentDef.tools` **不是执行边界**（它只决定模型
 *      看得见哪些 schema，执行查的是全局 registry），所以白名单里没有 `ask-user` 不代表调不出来：
 *      子代理只要没自己 deny，一次幻觉出来的 `ask-user` 就会真的**把用户从自己的对话里拽出来**
 *      ——而它跑在隔离上下文里，用户根本不在场。见 `docs/permissions.md` 与 writer/researcher 的注释。
 */
import { describe, test, expect } from "bun:test";
import { DEFAULT_AGENTS } from "../src/agent/registry";
import { evaluate, fromConfig } from "../src/permission";
import type { AgentDef } from "../src/core/types";

const subs = DEFAULT_AGENTS.filter((a) => a.mode === "subagent");

/** 空 description 是**有意语义**（"只能由人手动调用"，见 `subagentCatalog`），跳过；非空的必须满足契约。 */
const routable = subs.filter((a) => (a.description ?? "").trim().length > 0);

/** "何时不用我"的标记。宽松取几种自然写法，只求这一步真的说出了口。 */
const NOT_FOR_ME = [/\binstead\b/i, /\bnot for\b/i, /\bdo not use\b/i, /\bdon't use\b/i, /\brather than\b/i];

/** 子代理跑在用户不在场的地方，这三个工具的白名单不该出现。 */
const USER_FACING = ["ask-user", "confirm", "task"];

describe("agent 注册表 · 路由契约", () => {
  test("注册表里有 subagent（读空了别静默通过）", () => {
    expect(subs.length).toBeGreaterThan(0);
    expect(routable.length).toBeGreaterThan(0);
  });

  test("每个 subagent 的 description 都写了触发条件", () => {
    const missing = routable.filter((a) => !(a.description as string).includes("Use this when")).map((a) => a.id);
    expect(missing).toEqual([]);
  });

  test("每个 subagent 的 description 都写了「何时不用我、那种情况找谁」", () => {
    // 两份都只写 "Use this when…" 时模型分不开；这条逼着每份说清自己**不是**干什么的。
    const missing = routable
      .filter((a) => !NOT_FOR_ME.some((re) => re.test(a.description as string)))
      .map((a) => a.id);
    expect(missing).toEqual([]);
  });

  test("每个 subagent 都自己 deny 掉 question——否则它会隔着隔离上下文问用户", () => {
    // 查的是**它自己声明的**规则，不含父的 deny：父的规则随模式变，靠不住（模式里没有 question 规则）。
    const leaking = subs
      .filter((a: AgentDef) => evaluate("question", "*", fromConfig(a.permission ?? {})).action !== "deny")
      .map((a) => a.id);
    expect(leaking).toEqual([]);
  });

  test("每个 subagent 的 tools 白名单里没有面向用户的工具", () => {
    const bad = subs
      .filter((a) => USER_FACING.some((t) => a.tools.includes(t)))
      .map((a) => `${a.id}: ${a.tools.filter((t) => USER_FACING.includes(t)).join(", ")}`);
    expect(bad).toEqual([]);
  });
});
