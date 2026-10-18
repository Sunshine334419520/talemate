/**
 * 界面里共用的小图标。内联 SVG、不联网、不引图标库——用得着的就这么几个，
 * 为它们装一个库、再为打包体积做取舍，不划算。
 *
 * 形状取自 Lucide（`panel-left-close` / `panel-left-open` / `sliders-horizontal`），
 * 线条粗细统一在 1.3–1.7，跟界面的字号一个量级。
 */

/** 侧栏开关：展开时箭头收进去，收起后箭头翻向另一侧。 */
export function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      {open ? <path d="m14 9 3 3-3 3" /> : <path d="m16 15-3-3 3-3" />}
    </svg>
  );
}

/** 下拉入口的箭头：与左栏段头同一套描边；闭着朝下，打开朝上 */
export function DropdownIcon({ open }: { open: boolean }) {
  return (
    <svg className="dropdown-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? <path d="m4 10 4-4 4 4" /> : <path d="m4 6 4 4 4-4" />}
    </svg>
  );
}

/** 权限：一面盾牌，配"工作区内修改 / 每次询问" */
export function ShieldIcon() {
  return (
    <svg className="shield-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2 13 4v4.1c0 2.6-2 4.6-5 5.7-3-1.1-5-3.1-5-5.7V4z" />
    </svg>
  );
}

/** 改动记录：一圈时钟，对应"过去发生了什么" */
export function HistoryIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

/** 设置入口：三条带滑块的横线。 */
export function SlidersIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
      <circle cx="6" cy="4" r="1.6" fill="var(--card)" />
      <circle cx="10.5" cy="8" r="1.6" fill="var(--card)" />
      <circle cx="6.5" cy="12" r="1.6" fill="var(--card)" />
    </svg>
  );
}

/** 提问卡的自定义答案：一支铅笔，和右栏批注的语义一致（写自己的话）。 */
export function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.4 2.6l2 2L5.2 12.8H3.2v-2z" />
    </svg>
  );
}

/** 分组折叠箭头：展开朝下、收起朝右。 */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? <path d="m4 6 4 4 4-4" /> : <path d="m6 4 4 4-4 4" />}
    </svg>
  );
}
