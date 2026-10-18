/**
 * 主进程提问状态机的离线测试：假时钟 + 假事件出口，不起窗口、不调模型。
 *
 * 盯的是验收表里靠手动点的那几项：超时、暂停/恢复、稍后、重复回答、没有回答方、中断、
 * 重开视图。答案落到哪个 Session、要不要排队不在 broker 里，由 ask_session.test.ts 覆盖。
 */
import { describe, expect, test } from "bun:test";
import type { AskQuestion, AskRequest } from "../src/core/types";
import type { AskView } from "../desktop/src/shared/api";
import { createAskBroker } from "../desktop/src/main/ask_broker";

const QUESTIONS: AskQuestion[] = [
  {
    id: "q",
    question: "选哪个？",
    options: [{ label: "甲（推荐）" }, { label: "乙" }],
  },
];

function req(callId = "call-1", timeoutMs?: number, signal?: AbortSignal): AskRequest {
  return { callId, questions: QUESTIONS, timeoutMs, signal };
}

function makeClock() {
  let now = 0;
  let seq = 0;
  let timers: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const id = ++seq;
      timers.push({ id, at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (t: ReturnType<typeof setTimeout>): void => {
      const id = t as unknown as number;
      timers = timers.filter((x) => x.id !== id);
    },
    advance(ms: number): void {
      now += ms;
      const due = timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at || a.id - b.id);
      timers = timers.filter((x) => x.at > now);
      for (const t of due) t.fn();
    },
    pending: () => timers.length,
  };
}

