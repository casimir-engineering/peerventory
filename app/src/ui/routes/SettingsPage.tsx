import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useInventories, useInventory } from '../../store';
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
import { ShareModal } from '../components/ShareModal';
import { useToast } from '../components/Toast';

export function SettingsPage() {
  const { docId = '' } = useParams();
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const inv: UseInventoryResult = useInventory(docId || null);
  const { forgetInventory }: UseInventoriesResult = useInventories();

  const [sharing, setSharing] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [deleteBox, setDeleteBox] = useState<Box | null>(null);
  const [newBoxLabel, setNewBoxLabel] = useState('');
  const currencyOptions = useCurrencyComboOptions(inv.meta?.currency);

  const readonly = Boolean(inv.readonly);
  const boxes: Box[] = inv.boxes ?? [];
  const itemsPerBox = new Map<string, number>();
  for (const item of inv.items ?? []) {
    if (item.boxId) itemsPerBox.set(item.boxId, (itemsPerBox.get(item.boxId) ?? 0) + 1);
  }

  useEffect(() => {
    document.title = inv.meta?.name ? `${inv.meta.name} — settings` : 'Inventory settings';
    return () => {
      document.title = 'Inventory';
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
            <SectionTitle>Encryption</SectionTitle>
            <p className="small">End-to-end encrypted</p>
            <p className="tiny faint">
              Items and photos are encrypted on this device before they reach the sync server.
              The server, and anyone who can read its disk, only stores ciphertext. The
              decryption key travels inside share links and backups only.
            </p>
          </section>

          <section className="card stack tight">
            <SectionTitle>Share</SectionTitle>
            <p className="small muted">
              A view-only link lets a forwarder or a customs desk read and export this inventory
              without being able to change it.
            </p>
            <button type="button" className="btn primary" onClick={() => setSharing(true)}>
              Show share link and QR code
            </button>
            {readonly ? (
              <p className="tiny faint">
                This device joined with a view-only token, so only view-only links can be created
                from here.
              </p>
            ) : null}
          </section>

          <section className="card stack tight">
            <SectionTitle>Stats</SectionTitle>
            <p className="small muted">
              Review value, weight, volume, box, and category totals for this inventory.
            </p>
            <Link className="btn" to={`/inv/${docId}/stats`}>
              View inventory stats
            </Link>
          </section>

          <section className="card stack tight">
            <SectionTitle>Export</SectionTitle>
            <ExportButtons docId={docId} inventoryName={meta.name} />
          </section>

          <section className="card stack tight">
            <SectionTitle>This device</SectionTitle>
            <Field label="Sync">
              <p className="small muted">
                Items are stored on this device first and sync in the background whenever the server
                is reachable.
              </p>
            </Field>
            <button type="button" className="btn danger" onClick={() => setConfirmForget(true)}>
              Forget this inventory
            </button>
            <p className="tiny faint">
              Removes the local copy and the stored tokens from this device only. Other devices keep
              their copy.
            </p>
          </section>
        </div>
      </main>

      {sharing ? (
        <ShareModal
          docId={docId}
          target={{ kind: 'inventory' }}
          title="Share inventory"
          onClose={() => setSharing(false)}
        />
      ) : null}

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
