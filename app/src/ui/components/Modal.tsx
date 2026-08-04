import { useEffect } from 'react';
import type { ReactNode } from 'react';

// Mounted-modal counter for the Android system back button (main.tsx): when a
// modal is open, back closes it (via a synthetic Escape) instead of navigating.
let openModalCount = 0;

export function hasOpenModal(): boolean {
  return openModalCount > 0;
}

/**
 * Joins the open-modal counter and closes on Escape. The two are one
 * mechanism: the Android back handler dismisses whatever is counted here by
 * dispatching a synthetic Escape, so anything counted must close on it.
 * For fullscreen overlays that are not <Modal> (e.g. the photo lightbox).
 */
export function useModalDismiss(onClose: () => void): void {
  useEffect(() => {
    openModalCount++;
    return () => {
      openModalCount--;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useModalDismiss(onClose);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="stack">{children}</div>
        {footer ? <div className="row" style={{ marginTop: 16 }}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'btn danger grow' : 'btn primary grow'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="small muted">{body}</p>
    </Modal>
  );
}
