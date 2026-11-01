/**
 * 回放：把一次真实模型请求的回应按**请求哈希**存进 cassette，离线重放。
 *
 * 为什么不是 mock：mock 只测接线，测不了"这个 prompt 在真实模型上是否更好"；而每次评测都调真实
 * 模型又贵又不可重复。cassette 记的是「同一份 system + messages + tools + 模型参数 → 同一个回应」，
 * 提示词一改就 miss，正好把"替换发生了没有"变成一条硬失败（P4）。
 *
 * 契约：
 * - `TALEMATE_REPLAY_FILE` 指向一个 JSONL；给了就走 cassette，没给就走真实 provider。
 * - `TALEMATE_RECORD=1` 时 miss 会调真实 provider 并追加；否则 miss 直接抛。
 * - 键不含 apiKey、signal；含 provider / model / temperature / maxTokens / reasoning。
 *
 * 边界：只管一个 cassette 文件的读写与回放；不认识 Session、不认识 case。
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantTurn, ChatOpts } from "./provider";

/** cassette 里存下来的请求；不含 apiKey，也不含 signal。 */
export interface CassetteRequest {
  provider: string;
  model: string;
  temperature: number | null;
  maxTokens: number;
  reasoning: string;
  system: string;
  messages: ChatOpts["messages"];
  tools: NonNullable<ChatOpts["tools"]>;
}

export interface CassetteEntry {
  key: string;
  request: CassetteRequest;
  response: AssistantTurn;
}

/** 递归排序对象键：同一次请求不能因为键序不同算出两个 hash。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function requestOf(opts: ChatOpts): CassetteRequest {
  return {
    provider: opts.model.provider,
    model: opts.model.model,
    temperature: opts.model.temperature ?? null,
    maxTokens: opts.model.maxTokens,
    reasoning: opts.model.reasoning,
    system: opts.system ?? "",
    messages: opts.messages,
    tools: opts.tools ?? [],
  };
}

/**
 * 把每次都会变、但评测不关心的字符串归一化：子会话 id、provider 回调 id 都是 UUID。
 * 不归一化的话，父会话的 task 结果里带一个随机 session id，下一次请求的 hash 每次都不同，
 * cassette 永远 miss。只作用于 key，不改存下来的 request。
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalizeForHash(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UUID_RE, "<uuid>");
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeForHash(item);
    return out;
  }
  return value;
}

export function requestHash(opts: ChatOpts): string {
  return hashJson(normalizeForHash(requestOf(opts)));
}

/** 读一个 cassette；坏行跳过（它是录制产物，不该让整轮评测打不开）。 */
export async function readCassette(file: string): Promise<CassetteEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return [];
  }
  const entries: CassetteEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CassetteEntry;
      if (typeof entry.key === "string" && entry.response !== undefined) entries.push(entry);
    } catch {
      // 半行/手改坏的行：跳过
    }
  }
  return entries;
}

const caches = new Map<string, Map<string, CassetteEntry>>();

async function load(file: string): Promise<Map<string, CassetteEntry>> {
  let cache = caches.get(file);
  if (cache === undefined) {
    cache = new Map((await readCassette(file)).map((entry) => [entry.key, entry]));
    caches.set(file, cache);
  }
  return cache;
}

/** 记录这次 run 实际用到的 key；runner 靠它挑出真正的第一条请求算 manifest。 */
async function markUsed(key: string): Promise<void> {
  const file = process.env.TALEMATE_REPLAY_USED;
  if (file === undefined || file === "") return;
  await appendFile(file, `${key}\n`, "utf-8").catch(() => {});
}

/** 把录下来的回应按流式回调的形状吐一遍；顺序不影响结果，只影响事件时间线。 */
function emit(response: AssistantTurn, opts: ChatOpts): void {
  if (response.reasoning !== undefined && response.reasoning !== "") {
    opts.onReasoning?.(response.reasoning);
  }
  if (response.text !== "") opts.onText?.(response.text);
  for (const call of response.toolCalls) {
    opts.onToolCallStart?.({ id: call.id, name: call.name });
  }
}

