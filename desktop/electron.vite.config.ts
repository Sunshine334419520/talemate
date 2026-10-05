/**
 * 桌面壳的构建配置：**electron-vite 的三段式**（main / preload / renderer）。
 *
 * 这跟手搓 esbuild 的差别不在"能不能跑"，而在**少几件事要自己想**：三段的入口与产物路径是约定的
 * （`src/main/index.ts` → `out/main/index.js`，以此类推），开发时渲染层有 HMR，预加载该是 CJS 也由它
 * 按包类型决定。这类壳子的样板在别的项目里已经定了型，自己写一份只会多一处出错的地方。
 *
 * 两条**刻意留空**：
 *
 * - **不挂 `externalizeDepsPlugin()`**：它按 app 的 `package.json` 决定哪些依赖不打包，而
 *   `desktop/package.json` 没有 dependencies——也就是说没有东西需要外置，全部打进来更好（随包数据
 *   只有 prompts 与 skills，运行时不再需要 node_modules）。这一步 `desktop/probe` 已经验过。
 * 配置文件靠 `electron-vite <root>` 的 root 参数找到（脚本里给的是 `desktop`）。
 *
 * **必须在应用根目录里跑**（脚本里是 `cd desktop && electron-vite build`）：把目录当位置参数传进去时，
 * 渲染层的 html 路径会被算成 `../../desktop/src/renderer/index.html`，rollup 直接报错。
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
