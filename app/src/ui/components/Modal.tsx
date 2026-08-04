import { useEffect } from 'react';
import type { ReactNode } from 'react';

// Mounted-modal counter for the Android system back button (main.tsx): when a
// modal is open, back closes it (via a synthetic Escape) instead of navigating.
let openModalCount = 0;

export function hasOpenModal(): boolean {
  return openModalCount > 0;
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
  destructive,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
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
            Cancel
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
