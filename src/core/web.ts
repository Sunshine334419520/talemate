/**
 * 联网设置的纯逻辑：目标解析与"给界面看的视图"。不碰文件系统——读写盘在 `storage/web_config.ts`。
 *
 * 放在 core 是为了让工具层能引用它而不 import 存储层（分层守卫钉着这一条）。
 */
import type { WebSettings } from "./types";

/**
 * DeepSeek Search / Fetch API 的默认 Base URL，**含 `/v1/tools` 前缀**；
 * 程序在它后面追加 `/search` 或 `/fetch`。
 *
 * 与 DSH 的 `web-deepseek-api` 保持同一个口径：设置里填到 `/tools` 为止，
 * 这样换成带别的前缀的部署（例如 `/api/v1/tools`）时不用改代码。
 */
export const DEEPSEEK_API_BASE = "https://api.deepseek.com/v1/tools";

/** Search API 每次查询的默认结果数（服务自身默认 10）。 */
export const DEEPSEEK_DEFAULT_COUNT = 10;

export interface DeepSeekWebTarget {
  apiKey: string;
  /** 含 `/v1/tools` 前缀，不带尾部斜杠 */
  baseURL: string;
  /** 每次搜索请求的结果数（1–50） */
  count: number;
}

/**
 * 把用户填的地址归一到"tools base"。
 *
 * - 旧配置存的是 origin（程序以前自己拼 `/v1/tools`）→ 补上 `/v1/tools`；
 * - 直接粘了 `/search` 或 `/fetch` 结尾的完整端点 → 去掉最后一段；
 * - 其余原样保留，让带自定义前缀的部署可以填 `/api/v1/tools`。
 */
function normalizeToolsBase(raw: string): string {
  const clean = raw.trim();
  if (clean === "") return DEEPSEEK_API_BASE;
  try {
    const url = new URL(clean);
    if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1/tools";
    const path = url.pathname.replace(/\/(?:search|fetch)$/i, "").replace(/\/+$/, "");
    return `${url.origin}${path}${url.search}`;
  } catch {
    return DEEPSEEK_API_BASE; // 不是合法 URL 就退回官方地址，别把坏值带进请求
  }
}

/** 设置里的结果数；越界/非整数一律回默认值。 */
export function deepSeekSearchCount(settings: WebSettings): number {
  const n = settings.deepseek?.count;
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEEPSEEK_DEFAULT_COUNT;
}

/**
 * 这次该用哪套 DeepSeek 联网配置；没配 key → undefined（调用方走原路径）。
 *
 * 文件优先、环境变量兜底：`.env` 那套照旧能用，不是被替代了。
 * 环境变量名用 `DEEPSEEK_WEB_API_BASE_URL`（tools base），与 DSH 的 Messages 搜索
 * 地址 `DEEPSEEK_SEARCH_BASE_URL` 分开——两者是不同端点，混用会打到 `/anthropic/v1/search`。
 */
export function deepSeekWebTarget(settings: WebSettings, env = process.env): DeepSeekWebTarget | undefined {
  const key = (settings.deepseek?.apiKey ?? env.DEEPSEEK_API_KEY ?? "").trim();
  if (key === "") return undefined;
  const raw = settings.deepseek?.baseURL ?? env.DEEPSEEK_WEB_API_BASE_URL ?? DEEPSEEK_API_BASE;
  return { apiKey: key, baseURL: normalizeToolsBase(raw), count: deepSeekSearchCount(settings) };
}

/** 给界面的视图：密钥只报"有没有"，不回传。 */
export interface WebSettingsView {
  deepseek: {
    configured: boolean;
    baseURL: string;
    count: number;
  };
}

export function webSettingsView(settings: WebSettings, env = process.env): WebSettingsView {
  const target = deepSeekWebTarget(settings, env);
  return {
    deepseek: {
      configured: target !== undefined,
      baseURL: target?.baseURL ?? DEEPSEEK_API_BASE,
      count: deepSeekSearchCount(settings),
    },
  };
}
