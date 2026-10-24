/**
 * `/` 命令表——一份数据，加一条命令就是加一行。
 *
 * **命令名与 CLI 同名同义**（`src/cli.ts` 的 `case "/<name>"`），界面上打出来的就是它们：
 * 同一条命令在两个外壳里叫两个名字，是最容易让人以为"这里有另一个功能"的烂法。
 * 说明那半给人看，所以是中文（与界面其余部分一致）。
 *
 * 只放诊断与全局状态，因为 CLI 那 15 条里其余的在这个界面上都有更好的入口（书架、会话列表、
 * 目录树、`@` 提及），再摆一遍就是同一件事两个入口。判断记在 `docs/ui.md` 的「乙」。
 *
 * 执行按 name 分派，在 `Workspace.tsx`——表的归表、行为的归行为，与 CLI 那个 switch 同形。
 */
export interface CommandSpec {
  /** 不带斜杠。与 CLI 一致，只用英文。 */
  name: string;
  /** 一句话说明：它做什么、输出落在哪。 */
  hint: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "status", hint: "四层现状：核心设定 / 世界观 / 角色 / 大纲" },
  { name: "permissions", hint: "当前规则表：每类动作是什么、是哪一层定的" },
  { name: "debug", hint: "当前会话的调试信息与存储路径（含 messages.jsonl）" },
];
