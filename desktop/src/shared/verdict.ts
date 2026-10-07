/**
 * 三向裁决的固定短语：界面上的按钮不自己判断，只替用户说出这句话。
 *
 * 判定归 harness 的 `session.draftVerdict`（那套"整句只由这些词构成才算数"的词表，fail-closed），
 * 交付层只决定怎么问——CLI 让用户打字，界面给几个按钮、把对应那句话发出去，所以这里只说词。
 * `tests/verdict.test.ts` 钉着这些短语分别落成 accept / reject / refine，词表改了而这里没跟上，
 * 那条测试会红；"提意见"没有固定短语，它就是用户自己写的那段话（唯一需要输入框的一个）。
 */
export const VERDICT_TEXT = {
  accept: "没问题",
  reject: "不行",
} as const;
