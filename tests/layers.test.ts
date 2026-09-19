/**
 * 层元信息的守卫：`tests/` 里唯一的"结构不变量"测试（其余都是行为测试）。
 *
 * 守的是一件事：**同一份事实只有一个家**。层的路径是 `DESIGN_SPECS[id].file`，别处的任何
 * 层列表都只能是**层的 id**，不能是路径的副本——这个仓库被"副本会脱节"烧过两次
 * （`characters/_index.md`、`design_spec.ts` 里手抄的字段清单）。
 */
import { describe, test, expect } from "bun:test";
import { LAYERS, RESIDENT_LAYERS, type LayerId } from "../src/framework/layers";
import { DESIGN_SPECS } from "../src/framework/design_spec";

describe("层元信息", () => {
  test("LAYERS 覆盖全部 LayerId，且顺序即依赖序", () => {
    expect(LAYERS.map((l) => l.id)).toEqual(["core", "world", "characters", "outline"]);
    expect(LAYERS.length).toBe(Object.keys(DESIGN_SPECS).length);
  });

  test("每层的规范登记都在（LAYERS 与 DESIGN_SPECS 不会各说各话）", () => {
    const missing = LAYERS.filter((l) => !DESIGN_SPECS[l.id as LayerId]);
    expect(missing.map((l) => l.id)).toEqual([]);
  });

  test("常驻表标的是层 id，不是路径的副本；每条都能解析成真实的层路径", () => {
    const bad = RESIDENT_LAYERS.filter((id) => !DESIGN_SPECS[id]?.file);
    expect(bad).toEqual([]);
    // 今天就是 core + world 两层；改了这里就该同时改 docs/design-docs.md 的"常驻只有两份"
    expect(RESIDENT_LAYERS).toEqual(["core", "world"]);
    expect(RESIDENT_LAYERS.map((id) => DESIGN_SPECS[id].file)).toEqual(["core.md", "wiki/world.md"]);
  });
});
