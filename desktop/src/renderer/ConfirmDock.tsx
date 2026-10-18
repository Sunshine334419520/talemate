/**
 * 审批卡：与提问卡共用底部弹窗外壳，但契约独立——三档回答、失败即拒绝、不能收起。
 *
 * 它堵的是当前这一轮：用户必须给一个答复（或关掉应用），不存在 pending 后补答。
 * 收起审批会让搭档一直卡在工具调用里，所以这里没有 ⌄。
 */
import type { ConfirmRequest } from "../shared/api";

export function ConfirmDock({
  req,
  onReply,
  onOpenDiff,
}: {
  req: ConfirmRequest;
  onReply: (value: "once" | "always" | "no") => void;
  onOpenDiff: (name: string, text: string) => void;
}) {
  const lines = req.summary.split("\n");
  const head = lines[0] ?? "";
  const body = lines.slice(1).join("\n").trim();

  return (
    <section className="ask-sheet confirm-sheet" aria-label="需要你确认">
      <header className="ask-sheet-head">
        <span className="ask-eyebrow">需要你确认</span>
        <span className="ask-status">审批</span>
      </header>
      <div className="ask-body">
        <div className="confirm-action">{req.action}</div>
        <pre className="confirm-summary">{head}</pre>
        {body !== "" && (
          // 细节去右栏（"需要展示详细的都在右侧"）：这一行只是入口，不在这里摊开
          <button
            type="button"
            className="steps-head"
            onClick={() => onOpenDiff(req.action, body)}
          >
            <span className="caret">›</span>
            看改动（右栏）
          </button>
        )}
      </div>
      <footer className="ask-sheet-foot">
        <div className="ask-note">审批不会因为等待而自动通过；没有回答方时按拒绝处理。</div>
        <div className="ask-actions">
          <span className="ask-grow" />
          <button type="button" className="ask-btn" onClick={() => onReply("always")}>
            这一类都允许
          </button>
          <button type="button" className="ask-btn primary" onClick={() => onReply("once")}>
            允许一次
          </button>
          <button type="button" className="ask-btn zhu" onClick={() => onReply("no")}>
            拒绝
          </button>
        </div>
      </footer>
    </section>
  );
}
