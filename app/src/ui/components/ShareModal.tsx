import { useState } from 'react';
import { getHandle } from '../../store';
import type { Id, InventoryHandle } from '../../types';
import { buildShareUrl, canShareUrl, copyToClipboard, shareUrl, tokenForMode } from '../lib/links';
import type { LinkTarget, ShareMode } from '../lib/links';
import { Modal } from './Modal';
import { QrCanvas } from './QrCanvas';
import { useToast } from './Toast';

/**
 * One share surface for inventories, items and lists. Read-only is the default
 * because most links go to forwarders and customs desks.
 */
export function ShareModal({
  docId,
  target,
  title = 'Share',
  subtitle,
  onClose,
}: {
  docId: Id;
  target: LinkTarget;
  title?: string;
  subtitle?: string;
  onClose: () => void;
}) {
  const { toast, toastError } = useToast();
  // Read on every render: a token joined from a link is only classified as
  // read-only once the server handshake lands, which can happen after this
  // modal is already open.
  const handle: InventoryHandle | null = getHandle(docId);
  const [mode, setMode] = useState<ShareMode>('ro');

  const canWrite = Boolean(handle?.rwToken) && !handle?.readonly;
  const canViewOnly = Boolean(handle?.roToken);
  const effectiveMode: ShareMode = canViewOnly ? (canWrite ? mode : 'ro') : 'rw';
  const token = tokenForMode(handle, effectiveMode);
  // E2E inventories: the content key rides in the fragment so the recipient
  // can decrypt. Both view-only and edit links carry it (read = decrypt).
  const url = token ? buildShareUrl(docId, token, target, handle?.key) : null;

  return (
    <Modal title={title} onClose={onClose}>
      {subtitle ? <p className="small muted">{subtitle}</p> : null}

      {!url ? (
        <p className="small muted">
          No share token is stored for this inventory on this device, so a link cannot be built.
        </p>
      ) : (
        <>
          <div className="row between">
            <div className="seg" role="group" aria-label="Access level">
              <button
                type="button"
                aria-pressed={effectiveMode === 'ro'}
                disabled={!canViewOnly}
                onClick={() => setMode('ro')}
              >
                View only
              </button>
              <button
                type="button"
                aria-pressed={effectiveMode === 'rw'}
                disabled={!canWrite}
                onClick={() => setMode('rw')}
              >
                Can edit
              </button>
            </div>
          </div>

          <p className="tiny muted">
            {effectiveMode === 'ro'
              ? 'Recipients can view and export, but cannot change anything.'
              : 'Recipients can edit every item in this inventory.'}
          </p>

          {!canViewOnly ? (
            <p className="tiny faint">
              This device joined with an edit link, so it never received the view-only token and
              cannot build a view-only link. Ask the device that created this inventory for one.
            </p>
          ) : null}

          <QrCanvas value={url} />

          <div className="url-box">{url}</div>

          <div className="row">
            <button
              type="button"
              className="btn primary grow"
              onClick={async () => {
                const ok = await copyToClipboard(url);
                if (ok) toast('Link copied');
                else toastError('Could not copy the link');
              }}
            >
              Copy link
            </button>
            {canShareUrl() ? (
              <button
                type="button"
                className="btn grow"
                onClick={() => void shareUrl(title, url)}
              >
                Send
              </button>
            ) : null}
          </div>

          <p className="tiny faint">
            The link opens in a browser and keeps working offline once it has been opened while
            connected.
            {handle?.key
              ? ' It carries the decryption key for this end-to-end encrypted inventory; the sync server never sees it.'
              : ''}
          </p>
        </>
      )}
    </Modal>
  );
}
