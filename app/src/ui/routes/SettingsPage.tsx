import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getRelayConns,
  getStoredHandle,
  isOwnedInventory,
  replicateToMyRelays,
  useInventories,
  useInventory,
} from '../../store';
import type { UseInventoriesResult, UseInventoryResult } from '../../store/contract';
import type { Box } from '../../types';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, LoadingPage, SectionTitle, SyncingState } from '../components/Common';
import { ExportButtons } from '../components/ExportButtons';
import {
  BufferedInput,
  Field,
  InlineText,
  Toggle,
  useCurrencyComboOptions,
} from '../components/Fields';
import { SmartCombo } from '../components/SmartCombo';
import { ConfirmModal } from '../components/Modal';
import { useToast } from '../components/Toast';

export function SettingsPage() {
  const { docId = '' } = useParams();
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const inv: UseInventoryResult = useInventory(docId || null);
  const { forgetInventory }: UseInventoriesResult = useInventories();

  const [confirmForget, setConfirmForget] = useState(false);
  const [deleteBox, setDeleteBox] = useState<Box | null>(null);
  const [newBoxLabel, setNewBoxLabel] = useState('');
  const currencyOptions = useCurrencyComboOptions(inv.meta?.currency);

  const readonly = Boolean(inv.readonly);
  // Re-read on every render: useInventory's version bumps on per-relay
  // status changes, so this stays live without its own subscription.
  const relayConns = docId ? getRelayConns(docId) : [];
  const boxes: Box[] = inv.boxes ?? [];
  const itemsPerBox = new Map<string, number>();
  for (const item of inv.items ?? []) {
    if (item.boxId) itemsPerBox.set(item.boxId, (itemsPerBox.get(item.boxId) ?? 0) + 1);
  }

  useEffect(() => {
    document.title = inv.meta?.name ? `${inv.meta.name} — settings` : 'Inventory settings';
    return () => {
      document.title = 'Peerventory';
    };
  }, [inv.meta?.name]);

  if (!inv.loaded) {
    return (
      <>
        <AppHeader title="Settings" back={`/inv/${docId}`} />
        <main className="page narrow">
          <LoadingPage />
        </main>
      </>
    );
  }

  if (!inv.meta) {
    return (
      <>
        <AppHeader title="Settings" back={`/inv/${docId}`} status={inv.syncStatus} />
        <main className="page narrow">
          {inv.syncStatus === 'connecting' ? (
            <SyncingState body="This inventory has not reached this device yet, so there is nothing to configure." />
          ) : (
            <EmptyState
              title="Inventory not available"
              body="This inventory is not stored on this device."
              action={
                <Link className="btn primary" to="/">
                  Back to inventories
                </Link>
              }
            />
          )}
        </main>
      </>
    );
  }

  const meta = inv.meta;

  return (
    <>
      <AppHeader
        title="Settings"
        subtitle={meta.name}
        back={`/inv/${docId}`}
        status={inv.syncStatus}
      />

      <main className="page narrow">
        <div className="stack loose">
          <section className="card stack">
            <SectionTitle>Inventory</SectionTitle>
            <InlineText
              label="Name"
              value={meta.name}
              readonly={readonly}
              onCommit={(value) => value && inv.updateMeta({ name: value })}
            />
            <InlineText
              label="Description"
              value={meta.description}
              multiline
              readonly={readonly}
              onCommit={(value) => inv.updateMeta({ description: value || undefined })}
            />
            {readonly ? (
              <InlineText
                label="Default currency"
                value={meta.currency}
                readonly
                onCommit={() => {}}
              />
            ) : (
              <Field
                label="Default currency"
                hint="Used for new item values. Type a code or a name, e.g. USD or Swiss Franc."
              >
                <SmartCombo
                  value={meta.currency ?? 'USD'}
                  options={currencyOptions}
                  strict
                  ariaLabel="Default currency"
                  onCommit={(code) => inv.updateMeta({ currency: code })}
                />
              </Field>
            )}
            <Toggle
              label="Track owner per item"
              description="Adds an owner field and a transfer history to every item."
              checked={Boolean(meta.ownerTrackingEnabled)}
              disabled={readonly}
              onChange={(checked) => inv.updateMeta({ ownerTrackingEnabled: checked })}
            />
            <Toggle
              label="Store precise GPS locations"
              description="Off: only place labels are saved and shared; coordinates never leave your device. Turning it off also removes coordinates already stored."
              checked={meta.preciseLocation !== false}
              disabled={readonly}
              onChange={(checked) => {
                inv.updateMeta({ preciseLocation: checked });
                if (!checked) {
                  const scrubbed = inv.stripLocationCoords();
                  toast(
                    scrubbed > 0
                      ? `Coordinates removed from ${scrubbed} location entr${scrubbed === 1 ? 'y' : 'ies'}`
                      : 'Only place labels will be stored from now on',
                  );
                }
              }}
            />
            <p className="tiny faint mono">Document {docId}</p>
          </section>

          <section className="card stack tight">
            <SectionTitle>Boxes</SectionTitle>
            {boxes.length === 0 ? (
              <p className="small muted">
                No boxes yet. Boxes map items to the carton they are packed in, which is what a
                forwarder asks for.
              </p>
            ) : (
              <div className="list-rows">
                {boxes.map((box) => (
                  <div className="list-row" key={box.id} style={{ cursor: 'default' }}>
                    <div className="grow">
                      {readonly ? (
                        <div>{box.label}</div>
                      ) : (
                        <BufferedInput
                          value={box.label}
                          ariaLabel={`Box label for ${box.label}`}
                          onCommit={(value) => {
                            if (value && value !== box.label) {
                              inv.updateBox(box.id, { label: value });
                            }
                          }}
                        />
                      )}
                    </div>
                    <span className="chip">{itemsPerBox.get(box.id) ?? 0}</span>
                    {!readonly ? (
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        aria-label={`Delete ${box.label}`}
                        onClick={() => setDeleteBox(box)}
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {!readonly ? (
              <div className="row" style={{ marginTop: 8 }}>
                <input
                  className="input grow"
                  value={newBoxLabel}
                  placeholder="New box label"
                  onChange={(e) => setNewBoxLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newBoxLabel.trim()) {
                      inv.createBox(newBoxLabel.trim());
                      setNewBoxLabel('');
                      toast('Box created');
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!newBoxLabel.trim()}
                  onClick={() => {
                    inv.createBox(newBoxLabel.trim());
                    setNewBoxLabel('');
                    toast('Box created');
                  }}
                >
                  Add box
                </button>
              </div>
            ) : null}
          </section>

          <section className="card stack tight">
            <SectionTitle>Export</SectionTitle>
            <p className="small muted">
              Sharing and stats live on the inventory screen; exports produce files for customs,
              forwarders, or archiving.
            </p>
            <ExportButtons docId={docId} inventoryName={meta.name} />
          </section>

          <section className="card stack tight">
            <SectionTitle>Sync</SectionTitle>
            <p className="small muted">
              Items are stored on this device first and sync in the background through every relay
              below. Any single reachable relay is enough.
            </p>
            {relayConns.length === 0 ? (
              <p className="small muted">Not connected to any relay yet.</p>
            ) : (
              <div className="list-rows">
                {relayConns.map((conn) => (
                  <div className="list-row" key={conn.origin} style={{ cursor: 'default' }}>
                    <span className={`sync-dot ${conn.status}`} aria-hidden="true" />
                    <div className="grow" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <span className="small">{conn.origin.replace(/^https?:\/\//, '')}</span>
                    </div>
                    <span className="tiny faint">
                      {conn.status}
                      {conn.scope ? ` · ${conn.scope === 'rw' ? 'can edit' : 'view only'}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {inv.p2pPeers > 0 ? (
              <p className="small">
                <span className="sync-dot synced" aria-hidden="true" /> Direct device-to-device:{' '}
                {inv.p2pPeers} device{inv.p2pPeers === 1 ? '' : 's'} connected
              </p>
            ) : null}
            {!readonly && isOwnedInventory(getStoredHandle(docId)) ? (
              <p className="tiny faint">
                This inventory is yours: it replicates automatically (with its photos) to every
                relay enabled on your account. Manage relays under Account &amp; sync (
                {'\u2699\uFE0E'} on the home screen).
              </p>
            ) : !readonly ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    replicateToMyRelays(docId)
                      .then(({ relays, photosQueued }) => {
                        toast(
                          `Replicating to ${relays.length} relay${relays.length === 1 ? '' : 's'}` +
                            (photosQueued > 0 ? ` (${photosQueued} photos queued)` : ''),
                        );
                      })
                      .catch((err: unknown) => {
                        toastError(err instanceof Error ? err.message : 'Replication failed');
                      });
                  }}
                >
                  Replicate to all my relays
                </button>
                <p className="tiny faint">
                  This inventory was shared with you, so it is never pushed to your relays
                  automatically. This button replicates it (and its photos) to every relay enabled
                  on this device, so it stays available to you if the sharer&apos;s relay
                  disappears.
                </p>
              </>
            ) : null}
            <p className="small" style={{ marginTop: 4 }}>
              End-to-end encrypted
            </p>
            <p className="tiny faint">
              Items and photos are encrypted on this device before they reach any relay. The
              relays, and anyone who can read their disks, only store ciphertext. The decryption
              key travels inside share links and backups only.
            </p>
          </section>

          <section className="card stack tight">
            <SectionTitle>This device</SectionTitle>
            <button type="button" className="btn danger" onClick={() => setConfirmForget(true)}>
              Forget this inventory…
            </button>
            <p className="tiny faint">
              Removes the local copy and the stored tokens from this device only. Other devices keep
              their copy.
            </p>
          </section>
        </div>
      </main>

      {deleteBox ? (
        <ConfirmModal
          title="Delete box"
          body={`Items in "${deleteBox.label}" stay in the inventory and lose their box assignment.`}
          confirmLabel="Delete box"
          destructive
          onClose={() => setDeleteBox(null)}
          onConfirm={() => {
            inv.deleteBox(deleteBox.id);
            toast('Box deleted');
          }}
        />
      ) : null}

      {confirmForget ? (
        <ConfirmModal
          title="Forget inventory"
          body="The local copy and the share tokens are deleted from this device, and the inventory leaves the list on your linked devices too (their downloaded data is kept). Make sure someone else still has a link before continuing."
          confirmLabel="Forget"
          destructive
          onClose={() => setConfirmForget(false)}
          onConfirm={() => {
            forgetInventory(docId)
              .then(() => {
                toast('Inventory removed from this device');
                navigate('/', { replace: true });
              })
              .catch((err: unknown) => {
                toastError(err instanceof Error ? err.message : 'Could not forget the inventory');
              });
          }}
        />
      ) : null}
    </>
  );
}
