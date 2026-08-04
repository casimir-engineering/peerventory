import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { SyncStatus } from '../../store/contract';

const SYNC_TEXT: Record<SyncStatus, string> = {
  offline: 'Offline — changes are saved on this device',
  connecting: 'Connecting to the sync server',
  synced: 'Synced',
  error: 'Sync error — changes stay on this device',
};

export function SyncDot({ status }: { status: SyncStatus | undefined }) {
  const value: SyncStatus = status ?? 'offline';
  return (
    <span
      className={`sync-dot ${value}`}
      title={SYNC_TEXT[value]}
      role="img"
      aria-label={SYNC_TEXT[value]}
    />
  );
}

export function AppHeader({
  title,
  subtitle,
  back,
  status,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Route to go back to; omit for the root screen. */
  back?: string;
  status?: SyncStatus;
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="app-header">
      {back !== undefined ? (
        <button
          type="button"
          className="btn ghost icon"
          aria-label="Back"
          onClick={() => navigate(back)}
        >
          ‹
        </button>
      ) : null}
      <div className="titles">
        <div className="title">{title}</div>
        {subtitle ? <div className="subtitle">{subtitle}</div> : null}
      </div>
      <div className="actions">
        {status ? <SyncDot status={status} /> : null}
        {actions}
      </div>
    </header>
  );
}
