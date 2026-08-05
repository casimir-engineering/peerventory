import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { decodeBackup, importBackup } from '../../services';
import { AppHeader } from '../components/AppHeader';
import { EmptyState } from '../components/Common';
import { useToast } from '../components/Toast';

/**
 * Target of a device-backup link/QR: shows what the backup contains and
 * merges it into this device on confirmation. Merging never downgrades
 * anything already present locally.
 */
export function RestorePage() {
  const { payload = '' } = useParams();
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const [busy, setBusy] = useState(false);

  const backup = useMemo(() => (payload ? decodeBackup(payload) : null), [payload]);

  if (!backup) {
    return (
      <>
        <AppHeader title="Restore backup" back="/" />
        <main className="page narrow">
          <EmptyState
            glyph="✕"
            title="Not a valid backup"
            body="This link or code could not be read as a device backup."
            action={
              <Link className="btn" to="/">
                Back to inventories
              </Link>
            }
          />
        </main>
      </>
    );
  }

  const rwCount = backup.handles.filter((h) => h.rwToken).length;

  const doImport = () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = importBackup(backup);
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.upgraded > 0) parts.push(`${result.upgraded} upgraded to edit access`);
      if (result.unchanged > 0) parts.push(`${result.unchanged} already here`);
      const summary = parts.length > 0 ? `Inventories: ${parts.join(', ')}` : 'Backup imported';
      toast(result.profileLinked ? `Devices linked · ${summary}` : summary);
      navigate('/', { replace: true });
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Import failed');
      setBusy(false);
    }
  };

  return (
    <>
      <AppHeader title="Restore backup" back="/" />
      <main className="page narrow">
        <div className="stack">
          <section className="card stack tight">
            <p className="small">
              This backup contains{' '}
              <strong>
                {backup.handles.length} inventor{backup.handles.length === 1 ? 'y' : 'ies'}
              </strong>
              {rwCount > 0 ? ` (${rwCount} with edit access)` : ''}
              {backup.name ? (
                <>
                  {' '}
                  and the identity <strong>{backup.name}</strong>
                </>
              ) : null}
              {backup.aiKey ? ', plus a Claude API key' : ''}.
            </p>
            {backup.handles.length > 0 ? (
              <ul className="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
                {backup.handles.slice(0, 8).map((h) => (
                  <li key={h.docId}>
                    {h.name || h.docId}
                    {h.rwToken ? '' : ' (view only)'}
                  </li>
                ))}
                {backup.handles.length > 8 ? <li>… and {backup.handles.length - 8} more</li> : null}
              </ul>
            ) : null}
            <p className="tiny faint">
              Importing merges with what is already on this device. Nothing is overwritten or
              downgraded: your existing name, key and edit access always win.
              {backup.profile
                ? ' This code also links the two devices permanently: inventories created or joined on one will appear on the other automatically.'
                : ''}
            </p>
            <div className="row">
              <button type="button" className="btn grow" onClick={() => navigate('/')}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary grow"
                disabled={busy}
                onClick={doImport}
              >
                {busy ? 'Importing…' : 'Import to this device'}
              </button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
