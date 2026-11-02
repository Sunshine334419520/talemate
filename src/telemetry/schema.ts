/**
 * 事件日志的版本与读入契约：当前只认 schemaVersion=1；未知版本/未知类型不猜。
 *
 * 为什么单独一层：`parseEvents` 是日志的唯一入口，版本升级、字段迁移、坏行容忍都在这里，
 * 消费方（UI / eval / 导出）只拿到已经收窄过的 `AnyTraceEvent`。
 *
 * 边界：纯函数；不读文件、不写日志、不投影。
 */
import {
  TRACE_SCHEMA_VERSION,
  isTraceEventType,
  type AnyTraceEvent,
} from "./events";

/** 版本 n → 版本 n+1 的迁移。加一个字段含义时在这里补一条，并把 TRACE_SCHEMA_VERSION 加一。 */
const MIGRATIONS: Record<number, (event: Record<string, unknown>) => Record<string, unknown>> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把一条原始 JSON 升级/校验成当前版本。
 * 返回值 `null` 表示"看不懂"：未知类型、未知未来版本、缺字段——调用方跳过，不瞎猜。
 */
export function upgradeEvent(raw: unknown): AnyTraceEvent | null {
  if (!isRecord(raw)) return null;

  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (version > TRACE_SCHEMA_VERSION) return null;

  let event = raw;
  for (let v = version; v < TRACE_SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (migrate === undefined) return null;
    event = migrate(event);
  }

  if (event.schemaVersion !== TRACE_SCHEMA_VERSION) return null;
  if (typeof event.sessionId !== "string" || event.sessionId === "") return null;
  if (typeof event.seq !== "number" || !Number.isFinite(event.seq) || event.seq < 1) return null;
  if (typeof event.time !== "number" || !Number.isFinite(event.time)) return null;
  if (typeof event.type !== "string" || !isTraceEventType(event.type)) return null;
  if (!isRecord(event.data)) return null;

  return event as unknown as AnyTraceEvent;
}
