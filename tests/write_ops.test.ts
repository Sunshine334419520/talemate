/**
 * write_ops 的离线测试：唯一那条写盘路径的**全部出口条件**，以及它替调用方办掉的三件事
 * ——CAS、原子写、BOM/行尾的适配。
 * 运行：bun test
 *
 * 这一层是本次重构的落点，所以测试按"**不变量**"写，不按实现写：
 * 拒绝时盘上必须一个字节都没动、文件原有的 BOM 与行尾必须原样、模型给的片段要能对上
 * 与它行尾写法不同的文件。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, readDesign, writeDesign } from "../src/storage/project";
import { projectPaths } from "../src/core/config";
import { writeFile, type WriteRequest } from "../src/framework/write_ops";
import { PLAN_KEY, type PendingProposal, type ToolContext } from "../src/core/types";

let HOME: string;
let pid: string;

beforeAll(async () => {
  HOME = await mkdtemp(join(tmpdir(), "talemate-write-"));
  process.env.TALEMATE_HOME = HOME;
  pid = (await createProject({ title: "写入路径测试" })).id;
});

afterAll(async () => {
  await rm(HOME, { recursive: true, force: true });
});

const designAbs = (name: string) => join(projectPaths(HOME, pid).design, name);
const chaptersAbs = (name: string) => join(projectPaths(HOME, pid).chapters, name);

/** 只实现 writeFile 真正用得到的那几项；`ask` 的答复可切。 */
function makeCtx(): ToolContext & { setAsk(v: "allow" | "reject" | "deny"): void; pending: Map<string, PendingProposal> } {
  let answer: "allow" | "reject" | "deny" = "allow";
  const pending = new Map<string, PendingProposal>();
  return {
    projectId: pid,
    sessionId: "t",
    agent: "mate",
    signal: new AbortController().signal,
    confirm: async () => "once",
    check: () => "ask",
    ask: async () => answer,
    askUser: async () => "",
    showProposal: () => {},
    getProposal: (k) => pending.get(k),
    setProposal: (p) => {
      pending.set(p.name, p);
    },
    clearProposal: (k) => {
      pending.delete(k);
    },
    setMode: () => {},
    getMode: () => undefined,
    readDesign: () => Promise.resolve(undefined),
    listDesigns: () => Promise.resolve(""),
    listDesignPaths: () => Promise.resolve([]),
    searchDesigns: () => Promise.resolve(""),
    listChapters: () => Promise.resolve(""),
    runSubagent: () => Promise.resolve(""),
    loadSkill: () => Promise.resolve(undefined),
    setAsk: (v) => {
      answer = v;
    },
    pending,
  };
}

const confirm = (op: WriteRequest extends { via: "confirm"; op: infer O } ? O : never, action = "测试写入"): WriteRequest => ({
  via: "confirm",
  op,
  action,
});

