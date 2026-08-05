/**
 * Restore of a full-account backup ZIP. Same account semantics as the
 * device-link QR / backup link (RestorePage): joining is a no-op, a top-up,
 * or an account switch that has to be confirmed — the difference is that
 * this file also carries the contents, so it works with no relay in reach.
 */

import { useState } from 'react';

import { backupRelation, isLinkToken } from '../../services';
import { getHandlesSnapshot } from '../../store';
import { restoreAccount, summarizeRestore } from '../lib/accountBackup';
import type { ParsedAccount } from '../lib/importFile';
import { Spinner } from './Common';
import { Modal } from './Modal';
import { useToast } from './Toast';

export function AccountRestoreModal({
  account,
  fileName,
  onClose,
  onRestored,
}: {
  account: ParsedAccount;
  fileName: string;
  onClose: () => void;
  onRestored: (summary: string) => void;
}) {
  const { toastError } = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Read once: restoring mutates both.
  const [relation] = useState(() => backupRelation(account.backup));
  const [localCount] = useState(() => getHandlesSnapshot().length);

  const items = account.inventories.reduce((total, inv) => total + inv.parsed.snapshot.items.length, 0);
  const photos = account.inventories.reduce((total, inv) => total + inv.parsed.photoBlobs.size, 0);
  const accountName = account.manifest.name ? `${account.manifest.name}'s account` : 'that account';
  const tokensOnly = isLinkToken(account.backup);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await restoreAccount(account, (done, total) => setProgress({ done, total }));
      onRestored(summarizeRestore(result));
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Restore failed');
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal
      title={relation === 'other-account' ? 'Switch account?' : 'Restore account backup'}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn grow" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className={relation === 'other-account' ? 'btn danger grow' : 'btn primary grow'}
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? <Spinner /> : null}
            {busy
              ? progress
                ? `Restoring ${progress.done}/${progress.total}`
                : 'Restoring'
              : relation === 'other-account'
                ? 'Join this account'
                : 'Restore everything'}
          </button>
        </>
      }
    >
      <div className="stack tight">
        <p>
          <strong>{account.manifest.name ?? 'Unnamed account'}</strong>
        </p>
        <p className="tiny faint">
          {fileName}
          {account.manifest.exportedAt
            ? ` · exported ${new Date(account.manifest.exportedAt).toISOString().slice(0, 10)}`
            : ''}
        </p>
      </div>

      <div className="stack tight">
        <p>
          {account.inventories.length} inventor{account.inventories.length === 1 ? 'y' : 'ies'} with
          contents
        </p>
        <p>
          {items} item{items === 1 ? '' : 's'} · {photos} photo{photos === 1 ? '' : 's'}
        </p>
        {account.unreadable > 0 ? (
          <p className="warn-text">
            {account.unreadable} inventor{account.unreadable === 1 ? 'y' : 'ies'} in this archive
            could not be read and will be skipped
          </p>
        ) : null}
        {tokensOnly ? (
          <p className="warn-text">
            This archive carries the account but no inventory access tokens; anything restored will
            only sync if your other devices are reachable.
          </p>
        ) : null}
      </div>

      {relation === 'other-account' ? (
        <p className="small warn-text">
          This device already belongs to a different account. Joining {accountName} merges the two:
          the {localCount} inventor{localCount === 1 ? 'y' : 'ies'} on this device{' '}
          {localCount === 1 ? 'is' : 'are'} added to it and become visible on its other devices.
        </p>
      ) : null}

      <p className="small muted">
        Access tokens and encryption keys are merged like a device link, then each inventory's
        contents are put back where they came from. Inventories that already hold data on this
        device are left untouched — theirs is the newer copy.
      </p>
      <p className="tiny faint">
        No connection is needed: everything is restored locally and syncs when a relay is reachable
        again.
      </p>
    </Modal>
  );
}
