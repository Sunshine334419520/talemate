/**
 * 界面上的三个按钮与 harness 那张词表之间的**契约**。
 *
 * 按钮不判断，它只是替用户说一句话："没问题" / "不行"，或者用户自己写的提意见。判定在 harness 里
 * （`session.draftVerdict`，整句只由词表里的词构成才算数——fail-closed）。这条测试盯的是**两份东西
 * 别走散**：词表那边删了一个词、这边没跟上，按钮就会静默失灵（发出去的话被当成"提意见"，提案不落盘
 * 也不作废，看起来像点了没反应）。
 */
import { describe, expect, test } from "bun:test";
import { VERDICT_TEXT } from "../desktop/src/shared/verdict";
import { draftVerdict } from "../src/session/session";

describe("交付层 · 三向按钮的短语", () => {
  test("按钮说的话，在 harness 那张词表里就是那两个结局", () => {
    const wrong = [
      draftVerdict(VERDICT_TEXT.accept) === "accept" ? undefined : `「${VERDICT_TEXT.accept}」不再算接受`,
      draftVerdict(VERDICT_TEXT.reject) === "reject" ? undefined : `「${VERDICT_TEXT.reject}」不再算拒绝`,
    ].filter((x): x is string => x !== undefined);
    expect(wrong).toEqual([]);
  });

  test("带改动要求的话不算同意——fail-closed 那条不变", () => {
    // 「没问题，但第 3 格改成 X」夹着改动要求：不能因为开头是"没问题"就落盘。
    expect(draftVerdict(`${VERDICT_TEXT.accept}，但第 3 格改成别的`)).toBe("refine");
  });
});
