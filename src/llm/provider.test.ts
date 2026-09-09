/**
 * 离线测试：safeParseArgs 的容错解析（不联网）。
 * 回归：DeepSeek/openai 兼容模型偶尔返回不规范的 tool arguments JSON——套围栏、字符串内
 * 未转义换行、尾逗号、双层转义。之前解析失败会产出 { _raw }，导致 ask-user.question = undefined。
 */
import { describe, test, expect } from "bun:test";
import { safeParseArgs } from "./provider";

describe("safeParseArgs（tool arguments 容错解析）", () => {
  test("合法对象直接解析", () => {
    expect(safeParseArgs('{"question":"你好","options":["a"]}')).toEqual({ question: "你好", options: ["a"] });
  });

  test("套代码围栏也能解析", () => {
    const s = '```json\n{"question":"x"}\n```';
    expect(safeParseArgs(s)).toEqual({ question: "x" });
  });

  test("字符串值内含未转义换行 → 修补后保留换行（不再失败）", () => {
    const s = '{"question":"那10天\n规则呢"}'; // \n 是裸换行，非 \\n
    expect(safeParseArgs(s)).toEqual({ question: "那10天\n规则呢" });
  });

  test("尾逗号 → 修补后解析", () => {
    expect(safeParseArgs('{"question":"x","numResults":3,}')).toEqual({ question: "x", numResults: 3 });
  });

  test("双层转义（arguments 是一段 JSON 字符串字面量）→ 解开一层", () => {
    const raw = JSON.stringify('{"question":"x"}');
    expect(safeParseArgs(raw)).toEqual({ question: "x" });
  });

  test("空 / 非对象 → 回退 {}（不再产出 _raw）", () => {
    expect(safeParseArgs("")).toEqual({});
    expect(safeParseArgs("42")).toEqual({});
    expect(safeParseArgs("乱码 hello")).toEqual({});
    expect(Object.hasOwn(safeParseArgs("乱码 hello"), "_raw")).toBe(false);
  });
});
