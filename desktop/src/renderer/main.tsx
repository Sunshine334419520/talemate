/**
 * 渲染层入口。只做一件事：把 React 挂上去。
 *
 * "我画出来了"那句话由 `App` 在取到数据之后回给主进程——那才是白屏唯一的探针：产物缺个 js、
 * 路径不对、一上来就抛异常，全都表现为一片空白而控制台什么都没有（见主进程的 `selftestWindow`）。
 * 挂载成功就说成功是没意义的，得等数据真到了。
 */
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("没有 #root 容器");

// 第一条事件到达时报一句——"事件流真的通了没有"唯一的探针（见主进程的 selftestWindow）。
// 生产里没人听这条消息，所以它没有副作用。
let heard = false;
window.tm.onEvent(() => {
  if (heard) return;
  heard = true;
  window.tm.reportRendered("✓ 收到事件（事件流通了）");
});

createRoot(root).render(<App />);
