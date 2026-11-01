/**
 * 回放的守卫：同一份请求必须得到同一个键；录制一次之后离线重放，不再调真实 provider；
 * 键对不上时大声失败，而不是静默换一个回应。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantTurn } from "../src/llm/types";
import type { ChatOpts } from "../src/llm/provider";
import { chatWithCassette, hashJson, readCassette, requestHash } from "../src/llm/replay";

let home: string;
let prevRecord: string | undefined;
let serial = 0;

function nextFile(): string {
  serial++;
  return join(home, `case-${serial}.jsonl`);
}

function opts(system = "system"): ChatOpts {
  return {
    model: { provider: "mock", model: "mock", maxTokens: 1000, reasoning: "off" },
    system,
    messages: [{ role: "user", text: "写第 1 章" }],
  };
}

const REPLY: AssistantTurn = {
  text: "第一章",
  reasoning: "先写场景",
  toolCalls: [{ id: "call-1", name: "write", input: { path: "chapters/ch1.md" } }],
  finish: "tool_calls",
  usage: { input: 10, output: 4 },
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "talemate-replay-"));
  prevRecord = process.env.TALEMATE_RECORD;
});

afterAll(async () => {
  if (prevRecord === undefined) delete process.env.TALEMATE_RECORD;
  else process.env.TALEMATE_RECORD = prevRecord;
  await rm(home, { recursive: true, force: true });
});

describe("回放 · 请求身份", () => {
  test("对象键序不影响 hash，system 变了 hash 就变", () => {
    expect(hashJson({ a: 1, b: [2, { d: 4, c: 3 }] })).toBe(hashJson({ b: [2, { c: 3, d: 4 }], a: 1 }));
    expect(requestHash(opts("a"))).not.toBe(requestHash(opts("b")));
  });

  test("只在 UUID 上不同的请求算同一个键（子会话 id 每次不同）", () => {
    const one: ChatOpts = {
      ...opts(),
      messages: [{ role: "tool", toolCallId: "c1", name: "task", output: 'session="31c122a9-9363-4fac-bd4f-a236d1f3a7ef"' }],
    };
    const two: ChatOpts = {
      ...opts(),
      messages: [{ role: "tool", toolCallId: "c1", name: "task", output: 'session="411864ed-245b-410e-800c-b7f7a80d5e79"' }],
    };
    expect(requestHash(one)).toBe(requestHash(two));
  });
});

describe("回放 · 录制与重放", () => {
  test("第一次录制，第二次走 cassette 不再调 direct，流式回调照发", async () => {
    const file = nextFile();
    let calls = 0;
    const direct = async (): Promise<AssistantTurn> => {
      calls++;
      return REPLY;
    };

    const usedFile = join(home, `used-${serial}.txt`);
    process.env.TALEMATE_RECORD = "1";
    process.env.TALEMATE_REPLAY_USED = usedFile;
    const first = await chatWithCassette(opts(), file, direct);
    expect(first).toEqual(REPLY);
    expect(calls).toBe(1);
    expect(await readCassette(file)).toHaveLength(1);

    delete process.env.TALEMATE_RECORD;
    const text: string[] = [];
    const started: string[] = [];
    const second = await chatWithCassette(
      {
        ...opts(),
        onText: (d) => text.push(d),
        onReasoning: (d) => text.push(`r:${d}`),
        onToolCallStart: (c) => started.push(c.name),
      },
      file,
      direct,
    );
    expect(second).toEqual(REPLY);
    expect(calls).toBe(1);
    expect(text).toEqual(["r:先写场景", "第一章"]);
    expect(started).toEqual(["write"]);
    // runner 靠这个文件挑出"这次 run 真正用到的第一条请求"来算 manifest
    expect((await readFile(usedFile, "utf-8")).trim().split("\n")).toHaveLength(2);
    delete process.env.TALEMATE_REPLAY_USED;
  });

  test("没录过又不在录制模式：明确失败，不编回应", async () => {
    const file = nextFile();
    delete process.env.TALEMATE_RECORD;
    await expect(chatWithCassette(opts("新的提示词"), file, async () => REPLY)).rejects.toThrow("replay miss");
  });

  test("cassette 是一行一条 JSON，含请求与回应", async () => {
    const file = nextFile();
    process.env.TALEMATE_RECORD = "1";
    await chatWithCassette(opts(), file, async () => REPLY);
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw.trim()) as { request: { system: string }; response: { text: string } };
    expect(parsed.request.system).toBe("system");
    expect(parsed.response.text).toBe("第一章");
  });
});
