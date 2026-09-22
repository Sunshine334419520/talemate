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
 * 领域逻辑。写盘是薄壳：拼出 `FileOp` 交给 `framework/write_ops.ts`（唯一写路径）。
 *
 * 一角色一卡（design/characters/<名>.md）；**没有派生总表**，名单由 list-designs 现算。
 */
import { cardPath } from "../framework/characters";
import { writeFile } from "../framework/write_ops";
import { readPrompt } from "../prompts";
import { defineTool, type RegisteredTool } from "./define";

const P = (id: string) => readPrompt(`tools/${id}`);

/** remove-character：删除角色卡（删前引用检查进 confirm）。 */
export const removeCharacterTool: RegisteredTool<{ name: string }> = defineTool<{ name: string }>({
  id: "remove-character",
  description: P("remove-character"),
  permission: "edit",
  input: {
    type: "object",
    properties: { name: { type: "string", description: "Character name to delete" } },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = args.name.trim();
    // 领域逻辑只留在这一处：删前查引用，把影响面摆进 confirm——通用通道给不出这个。
    const refs = `引用检查「${name}」（含角色卡自身，请判断需否级联改 world/outline）：\n${await ctx.searchDesigns(name)}`;
    const r = await writeFile(ctx, {
      via: "confirm",
      op: { kind: "delete", path: `design/${cardPath(name)}` },
      action: `删除角色卡「${name}」`,
      note: refs,
    });
    if (!r.ok) {
      // 文案由调用方给：管线那句是通用的（"没有找到 <路径>，无法删除"），
      // 而对模型来说"没有找到角色「X」"才是能自愈的那句（名字敲错了）。
      return { output: r.reason === "notfound" ? `没有找到角色「${name}」。` : r.output };
    }
    return { output: `已删除角色「${name}」。` };
  },
});

export const CHARACTER_TOOLS: RegisteredTool[] = [removeCharacterTool];
