/**
 * 权限：谁能做什么、什么要问。
 *
 * 一个动作 = `(permission, pattern)`；一条规则 = `{permission, pattern, action}`；规则集 = `Rule[]`。
 *
 * 求值三步，**顺序不能换**：
 *   1) `deny` 先判——所有规则集里匹配 `(permission, pattern)` 的 deny，找到一条就拒。**不受顺序影响**
 *   2) 否则在这些规则集上 findLast，按最后一条匹配的规则走——顺序即优先级
 *   3) 一条都没匹配 → `ask`（默认问，不是默认放行）
 *
 * 第 1 步是它与 opencode 的唯一分歧：opencode 只做第 2 步（顺序即一切，用户配置最强）。这里让 deny
 * 单调，是因为"不许"不该被别处的"允许"盖掉——而 opencode 自己在子代理那里就是这么做的（父的 deny
 * 继承、父的 allow 不继承）。我们只是把同一条原则推广到求值。
 *
 * 完整设计见 `docs/permissions.md`。
 */
export type Action = "allow" | "ask" | "deny";

/**
 * 动作类别。**只有四个**，且刻意不含"读"——读设计文档是这个产品的日常，我们没有 `.env` 那种
 * "读了就是泄露"的对应物。少一类就少一处要维护的规则；真要加是加法，不是改法。
 */
export type PermissionName = "edit" | "delegate" | "extern" | "question";

export interface Rule {
  permission: string;
  pattern: string;
  action: Action;
}

/** 求值用的有序规则数组。**内部表示**——外面写规则一律用 `PermissionConfig`，不写这个。 */
export type Ruleset = Rule[];

/**
 * **唯一的对外形状**：写规则的所有地方（`talemate.json` 的 `permissions`、`AgentDef.permission`、
 * `ModeDef.permission`）都用它。
 *
 * ```json
 * { "edit": "ask", "extern": { "*": "deny", "localhost*": "allow" } }
 * ```
 *
 * 规则数组是求值用的内部表示，手写它很难看——所以对外永远只暴露这个形状，靠 `fromConfig` 转。
 * 两种形状并存过一次，那是个妥协，已拆掉。
 */
export type PermissionConfig = Record<string, Action | Record<string, Action>>;

/**
 * 通配符匹配。`*` 匹配任意字符**且跨 `/`**（所以 `design/*` 就是 design 下一切），`?` 匹配单字符，
 * 锚定整串。pattern 是给人写的，不做路径分段语义。
 * Windows 上不分大小写——那里的文件系统本来就不分。
 */
export function match(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}

/** `PermissionConfig` → 求值用的规则数组。**唯一的转换点**，别在别处手搓规则对象。 */
export function fromConfig(config: PermissionConfig): Ruleset {
  const out: Ruleset = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      out.push({ permission, pattern: "*", action: value });
      continue;
    }
    for (const [pattern, action] of Object.entries(value)) out.push({ permission, pattern, action });
  }
  return out;
}

/** 合并已经转换好的规则数组（求值层用）。 */
export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat();
}

/**
 * 按**层**拼一份规则集——**参数的顺序就是优先级**（后写的赢）。
 * 这是组合规则表的唯一写法：`mergeConfigs(内置默认, agent 声明, 模式覆盖, 用户配置)`。
 * 别在外面手写 `merge(fromConfig(a), fromConfig(b))`：那是同一条纪律的分散副本。
 */
export function mergeConfigs(...configs: PermissionConfig[]): Ruleset {
  return merge(...configs.map(fromConfig));
}

/** 见文件头三步。 */
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  const hits = rulesets.flat().filter((r) => match(permission, r.permission) && match(pattern, r.pattern));
  const denied = hits.find((r) => r.action === "deny");
  if (denied) return denied;
  return hits.at(-1) ?? { permission, pattern, action: "ask" };
}

export interface SourcedRule {
  rule: Rule;
  /** 定这条规则的层号（对应传给 `evaluateWithSource` 的 rulesets 顺序）；-1 = 没有任何规则匹配，走了默认 `ask`。 */
  layer: number;
}

/**
 * 同一次判断，额外说清**这条是谁定的**。
 *
 * 不用改求值逻辑就能做到：`evaluate` 返回的是某一层里的**那个对象**（`hits.at(-1)` / `find` 都不复制），
 * 所以按引用就能定位来源。默认那条是新建的，落不进任何一层 → `layer: -1`。
 *
 * 给人看的（CLI 的 `/permissions`）：用户配了规则之后，只显示"结论是 deny"没用，得显示"是模式定的"。
 */
export function evaluateWithSource(permission: string, pattern: string, ...rulesets: Ruleset[]): SourcedRule {
  const rule = evaluate(permission, pattern, ...rulesets);
  for (let i = rulesets.length - 1; i >= 0; i--) {
    if (rulesets[i].includes(rule)) return { rule, layer: i };
  }
  return { rule, layer: -1 };
}

/**
 * 内置默认：改世界的三类都要问；提问放行（子代理自己在 `registry.ts` 里把它 deny 掉）。
 * 规则集的第一层，后面依次是 agent 声明、模式覆盖——但 `deny` 不受这个顺序影响。
 */
export const BASE_PERMISSIONS: PermissionConfig = {
  edit: "ask",
  delegate: "ask",
  extern: "ask",
  question: "allow",
};

/**
 * 子代理的规则集**是拼出来的，不是继承的**：
 *   - 父的 `deny` **继承**——紧的往下传得下去
 *   - 父的 `allow` **不继承**——所以 mate 在 `accept-edits` 里落盘不问，writer 不会跟着免确认
 *   - 没自己声明 `delegate` 的一律禁委派（防链式 spawn）
 */
export function deriveSubagentPermission(parent: Ruleset, sub: { permission?: PermissionConfig }): Ruleset {
  const own = fromConfig(sub.permission ?? {});
  return [
    ...parent.filter((r) => r.action === "deny"),
    ...own,
    // 没自己声明 delegate 的一律禁委派。`own` 里没有 delegate 规则才算"没声明"。
    ...(own.some((r) => match("delegate", r.permission))
      ? []
      : [{ permission: "delegate", pattern: "*", action: "deny" as const }]),
  ];
}

/**
 * 从可见工具里剔除被 `deny *` 盖住的——那些是"这个模式下**没有**这个工具"，不是"有但会被拒"：
 * 前者不占上下文、也不会诱导模型去试。带具体 pattern 的 deny 不隐藏工具（那是"这一类里有一个例外"）。
 */
export function visibleTools<T extends { permission?: PermissionName }>(tools: T[], ...rulesets: Ruleset[]): T[] {
  return tools.filter((t) => !t.permission || evaluate(t.permission, "*", ...rulesets).action !== "deny");
}
