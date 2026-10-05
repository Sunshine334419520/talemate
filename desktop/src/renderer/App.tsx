/**
 * 两个屏：**选作品** → **进写作台**。
 *
 * 作品数少而创建低频（一部书写一年，一个人手里不会超过十本），所以首屏值得占满一整屏；
 * 进项目之后左栏就只剩"这本书的"东西（阶段 1 先是会话，文档树在阶段 2）。
 *
 * 这一层只管"在哪个屏"，取数一律现取（真相在盘上，界面不缓存）。
 */
import { useCallback, useEffect, useState } from "react";
import type { ProjectCard } from "../shared/api";
import { Picker } from "./Picker";
import { Workspace } from "./Workspace";

/** 回主进程一句"画出来了"。带上内容——只说"成功了"没有信息量。 */
function report(summary: string): void {
  window.tm.reportRendered?.(summary);
}

export function App() {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<ProjectCard | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.tm.listProjects();
      setProjects(list);
      setError(null);
      report(`✓ 首屏：${list.length} 部作品`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      report(`✗ 取项目失败：${msg}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error !== null) {
    return (
      <div className="picker">
        <h1>读不到作品</h1>
        <p className="sub">{error}</p>
      </div>
    );
  }
  if (projects === null) return <div className="picker"><p className="sub">正在打开书架…</p></div>;

  if (opened !== null) {
    return (
      <Workspace
        project={opened}
        onExit={() => {
          setOpened(null);
          void refresh();
        }}
      />
    );
  }
  return <Picker projects={projects} onOpen={setOpened} onCreated={refresh} />;
}
