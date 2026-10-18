/**
 * ask_broker：主进程里的提问等待表——截止时间、暂停/恢复/稍后、回答与 stale 判定。
 *
 * 从 Electron 主进程里抽出来，是为了能离线测：注入时钟与事件出口，不起窗口、不调模型。
 * 它只管“这道题还在不在等、什么时候该转 pending”；迟到的答案落在哪个 Session、要不要排队，
 * 是主进程与 session 的事，不在这里。
 */
import type { AskOutcome, AskQuestion, AskRequest } from "../../../src/core/types";
import { validateAnswers } from "../../../src/session/asks";
import type { AskPendingReason, AskReply, AskView } from "../shared/api";

export interface AskBrokerDeps {
  /** 发给渲染层；没有窗口时调用方仍可调用，发送端自己吞掉 */
  send: (view: AskView) => void;
  sendPending: (p: { callId: string; reason: AskPendingReason }) => void;
  /** 现在有没有能回答的人；false 时 wait 立即 cancelled（fail closed） */
  canAsk: () => boolean;
  /** 测试注入点；缺省用真实时间与 setTimeout */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

interface Entry {
  callId: string;
  questions: AskQuestion[];
  resolve: (o: AskOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  deadline?: number;
  remainingMs?: number;
  paused: boolean;
  held: boolean;
}

export interface AskBroker {
  /** 开始等待；返回 answered / pending / cancelled */
  wait(req: AskRequest): Promise<AskOutcome>;
  /** 同一回合的回答：answered / invalid / not-waiting（已 pending，交给调用方走新回合） */
  answer(reply: AskReply): "answered" | "invalid" | "not-waiting";
  /** pause / resume / hold / defer；false = 这个 callId 已经不在这里等了 */
  hold(callId: string, mode: "pause" | "resume" | "hold" | "defer"): boolean;
  /** 重开/刷新时的当前视图；只覆盖仍在等的这一条 */
  view(callId: string): AskView | undefined;
  /** 会话切换 / 窗口关闭：全部转 pending（问题仍可回答），不是取消 */
  pendingAll(reason: AskPendingReason): void;
  size(): number;
}

export function createAskBroker(deps: AskBrokerDeps): AskBroker {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const entries = new Map<string, Entry>();

  function clear(entry: Entry): void {
    if (entry.timer !== undefined) clearTimer(entry.timer);
    entry.timer = undefined;
  }

  function arm(entry: Entry, ms: number): void {
    clear(entry);
    entry.remainingMs = Math.max(0, ms);
    entry.deadline = now() + entry.remainingMs;
    entry.timer = setTimer(() => settle(entry, "timeout"), entry.remainingMs);
  }

  /**
   * 转 pending：resolve 让工具 halt，事件让卡片翻状态。重复调用是安全的——
   * 信号中止与会话切换可能同时走到这里。
   */
  function settle(entry: Entry, reason: AskPendingReason): void {
    if (entries.get(entry.callId) !== entry) return;
    entries.delete(entry.callId);
    clear(entry);
    entry.resolve({ kind: "pending", callId: entry.callId });
    deps.sendPending({ callId: entry.callId, reason });
  }

  function pause(entry: Entry): void {
    if (entry.held || entry.paused || entry.deadline === undefined) return;
    entry.remainingMs = Math.max(0, entry.deadline - now());
    clear(entry);
    entry.deadline = undefined;
    entry.paused = true;
  }

  function resume(entry: Entry): void {
    if (entry.held || !entry.paused || entry.remainingMs === undefined) return;
    const ms = entry.remainingMs;
    entry.paused = false;
    entry.remainingMs = undefined;
    arm(entry, ms);
  }

  function hold(entry: Entry): void {
    clear(entry);
    entry.held = true;
    entry.paused = false;
    entry.deadline = undefined;
    entry.remainingMs = undefined;
  }

  async function wait(req: AskRequest): Promise<AskOutcome> {
    // 没有窗口 = 没有回答方。提问必须 fail closed，不能挂死。
    if (!deps.canAsk() || req.signal?.aborted === true) {
      return { kind: "cancelled", reason: "no-answerer" };
    }
    return new Promise<AskOutcome>((resolve) => {
      const previous = entries.get(req.callId);
      if (previous !== undefined) settle(previous, "interrupted");
      const entry: Entry = {
        callId: req.callId,
        questions: req.questions,
        resolve,
        paused: false,
        held: false,
      };
      entries.set(entry.callId, entry);
      if (req.timeoutMs !== undefined) arm(entry, req.timeoutMs);
      // 中止不是取消：问题转 pending，用户回来还能答
      req.signal?.addEventListener("abort", () => settle(entry, "interrupted"), { once: true });
      deps.send({
        callId: entry.callId,
        questions: entry.questions,
        ...(entry.deadline === undefined ? {} : { deadline: entry.deadline }),
        pending: false,
      });
    });
  }

  function answer(reply: AskReply): "answered" | "invalid" | "not-waiting" {
    const entry = entries.get(reply.callId);
    if (entry === undefined) return "not-waiting";
    if (validateAnswers(entry.questions, reply.answers) !== undefined) return "invalid";
    entries.delete(reply.callId);
    clear(entry);
    entry.resolve({ kind: "answered", answers: reply.answers });
    return "answered";
  }

  function holdOrDefer(callId: string, mode: "pause" | "resume" | "hold" | "defer"): boolean {
    const entry = entries.get(callId);
    if (entry === undefined) return false;
    if (mode === "pause") pause(entry);
    else if (mode === "resume") resume(entry);
    else if (mode === "hold") hold(entry);
    else settle(entry, "deferred");
    return true;
  }

  function view(callId: string): AskView | undefined {
    const entry = entries.get(callId);
    if (entry === undefined) return undefined;
    return {
      callId: entry.callId,
      questions: entry.questions,
      ...(entry.deadline === undefined ? {} : { deadline: entry.deadline }),
      pending: false,
    };
  }

  function pendingAll(reason: AskPendingReason): void {
    for (const entry of [...entries.values()]) settle(entry, reason);
  }

  return {
    wait,
    answer,
    hold: holdOrDefer,
    view,
    pendingAll,
    size: () => entries.size,
  };
}
