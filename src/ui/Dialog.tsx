import { useEffect, type ReactNode } from "react";

/** A modal dialog: a title, a body, a footer of buttons. Escape or a click outside closes it. */
export function Dialog({
  title,
  onClose,
  width = 520,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title} style={{ width: `min(${width}px, calc(100vw - 32px))` }}>
        <div className="dialog-head">
          <span className="dialog-title">{title}</span>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
