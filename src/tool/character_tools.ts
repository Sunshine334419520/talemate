/**
 * character-tools：角色卡领域工具。
 *
 * **只剩 remove-character 一个。** add-character / update-character / character-brief 已于
 * 2026-09-19 删除——理由是角色卡的三条写入契约（静默写盘 / confirm 对话框 / 两段式提案）
 * 必须收敛成一条：
 *
 *   创建与修改角色卡 → `propose-design` 带 `name:"characters/<名>.md"`（两段式，用户看过才落盘）
 *   → `apply-design`。改单格用 `section`；卡上的格就是 `###` 标题，本来就能按标题寻址。
 *
 * 删除后消失的东西：`buildCardBody` 的构造性骨架（改由 design_tools 的 `cardSkeletonError` 强制
 * "整篇提案必须带齐必有五格"）、按 key 寻址的入参（改按标题）、以及"两条落卡入口骨架保证必须一致"
 * 这条补丁——不再有两条入口。按需格与工具托管的「当前」也一并从 schema 删除（见 characters.ts）。
 *
 * remove-character 留下，是因为它的引用检查（searchDesigns）与 `drop` op 是通用通道没有的
 * 领域逻辑。写盘仍是薄壳：校验 / confirm / 落盘都在 framework/design_ops.ts。
 *
 * 一角色一卡（design/characters/<名>.md）；**没有派生总表**，名单由 list-designs 现算。
 */
import { applyDesignOp } from "../framework/design_ops";
import { cardPath } from "../framework/characters";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** remove-character：删除角色卡（删前引用检查进 confirm）。 */
export const removeCharacterTool: RegisteredTool<{ name: string }> = defineTool<{ name: string }>({
  id: "remove-character",
  description: P("remove-character"),
  input: {
    type: "object",
    properties: { name: { type: "string", description: "Character name to delete" } },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = args.name.trim();
    const r = await applyDesignOp(ctx, {
      kind: "drop",
      name: cardPath(name),
      term: name,
      action: `删除角色卡「${name}」（design/characters/${name}.md）`,
      refScope: "含角色卡自身，请判断需否级联改 world/outline",
      notFound: `没有找到角色「${name}」。`,
    });
    if (!r.ok) return { output: r.output };
    return { output: `已删除角色「${name}」。` };
  },
});

export const CHARACTER_TOOLS: RegisteredTool[] = [removeCharacterTool];
