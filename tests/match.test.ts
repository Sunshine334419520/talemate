/**
 * match 的离线测试：九级回退阶梯、唯一性判据、跨度不成比例的兜底。
 * 运行：bun test
 *
 * 这一层是纯函数，测试直接钉**命中级别**——级别错了说明阶梯顺序被人动过，
 * 而那会让"该精确的时候模糊"，比功能坏掉更难发现。
 */
import { describe, test, expect } from "bun:test";
import { applyReplace } from "../src/framework/match";

/** 取一次成功替换的结果；失败则把 output 抛出来当断言信息（省得每处都判 ok）。 */
function replaced(content: string, find: string, replace: string, all = false) {
  const r = applyReplace(content, find, replace, all);
  if (!r.ok) throw new Error(`预期命中，却失败了：${r.output}`);
  return r;
}

function failure(content: string, find: string, replace = "X") {
  const r = applyReplace(content, find, replace);
  if (r.ok) throw new Error(`预期拒绝，却命中了：${JSON.stringify(r.matched)}`);
  return r.output;
}

describe("match · 回退阶梯", () => {
  test("每一级各治一种偏差，且都报出自己是哪一级", () => {
    const cases: { name: string; content: string; find: string; level: string }[] = [
      {
        name: "原样命中",
        content: "第一段\n第二段\n",
        find: "第二段",
        level: "exact",
      },
      {
        name: "行首缩进被吃掉",
        content: "  const a = 1\n  const b = 2\n",
        find: "const a = 1\nconst b = 2",
        level: "line-trimmed",
      },
      {
        // 中间行只差一个字：line-trimmed 逐行比**过不去**，block-anchor 靠首末行当锚 + 相似度接住。
        // 差得太远（比如整句换掉）连它也接不住——那正是 context 那一格的活。
        name: "中间行被改写措辞（首末行当锚）",
        content: "他推开门。\n屋里很暗，只有一盏灯。\n她坐在窗边。\n",
        find: "他推开门。\n屋里很暗，只有两盏灯。\n她坐在窗边。",
        level: "block-anchor",
      },
      {
        name: "空白串被折叠",
        content: "他   推开   门。\n",
        find: "他 推开 门。",
        level: "whitespace",
      },
      {
        name: "把换行写成了字面的 \\n",
        content: "上句\n下句\n",
        find: "上句\\n下句",
        level: "escape",
      },
      {
        name: "整段首尾多了空白",
        content: "荒岛求生记\n第二行\n",
        find: "\n荒岛求生记\n第二行\n   ",
        level: "boundary",
      },
      {
        // 用转义写死：这一级**只**认引号/破折号/省略号那类"同一个字的两种合法写法"，
        // 不认全角半角标点（见 match.ts 的注释）。写成字面量很容易顺手带上一个 `：`/`:` 的差异，
        // 那样测的就不是引号那一级了——下面那半个断言专门钉这一点。
        name: "中文弯引号 vs 模型写的直引号",
        content: "他说：“我要回去。”\n然后就走了。\n",
        find: '他说："我要回去。"',
        level: "unicode",
      },
      {
        // 中间两行只有一行对得上、另一行差得远：block-anchor 的**平均相似度**会掉到 0.65 以下，
        // 而 context 只要求**过半的中间行逐字相等**，于是刚好被它接住。这是两级的唯一分界。
        name: "中间多行只有一半逐字对得上",
        content: "他推开门。\n黑得伸手不见五指。\n桌子是空的。\n她坐在窗边。\n",
        find: "他推开门。\n屋子是暗的。\n桌子是空的。\n她坐在窗边。",
        level: "context",
      },
    ];

    const wrong = cases
      .map((c) => {
        try {
          const r = replaced(c.content, c.find, "【替换】");
          return r.level === c.level ? undefined : `${c.name}：预期 ${c.level}，实际 ${r.level}`;
        } catch (e) {
          return `${c.name}：${e instanceof Error ? e.message : String(e)}`;
        }
      })
      .filter((x): x is string => x !== undefined);
    expect(wrong).toEqual([]);
  });

  test("命中的是文件里的真实文本（弯引号那次换掉的是弯引号那段）", () => {
    const r = replaced("他说：“我要回去。”\n", '他说："我要回去。"', "他沉默了。");
    expect(r.matched).toContain("“"); // 换掉的是原文那一段，不是模型给的那一串
    expect(r.content).toBe("他沉默了。\n");
  });

  test("全角半角标点**不**归一——敲错标点就该撞「找不到」", () => {
    // 反过来的守卫：如果哪天有人把全角标点也并进 unicode 级，这条会红。
    const out = failure("他说：“我要回去。”\n", '他说:"我要回去."');
    expect(out).toContain("找不到");
  });

  test("替换值里的 `$` 是字面量（不是 replace 的替换模式）", () => {
    // 字符串形式的替换值里 $&、$1 有含义；正文里出现 `$` 会被悄悄展开。
    const r = replaced("第一行\n第二行\n", "第一行", "$&$1$'");
    expect(r.content).toBe("$&$1$'\n第二行\n");
  });
});

describe("match · 唯一性由工具判", () => {
  test("多处命中且没开 all → 拒绝，并要模型补上下文", () => {
    const out = failure("沈越走了。\n林晚留下。\n沈越走了。\n", "沈越走了。");
    expect(out).toContain("多处命中");
  });

  test("补上上下文变唯一 → 放行", () => {
    const r = replaced("沈越走了。\n林晚留下。\n沈越走了。\n", "林晚留下。\n沈越走了。", "两人都走了。");
    expect(r.count).toBe(1);
    expect(r.content).toBe("沈越走了。\n两人都走了。\n");
  });

  test("all=true → 每一处都换，并报出换了几处", () => {
    const r = replaced("沈越走了。\n林晚留下。\n沈越走了。\n", "沈越走了。", "他走了。", true);
    expect(r.count).toBe(2);
    expect(r.content).toBe("他走了。\n林晚留下。\n他走了。\n");
  });

  test("找不到 → 拒绝文案说清是「找不到」而不是「不唯一」", () => {
    const out = failure("第一段\n第二段\n", "第三段");
    expect(out).toContain("找不到");
    expect(out).not.toContain("多处命中");
  });
});

describe("match · 跨度不成比例就拒绝", () => {
  test("命中比 find 大太多（行数一样、内容长得多）→ 拒绝", () => {
    // context 级只比行数与相似度、**不比行有多长**：4 行短句能对上 4 行里塞了长段落的一块。
    // 只查行数的判据会漏掉这一类，所以要有一条按字符数的。
    const long = "屋".repeat(600);
    const out = failure(`他推开门。\n${long}\n桌子是空的。\n她坐在窗边。\n`, "他推开门。\n屋子是暗的。\n桌子是空的。\n她坐在窗边。");
    expect(out).toContain("大太多");
  });

  test("字面 \\n 展开成多行**不算**失控——那正是模型要的", () => {
    // 唯一的例外：escape 级本来就是把 `\n` 展开。拿原始 find 当基准会误杀。
    const r = replaced("甲\n乙\n丙\n丁\n戊\n", "甲\\n乙\\n丙\\n丁\\n戊", "换了");
    expect(r.level).toBe("escape");
    expect(r.content).toBe("换了\n");
  });
});

describe("match · 入参守卫", () => {
  test("find 为空 → 拒绝并指向 write / append", () => {
    expect(failure("随便什么\n", "")).toContain("append");
  });

  test("find 与 replace 相同 → 拒绝", () => {
    expect(failure("第一段\n", "第一段", "第一段")).toContain("没有改动");
  });
});
