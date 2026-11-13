import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div className="modal-layer" role="presentation" onMouseDown={onClose}>
      <div
        className="modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  busy,
  tone = "danger",
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  tone?: "danger" | "primary";
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={`btn ${tone}`} onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{body}</div>
    </Modal>
  );
}

export type ToastTone = "ok" | "error" | "info";
export type Toast = { id: number; message: string; tone: ToastTone };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return createPortal(
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast tone-${toast.tone}`}>
          <span className="toast-mark" />
          <span>{toast.message}</span>
          <button className="icon-btn tiny" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
