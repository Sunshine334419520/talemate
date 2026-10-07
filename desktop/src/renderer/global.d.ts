/** preload 挂在 window 上的那个白名单 API，渲染层只认它。 */
import type { TmApi } from "../shared/api";

declare global {
  interface Window {
    tm: TmApi;
  }
}

export {};
