/**
 * Layer：四层的**显示名与顺序**。
 *
 * 这里只有两件事：`id`（键）与 `title`（给人看的短名）。**路径不在这里**——层的路径是
 * `design_spec.ts` 的事（`DESIGN_SPECS[id].file`），一处定义。
 *
 * 曾经这里还带 `file` 与 `blurb` 两个字段：`file` 与 `DESIGN_SPECS` 的四条完全相同（副本，
 * 且没有任何代码读它），`blurb` 从头到尾没人读过。两个都已删除——层该是什么，看
 * `docs/design-docs.md`；层往哪写，看 `DESIGN_SPECS`。
 *
 * 结构规范（每层该有哪些小节）见 design_spec.ts，按需取（懒建）；目标文档平时不存在。
 */
export type LayerId = "core" | "world" | "characters" | "outline";

export interface Layer {
  id: LayerId;
  title: string; // 短名，给用户看（DESIGN_SPECS 里的是带说明的长名）
}

/** 四层元信息（排序 = 依赖序：core 最先，outline 最后）。 */
export const LAYERS: Layer[] = [
  { id: "core", title: "核心层" },
  { id: "world", title: "世界层" },
  { id: "characters", title: "人物层" },
  { id: "outline", title: "情节层" },
];

/**
 * 常驻注入 editor 的文档（core + world 总纲），见 framework/anchor buildResidentDesigns。
 * 条目标的是**层**；具体路径由 `DESIGN_SPECS[id].file` 给（`tests/layers.test.ts` 钉住这条对应）。
 */
export const RESIDENT_LAYERS: LayerId[] = ["core", "world"];
