import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Spell out the consequence in the operator's terms, not the API's. */
  body: ReactNode;
  confirmLabel: string;
  /** Style the confirm action as destructive. */
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal confirmation for actions that move capital or halt the engine.
 *
 * Uses the native <dialog> element so focus trapping, Escape handling and the
 * top layer come from the platform rather than a hand-rolled implementation
 * that would inevitably leak focus.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="mh-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="mh-dialog__head">{title}</div>
      <div className="mh-dialog__body">{body}</div>
      <div className="mh-dialog__foot">
        <button type="button" className="mh-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={`mh-btn ${destructive ? "mh-btn--danger" : "mh-btn--primary"}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
