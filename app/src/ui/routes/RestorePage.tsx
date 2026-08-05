import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { backupRelation, decodeBackup, importBackup, isLinkToken } from '../../services';
import { getHandlesSnapshot } from '../../store';
import { AppHeader } from '../components/AppHeader';
import { EmptyState } from '../components/Common';
import { useToast } from '../components/Toast';

/**
 * Target of a device-link QR or a backup link. Two payloads land here: the
 * small "join my account" token the Backup screen shows as a QR, and the full
 * backup (every inventory token) that travels as a link or a file. Both can
 * be a no-op, a top-up of the current account, or a switch to a different
 * one — the screen says which before anything is applied.
 */
export function RestorePage() {
  const { payload = '' } = useParams();
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const [busy, setBusy] = useState(false);

  const backup = useMemo(() => (payload ? decodeBackup(payload) : null), [payload]);
  // Read once: importing mutates both of these.
  const [relation] = useState(() => (backup ? backupRelation(backup) : 'static'));
  const [localCount] = useState(() => getHandlesSnapshot().length);

  if (!backup) {
    return (
      <>
        <AppHeader title="Link a device" back="/" />
        <main className="page narrow">
          <EmptyState
            glyph="✕"
            title="Not a valid code"
            body="This link or QR code could not be read as a device link or backup."
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

  const linkOnly = isLinkToken(backup);
  const rwCount = backup.handles.filter((h) => h.rwToken).length;
  const accountName = backup.name ? `${backup.name}'s account` : 'that account';

  if (relation === 'same-account' && linkOnly) {
    return (
      <>
        <AppHeader title="Link a device" back="/" />
        <main className="page narrow">
          <EmptyState
            glyph="✓"
            title="Already linked"
            body="This device is already part of that account. Its inventories arrive on their own through sync — there is nothing to import."
            action={
              <Link className="btn primary" to="/">
                Back to inventories
              </Link>
            }
          />
        </main>
      </>
    );
  }

  const doImport = () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = importBackup(backup);
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.upgraded > 0) parts.push(`${result.upgraded} upgraded to edit access`);
      if (result.unchanged > 0) parts.push(`${result.unchanged} already here`);
      const summary = parts.length > 0 ? `Inventories: ${parts.join(', ')}` : null;
      if (result.profileLinked) {
        toast(summary ? `Device linked · ${summary}` : 'Device linked — syncing your inventories…');
      } else {
        toast(summary ?? 'Nothing new to import');
      }
      navigate('/', { replace: true });
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Import failed');
      setBusy(false);
    }
  };

  const title =
    relation === 'other-account'
      ? 'Switch account?'
      : linkOnly
        ? 'Link this device'
        : 'Restore backup';

  const confirmLabel =
    relation === 'other-account' ? 'Join this account' : linkOnly ? 'Link this device' : 'Import to this device';

  return (
    <>
      <AppHeader title={title} back="/" />
      <main className="page narrow">
        <div className="stack">
          <section className="card stack tight">
            {linkOnly ? (
              <p className="small">
                This code links this device to{' '}
                <strong>{backup.name ? `${backup.name}'s account` : 'another device'}</strong>. It
                carries no inventory data: everything in the account, now and later, arrives
                through sync once the devices are linked.
              </p>
            ) : (
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
            )}

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

            {relation === 'other-account' ? (
              <p className="small warn-text">
                This device already belongs to a different account. Joining {accountName} merges
                the two: the {localCount} inventor{localCount === 1 ? 'y' : 'ies'} on this device{' '}
                {localCount === 1 ? 'is' : 'are'} added to it and become visible on its other
                devices. Anything that lives only on your old account's other devices stays there,
                untouched.
              </p>
            ) : null}

            <p className="tiny faint">
              Importing merges with what is already on this device. Nothing is overwritten or
              downgraded: your existing name, key and edit access always win.
              {backup.profile && relation !== 'same-account'
                ? ' The link is permanent: inventories created or joined on either device appear on both from now on.'
                : ''}
            </p>

            <div className="row">
              <button type="button" className="btn grow" onClick={() => navigate('/')}>
                Cancel
              </button>
              <button
                type="button"
                className={relation === 'other-account' ? 'btn danger grow' : 'btn primary grow'}
                disabled={busy}
                onClick={doImport}
              >
                {busy ? 'Linking…' : confirmLabel}
              </button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