describe("write_ops · 直写（二向）", () => {
  test("新建：文件出现，isNew 为真", async () => {
    const ctx = makeCtx();
    const r = await writeFile(ctx, confirm({ kind: "write", path: "design/core.md", content: "# 核心\n" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.isNew).toBe(true);
    expect(await readDesign(pid, "core.md")).toBe("# 核心\n");
  });

  test("覆盖：整篇换掉，isNew 为假", async () => {
    await writeDesign(pid, "core.md", "旧的\n");
    const ctx = makeCtx();
    const r = await writeFile(ctx, confirm({ kind: "write", path: "design/core.md", content: "新的\n" }));
    expect(r.ok && r.isNew).toBe(false);
    expect(await readDesign(pid, "core.md")).toBe("新的\n");
  });

  test("用户拒绝 → **盘上一个字节都没动**", async () => {
    await writeDesign(pid, "core.md", "原样\n");
    const ctx = makeCtx();
    ctx.setAsk("reject");
    const r = await writeFile(ctx, confirm({ kind: "write", path: "design/core.md", content: "不许写\n" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rejected");
    expect(await readDesign(pid, "core.md")).toBe("原样\n");
  });

  test("规则表不许 → 同样一个字节都没动", async () => {
    await writeDesign(pid, "core.md", "原样\n");
    const ctx = makeCtx();
    ctx.setAsk("deny");
    const r = await writeFile(ctx, confirm({ kind: "write", path: "design/core.md", content: "不许写\n" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("denied");
    expect(await readDesign(pid, "core.md")).toBe("原样\n");
  });

  test("chapters/ 与 design/ 都写得进去（同一个根口径）", async () => {
    const ctx = makeCtx();
    const r = await writeFile(ctx, confirm({ kind: "write", path: "chapters/chapter_ch1_v1.md", content: "正文\n" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("chapters/chapter_ch1_v1.md");
  });

  test("根不对 / 想穿目录 → 拒绝，且文案说清可写的根有哪些", async () => {
    const ctx = makeCtx();
    const bad = await writeFile(ctx, confirm({ kind: "write", path: "AGENTS.md", content: "x" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.output).toContain("design");

    const escape = await writeFile(ctx, confirm({ kind: "write", path: "design/../AGENTS.md", content: "x" }));
    expect(escape.ok).toBe(false);
  });

  test("replace 找不到锚点 → 拒绝文案来自匹配层，且没写盘", async () => {
    await writeDesign(pid, "core.md", "有的别的\n");
    const ctx = makeCtx();
    const r = await writeFile(
      ctx,
      confirm({ kind: "replace", path: "design/core.md", find: "没有这句", replace: "x" }),
    );
    expect(r.ok).toBe(false);
    expect(await readDesign(pid, "core.md")).toBe("有的别的\n");
  });
});

describe("write_ops · CAS：读之后被改过就不写", () => {
  test("读取与落盘之间文件变了 → stale，且那次改动没被盖掉", async () => {
    await writeDesign(pid, "core.md", "我读到的是这一份\n");
    const ctx = makeCtx();
    // 用 ask 的时机模拟"弹窗期间用户手改"：writeFile 在问完之后才落盘
    const realAsk = ctx.ask;
    ctx.ask = async (req) => {
      await writeDesign(pid, "core.md", "被人改过了\n");
      return realAsk(req);
    };
    const r = await writeFile(ctx, confirm({ kind: "write", path: "design/core.md", content: "照着旧内容写\n" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale");
    expect(await readDesign(pid, "core.md")).toBe("被人改过了\n");
  });
});

describe("write_ops · 行尾适配", () => {
  test("文件是 CRLF、模型给 \\n —— 对得上，且**其余行仍是 CRLF**", async () => {
    await writeDesign(pid, "core.md", "甲\r\n乙\r\n丙\r\n");
    const ctx = makeCtx();
    const r = await writeFile(
      ctx,
      confirm({ kind: "replace", path: "design/core.md", find: "乙\n丙", replace: "乙\n新丙" }),
    );
    expect(r.ok).toBe(true);
    // 只动了该动的那两行，别处的 CRLF 一个字节没变
    expect(await readDesign(pid, "core.md")).toBe("甲\r\n乙\r\n新丙\r\n");
  });

  test("追加：接缝跟着文件的写法，不产生两种行尾混着", async () => {
    await writeDesign(pid, "wiki/world.md", "## 一\r\n甲\r\n");
    const ctx = makeCtx();
    const r = await writeFile(
      ctx,
      confirm({ kind: "append", path: "design/wiki/world.md", block: "## 二\n乙" }),
    );
    expect(r.ok).toBe(true);
    const text = (await readDesign(pid, "wiki/world.md")) ?? "";
    expect(text).toBe("## 一\r\n甲\r\n\r\n## 二\r\n乙\r\n");
    // 没有孤零零的 \n 混在 CRLF 里
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("diff 不把行尾差异算成改动（CRLF 文件只改一行 → 只报一行）", async () => {
    await writeDesign(pid, "core.md", "甲\r\n乙\r\n丙\r\n");
    const ctx = makeCtx();
    const r = await writeFile(
      ctx,
      confirm({ kind: "replace", path: "design/core.md", find: "乙", replace: "新乙" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([r.additions, r.deletions]).toEqual([1, 1]); // 不是 3/3
      expect(r.diff).not.toContain("\r");
    }
  });
});

describe("write_ops · BOM 是文件自己的属性", () => {
  const BOM = "﻿";

  test("原有 BOM 保住：模型看不出它，也不会把它抹掉", async () => {
    await writeDesign(pid, "core.md", `${BOM}# 核心\n`);
    const ctx = makeCtx();
    const r = await writeFile(
      ctx,
      confirm({ kind: "replace", path: "design/core.md", find: "# 核心", replace: "# 核心（改）" }),
    );
    expect(r.ok).toBe(true);
    expect(await readDesign(pid, "core.md")).toBe(`${BOM}# 核心（改）\n`);
  });

  test("模型给的 find 里没有那个不可见字符，照样命中", async () => {
    await writeDesign(pid, "core.md", `${BOM}一句话简介\n`);
    const ctx = makeCtx();
    const r = await writeFile(
      ctx,
      confirm({ kind: "replace", path: "design/core.md", find: "一句话简介", replace: "简介" }),
    );
    expect(r.ok).toBe(true); // 匹配按"没有 BOM 的正文"算，所以那个字符不会挡路
  });

  test("原本没有 BOM、模型显式带了一个 → 采用；不带 → 不加", async () => {
    const ctx = makeCtx();
    await writeDesign(pid, "a.md", "旧\n");
    await writeFile(ctx, confirm({ kind: "write", path: "design/a.md", content: `${BOM}带 BOM\n` }));
    expect(await readDesign(pid, "a.md")).toBe(`${BOM}带 BOM\n`);

    await writeDesign(pid, "b.md", "旧\n");
    await writeFile(ctx, confirm({ kind: "write", path: "design/b.md", content: "不带\n" }));
    expect(await readDesign(pid, "b.md")).toBe("不带\n");
  });

  test("模型带了两个 BOM 也只留一个（先摘再装）", async () => {
    const ctx = makeCtx();
    await writeFile(ctx, confirm({ kind: "write", path: "design/c.md", content: `${BOM}${BOM}x\n` }));
    expect(await readDesign(pid, "c.md")).toBe(`${BOM}x\n`);
  });
});

describe("write_ops · 落提案（三向）", () => {
  // 每个用例一个**独立文件名**：提案带 `base` 快照（`null` = "提案时它还不存在"），
  // 复用同一个名字会让前一个用例写下的字节把后一个判成陈旧——测的就不是它想测的那件事了。
  const proposal = (name: string, over: Partial<PendingProposal> = {}): PendingProposal => ({
    name,
    content: "提案那一版\n",
    base: null,
    approved: true,
    at: 1,
    ...over,
  });

  test("op **只从提案取**——调用方给不了正文（这就是夹带不了的原因）", async () => {
    const ctx = makeCtx();
    ctx.setProposal(proposal("prop-a.md"));
    const r = await writeFile(ctx, { via: "pending", proposalKey: "prop-a.md", action: "落盘" });
    expect(r.ok).toBe(true);
    expect(await readDesign(pid, "prop-a.md")).toBe("提案那一版\n");
  });

  test("没有提案 → 拒绝，并指路 propose-design", async () => {
    const ctx = makeCtx();
    const r = await writeFile(ctx, { via: "pending", proposalKey: "没有的.md", action: "落盘" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("notapproved");
      expect(r.output).toContain("propose-design");
    }
  });

  test("用户还没同意 → 拒绝，什么都不写", async () => {
    const ctx = makeCtx();
    ctx.setProposal(proposal("prop-b.md", { approved: false }));
    const r = await writeFile(ctx, { via: "pending", proposalKey: "prop-b.md", action: "落盘" });
    expect(r.ok).toBe(false);
    expect(await readDesign(pid, "prop-b.md")).toBeUndefined();
  });

  test("节拍提案（没有目标文件）→ 拒绝，并说清它不解锁落盘", async () => {
    const ctx = makeCtx();
    ctx.setProposal(proposal(PLAN_KEY, { content: "节拍" }));
    const r = await writeFile(ctx, { via: "pending", proposalKey: PLAN_KEY, action: "落盘" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.output).toContain("不落盘");
  });

  test("CAS 用**提案时那份快照**：文件在提案之后被改过 → stale", async () => {
    await writeDesign(pid, "prop-c.md", "提案时是这一份\n");
    const ctx = makeCtx();
    ctx.setProposal(proposal("prop-c.md", { base: "提案时是这一份\n" }));
    await writeDesign(pid, "prop-c.md", "提案之后被改了\n");
    const r = await writeFile(ctx, { via: "pending", proposalKey: "prop-c.md", action: "落盘" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale");
    expect(await readDesign(pid, "prop-c.md")).toBe("提案之后被改了\n");
  });

  test("落提案**不再弹窗**（用户已在提案那轮看过），但仍然过规则表", async () => {
    const ctx = makeCtx();
    ctx.setProposal(proposal("prop-d.md"));
    let asked = 0;
    ctx.ask = async () => {
      asked++;
      return "allow";
    };
    const r = await writeFile(ctx, { via: "pending", proposalKey: "prop-d.md", action: "落盘" });
    expect(r.ok).toBe(true);
    expect(asked).toBe(0);

    // 规则表说"不许"时不因为问过一次就失效
    const ctx2 = makeCtx();
    ctx2.setProposal(proposal("prop-e.md"));
    ctx2.check = () => "deny";
    const denied = await writeFile(ctx2, { via: "pending", proposalKey: "prop-e.md", action: "落盘" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("denied");
    expect(await readDesign(pid, "prop-e.md")).toBeUndefined();
  });
});

describe("write_ops · 删除", () => {
  test("删得掉，且 diff 里看得到被删的内容", async () => {
    await writeDesign(pid, "characters/林晚.md", "卡的字节\n");
    const ctx = makeCtx();
    const r = await writeFile(ctx, confirm({ kind: "delete", path: "design/characters/林晚.md" }, "删除角色卡"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.diff).toContain("卡的字节");
    expect(await readDesign(pid, "characters/林晚.md")).toBeUndefined();
  });
});

describe("write_ops · 原子写", () => {
  test("落完盘不留临时文件", async () => {
    const ctx = makeCtx();
    await writeFile(ctx, confirm({ kind: "write", path: "design/tmp-check.md", content: "x\n" }));
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(projectPaths(HOME, pid).design);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  test("chapters/ 也建得出来（目录不存在时）", async () => {
    const ctx = makeCtx();
    const r = await writeFile(
      ctx,
      confirm({ kind: "write", path: "chapters/sub/deep.md", content: "深一层\n" }),
    );
    expect(r.ok).toBe(true);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(chaptersAbs("sub/deep.md"), "utf-8")).toBe("深一层\n");
  });
});
