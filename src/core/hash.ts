/**
 * 稳定 JSON 哈希：同一次请求不能因为对象键序不同算出两个值。
 *
 * 事件里的 request/header 与 eval 的 manifest 都靠它，两边必须是同一份实现——
 * 否则在线 trace 与 cassette 的 hash 对不上，排查时无法互相指认。
 */
import { createHash } from "node:crypto";

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
