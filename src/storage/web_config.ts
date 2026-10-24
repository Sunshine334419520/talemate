/**
 * 联网设置：`<talemateHome>/web.json`。用户级、跨作品——同一台机器上的联网能力是作者的，
 * 不跟某一部小说走（对照 `models.json`）。
 *
 * 读失败一律当"没配"：联网退回原来的直连 / 各搜索后端，不是错误。写走原子写。
 *
 * 这把 key 与模型调用的 key 可以不同（也可以是同一把 DeepSeek key）。它只存在本地明文文件里，
 * 与 `models.json` 同级——正经做法是系统钥匙串，那是一次单独的取舍。
 */
import { join } from "node:path";
import { talemateHome } from "../core/config";
import type { WebSettings } from "../core/types";
import { readText, writeAtomic } from "./atomic";

export function webConfigPath(env = process.env): string {
  return join(talemateHome(env), "web.json");
}

export async function loadWebSettings(env = process.env): Promise<WebSettings> {
  const raw = await readText(webConfigPath(env));
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as WebSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // 文件坏了按没配处理：联网退回默认后端，不让它挡住写作
  }
}

export async function saveWebSettings(settings: WebSettings, env = process.env): Promise<void> {
  await writeAtomic(webConfigPath(env), `${JSON.stringify(settings, null, 2)}\n`);
}
