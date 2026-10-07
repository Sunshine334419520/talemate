/**
 * 左栏下半：这本书的文档树。
 *
 * 它画的是 `docs:tree` 给回来的东西——那份数据来自 `enumerateDocs`，范围就是作品的三个根
 * （`design/` `chapters/` `state/`），所以"哪些东西上树"这条判据不在界面里：`.talemate/`
 * （会话、规划工件、考据本）与 `skills/` 根本不会出现在这份数据里。
 *
 * 显示名来自 harness 那一侧（`framework/anchor.ts` 的 `docTree`）：这一层只画，不判断"这段叫什么"
 * ——界面自己长出一套命名，两处迟早说两套话。
 */
import { useState } from "react";
import type { DocNode } from "../shared/api";

export function DocTree({
  nodes,
  current,
  onOpen,
  onMention,
}: {
  nodes: DocNode[];
  current: string | null;
  onOpen: (node: DocNode) => void;
  /** 右键 →"添加到对话"：把这一份的名字插进输入框（`@名字`），见 Workspace 的 mention */
  onMention: (node: DocNode) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; node: DocNode } | null>(null);
  if (nodes.length === 0) return <p className="tree-empty">（空）</p>;
  return (
    <div className="tree">
      {nodes.map((n) => (
        <Node
          key={n.name}
          node={n}
          depth={0}
          current={current}
          onOpen={onOpen}
          onMenu={(e, node) => {
            if (node.path === undefined) return; // 纯分组没什么可加、可开的
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node });
          }}
        />
      ))}
      {menu !== null && (
        <>
          <span className="pop-mask" onClick={() => setMenu(null)} />
          <span className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              className="pop-item"
              onClick={() => {
                onMention(menu.node);
                setMenu(null);
              }}
            >
              添加到对话
            </button>
            <button
              className="pop-item"
              onClick={() => {
                onOpen(menu.node);
                setMenu(null);
              }}
            >
              在右栏打开
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * 一个节点。三种，而不是两种：
 *
 * - 有子节点、自己也有 `path`（如"世界观"：既有总纲又有专题页）→ 点名字开文档、点箭头展开
 * - 有子节点、自己没有 `path`（如"角色"）→ 只能展开
 * - 没有子节点 → 点开文档
 *
 * 收起展开的状态在组件自己身上（`useState`）：这是"眼下看的样子"，不是这份文档的性质，
 * 没有理由进任何一层数据。默认展开——目录是用来扫的，一进来全收起等于什么都没显示。
 */
function Node({
  node,
  depth,
  current,
  onOpen,
  onMenu,
}: {
  node: DocNode;
  depth: number;
  current: string | null;
  onOpen: (node: DocNode) => void;
  onMenu: (e: React.MouseEvent, node: DocNode) => void;
}) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: 6 + depth * 11 };
  const hasKids = node.children !== undefined;
  const openable = node.path !== undefined;

  return (
    <>
      <div
        className={`doc-row${current !== null && current === node.path ? " here" : ""}`}
        style={pad}
        onContextMenu={(e) => onMenu(e, node)}
      >
        <button
          className="twist"
          disabled={!hasKids}
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "收起" : "展开"}
        >
          {hasKids ? (open ? "▾" : "▸") : "·"}
        </button>
        {openable ? (
          <button className="doc" title={node.path} onClick={() => onOpen(node)}>
            {node.name}
          </button>
        ) : (
          <span className="doc group">{node.name}</span>
        )}
      </div>
      {hasKids && open && node.children?.map((c) => (
        <Node key={c.name} node={c} depth={depth + 1} current={current} onOpen={onOpen} onMenu={onMenu} />
      ))}
    </>
  );
}
