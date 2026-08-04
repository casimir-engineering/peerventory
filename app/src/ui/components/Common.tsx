import type { ReactNode } from 'react';

export function Spinner({ large }: { large?: boolean }) {
  return <span className={large ? 'spinner lg' : 'spinner'} aria-hidden="true" />;
}

export function LoadingPage({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading-page">
      <Spinner large />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  glyph,
  title,
  body,
  action,
}: {
  glyph?: string;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {glyph ? (
        <div className="glyph" aria-hidden="true">
          {glyph}
        </div>
      ) : null}
      <h2>{title}</h2>
      {body ? <p className="small">{body}</p> : null}
      {action}
    </div>
  );
}

/**
 * A share link can be opened before the document has ever reached this device.
 * That is a wait, not a failure, and must not look like an empty inventory.
 */
export function SyncingState({
  title = 'Waiting for the first sync',
  body,
  action,
}: {
  title?: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Spinner large />
      <h2>{title}</h2>
      <p className="small">{body}</p>
      {action}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="row between">
      <div className="section-title">{children}</div>
      {action}
    </div>
  );
}
