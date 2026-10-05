/**
 * 探针入口：把随包数据的根钉上，再跑全链路冒烟。
 *
 * 顺序是这里唯一要紧的事——**先钉、后加载**。桌面端的主进程做不到这一点（它的 import 是静态的），
 * 所以才要求解析是惰性的（见 `core/config.ts` 与 `prompts.ts`）；这个入口用动态 import 把意图
 * 写得和主进程一样清楚。
 */
import { setResourceRoot } from "../../src/core/config";

const pin = process.env.TALEMATE_RESOURCES;
if (pin) setResourceRoot(pin);

await import("../../src/smoke");