/**
 * 走 cassette 的 chat。`direct` 是真实 provider 的调用，由 `provider.ts` 传进来——
 * 这样 replay 模块不依赖 provider 的 dispatch，也不会形成运行时循环。
 */
export async function chatWithCassette(
  opts: ChatOpts,
  file: string,
  direct: (opts: ChatOpts) => Promise<AssistantTurn>,
): Promise<AssistantTurn> {
  const request = requestOf(opts);
  const key = hashJson(normalizeForHash(request));
  const entries = await load(file);
  const hit = entries.get(key);

  if (hit !== undefined) {
    await markUsed(key);
    emit(hit.response, opts);
    return hit.response;
  }

  if (process.env.TALEMATE_RECORD !== "1") {
    // 给一条能定位的诊断：同长度的 system 里第一个不同的字符。提示词只改一个字时，
    // 光看 hash 等于什么都没说；这里直接指到改哪儿。
    const firstDiff = (a: string, b: string): number => {
      const limit = Math.min(a.length, b.length);
      for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
      return a.length === b.length ? -1 : limit;
    };
    const near = [...entries.values()].find(
      (entry) => entry.request.system.length === request.system.length,
    );
    const norm = (text: string): string => text.replace(UUID_RE, "<uuid>");
    let hint = "";
    if (near !== undefined) {
      const scalar = (["provider", "model", "temperature", "maxTokens", "reasoning"] as const).filter(
        (key) => near.request[key] !== request[key],
      );
      if (scalar.length > 0) {
        hint =
          `\n  标量不一致：${scalar.map((key) => `${key} 旧=${JSON.stringify(near.request[key])} 新=${JSON.stringify(request[key])}`).join(" · ")}`;
      }
      const at = firstDiff(norm(near.request.system), norm(request.system));
      if (at >= 0) {
        hint =
          `\n  最接近的旧 system 在第 ${at} 字不同：\n` +
          `    旧：${JSON.stringify(norm(near.request.system).slice(Math.max(0, at - 40), at + 80))}\n` +
          `    新：${JSON.stringify(norm(request.system).slice(Math.max(0, at - 40), at + 80))}`;
      } else {
        const oldMessages = norm(JSON.stringify(near.request.messages));
        const newMessages = norm(JSON.stringify(request.messages));
        const mAt = firstDiff(oldMessages, newMessages);
        if (mAt >= 0) {
          hint =
            `\n  system 相同，messages 在第 ${mAt} 字不同：\n` +
            `    旧：${JSON.stringify(oldMessages.slice(Math.max(0, mAt - 40), mAt + 80))}\n` +
            `    新：${JSON.stringify(newMessages.slice(Math.max(0, mAt - 40), mAt + 80))}`;
        } else {
          const oldTools = norm(JSON.stringify(near.request.tools));
          const newTools = norm(JSON.stringify(request.tools));
          const tAt = firstDiff(oldTools, newTools);
          if (tAt >= 0) {
            hint =
              `\n  messages 相同，tools 在第 ${tAt} 字不同：\n` +
              `    旧：${JSON.stringify(oldTools.slice(Math.max(0, tAt - 40), tAt + 80))}\n` +
              `    新：${JSON.stringify(newTools.slice(Math.max(0, tAt - 40), tAt + 80))}`;
          }
        }
      }
    }
    throw new Error(
      `replay miss：${key}\n` +
        `  模型：${request.provider} / ${request.model}\n` +
        `  cassette：${file}\n` +
        `  system ${request.system.length} 字 · messages ${request.messages.length} 条 · tools ${request.tools.length} 个${hint}\n` +
        "  要录新的就加 --record；不要静默换一个模型或提示词。",
    );
  }

  const response = await direct(opts);
  const entry: CassetteEntry = { key, request, response };
  entries.set(key, entry);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
  await markUsed(key);
  return response;
}