function makeBroker(opts: { canAsk?: boolean } = {}) {
  const clock = makeClock();
  const views: AskView[] = [];
  const pendings: { callId: string; reason: string }[] = [];
  const broker = createAskBroker({
    send: (view) => views.push(view),
    sendPending: (p) => pendings.push({ callId: p.callId, reason: p.reason }),
    canAsk: () => opts.canAsk ?? true,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { broker, clock, views, pendings };
}

describe("ask broker · 超时与三态", () => {
  test("到点返回 pending；不是取消，也不是回答", async () => {
    const { broker, clock, views, pendings } = makeBroker();
    const p = broker.wait(req("c1", 1000));
    expect(broker.size()).toBe(1);
    expect(views[0].deadline).toBe(1000);

    clock.advance(999);
    let resolved: unknown;
    void p.then((v) => (resolved = v));
    await Promise.resolve();
    expect(resolved).toBeUndefined();

    clock.advance(1);
    expect(await p).toEqual({ kind: "pending", callId: "c1" });
    expect(pendings).toEqual([{ callId: "c1", reason: "timeout" }]);
    expect(broker.size()).toBe(0);
    expect(broker.view("c1")).toBeUndefined();
  });

  test("没有回答方：立即 cancelled（fail closed）", async () => {
    const { broker } = makeBroker({ canAsk: false });
    expect(await broker.wait(req("c1", 1000))).toEqual({
      kind: "cancelled",
      reason: "no-answerer",
    });
    expect(broker.size()).toBe(0);
  });

  test("不限时：没有 deadline，也不会自己转 pending", async () => {
    const { broker, clock } = makeBroker();
    const p = broker.wait(req("c1"));
    expect(broker.view("c1")?.deadline).toBeUndefined();
    clock.advance(10_000_000);
    expect(broker.size()).toBe(1);
    expect(broker.answer({ callId: "c1", answers: [{ id: "q", selected: ["乙"] }] })).toBe("answered");
    expect(await p).toEqual({ kind: "answered", answers: [{ id: "q", selected: ["乙"] }] });
  });
});

describe("ask broker · 回答与 stale", () => {
  test("合法回答 resolve answered；同一 callId 再答就是 not-waiting", async () => {
    const { broker, clock } = makeBroker();
    const p = broker.wait(req("c1", 1000));
    const answers = [{ id: "q", selected: ["甲（推荐）"] }];
    expect(broker.answer({ callId: "c1", answers })).toBe("answered");
    expect(await p).toEqual({ kind: "answered", answers });
    expect(clock.pending()).toBe(0);
    expect(broker.answer({ callId: "c1", answers })).toBe("not-waiting");
  });

  test("跳过 = selected 空数组，也是一次 answered", async () => {
    const { broker } = makeBroker();
    const p = broker.wait(req("c1", 1000));
    expect(broker.answer({ callId: "c1", answers: [{ id: "q", selected: [] }] })).toBe("answered");
    expect(await p).toEqual({ kind: "answered", answers: [{ id: "q", selected: [] }] });
  });

  test("非法 label：invalid，问题仍然等着", async () => {
    const { broker, clock } = makeBroker();
    const p = broker.wait(req("c1", 1000));
    expect(broker.answer({ callId: "c1", answers: [{ id: "q", selected: ["不存在"] }] })).toBe("invalid");
    expect(broker.size()).toBe(1);
    expect(broker.answer({ callId: "c1", answers: [{ id: "q", selected: ["乙"] }] })).toBe("answered");
    expect((await p).kind).toBe("answered");
    expect(clock.pending()).toBe(0);
  });
});

describe("ask broker · 暂停 / 慢慢回答 / 稍后", () => {
  test("暂停期间不计时；恢复后接着剩余时间走", async () => {
    const { broker, clock, pendings } = makeBroker();
    const p = broker.wait(req("c1", 1000));
    clock.advance(400);
    expect(broker.hold("c1", "pause")).toBe(true);
    expect(broker.view("c1")?.deadline).toBeUndefined();

    clock.advance(10_000);
    expect(broker.size()).toBe(1);
    expect(pendings).toEqual([]);

    expect(broker.hold("c1", "resume")).toBe(true);
    expect(broker.view("c1")?.deadline).toBe(400 + 10_000 + 600);
    clock.advance(599);
    expect(broker.size()).toBe(1);
    clock.advance(1);
    expect((await p).kind).toBe("pending");
  });

  test("慢慢回答 = 不限时；稍后 = 立即 pending", async () => {
    const { broker, clock, pendings } = makeBroker();
    const held = broker.wait(req("c1", 1000));
    expect(broker.hold("c1", "hold")).toBe(true);
    clock.advance(10_000_000);
    expect(broker.size()).toBe(1);
    expect(broker.answer({ callId: "c1", answers: [{ id: "q", selected: ["乙"] }] })).toBe("answered");
    expect((await held).kind).toBe("answered");

    const deferred = broker.wait(req("c2", 1000));
    expect(broker.hold("c2", "defer")).toBe(true);
    expect(await deferred).toEqual({ kind: "pending", callId: "c2" });
    expect(pendings.at(-1)).toEqual({ callId: "c2", reason: "deferred" });
  });

  test("未知 callId 的 hold 返回 false", () => {
    const { broker } = makeBroker();
    expect(broker.hold("nope", "pause")).toBe(false);
  });
});

describe("ask broker · 中断与批量收尾", () => {
  test("中止信号 = pending/interrupted，不是取消", async () => {
    const { broker, pendings } = makeBroker();
    const ctrl = new AbortController();
    const p = broker.wait(req("c1", 1000, ctrl.signal));
    ctrl.abort();
    expect(await p).toEqual({ kind: "pending", callId: "c1" });
    expect(pendings).toEqual([{ callId: "c1", reason: "interrupted" }]);
    expect(broker.size()).toBe(0);
  });

  test("pendingAll：全部转 pending，问题都还在（由 session 投影）", async () => {
    const { broker, pendings } = makeBroker();
    const a = broker.wait(req("a", 1000));
    const b = broker.wait(req("b", 1000));
    broker.pendingAll("interrupted");
    expect(await a).toEqual({ kind: "pending", callId: "a" });
    expect(await b).toEqual({ kind: "pending", callId: "b" });
    expect(broker.size()).toBe(0);
    expect(pendings.map((p) => p.reason)).toEqual(["interrupted", "interrupted"]);
  });

  test("同一 callId 重新等待会先把旧的转 pending，不留下一个永远不 resolve 的 Promise", async () => {
    const { broker } = makeBroker();
    const first = broker.wait(req("c1", 1000));
    const second = broker.wait(req("c1", 1000));
    expect(await first).toEqual({ kind: "pending", callId: "c1" });
    expect(broker.size()).toBe(1);
    broker.answer({ callId: "c1", answers: [{ id: "q", selected: ["乙"] }] });
    expect((await second).kind).toBe("answered");
  });
});
