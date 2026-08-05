import { useEffect, useMemo, useState } from 'react';
import { moveItemToInventory, snapshotInventory, useInventories } from '../../store';
import type { MoveItemResult } from '../../store';
import type { Id, InventoryHandle } from '../../types';
import { Modal } from './Modal';

export type ItemMoved = Extract<MoveItemResult, { status: 'moved' }>;

interface Candidate {
  docId: Id;
  name: string;
  itemCount: number | null;
}

/**
 * Inventories this device can write into: a move needs the read-write token
 * AND the content key on both sides (the photos are re-encrypted for the
 * target). Read-only and key-missing handles are left out entirely.
 */
function writableTargets(handles: InventoryHandle[], exclude: Id): InventoryHandle[] {
  return handles.filter((h) => h.docId !== exclude && !h.readonly && h.rwToken && h.key);
}

export function MoveItemModal({
  docId,
  itemId,
  onClose,
  onMoved,
}: {
  docId: Id;
  itemId: Id;
  onClose: () => void;
  onMoved: (target: { docId: Id; name: string }, result: ItemMoved) => void;
}) {
  const { handles } = useInventories();
  const targets = useMemo(() => writableTargets(handles, docId), [handles, docId]);
  const [candidates, setCandidates] = useState<Candidate[]>(() =>
    targets.map((h) => ({ docId: h.docId, name: h.name || 'Untitled inventory', itemCount: null })),
  );
  const [selected, setSelected] = useState<Id | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingPhotos, setMissingPhotos] = useState<{ missing: number; total: number } | null>(
    null,
  );

  // Names and item counts come from the locally persisted docs; like the
  // inventory list, this never waits on the network.
  const targetKey = targets.map((h) => h.docId).join(',');
  useEffect(() => {
    let alive = true;
    void Promise.all(
      targets.map(async (handle): Promise<Candidate> => {
        const fallback = handle.name || 'Untitled inventory';
        try {
          const snap = await snapshotInventory(handle.docId);
          return {
            docId: handle.docId,
            name: snap.meta.name || fallback,
            itemCount: snap.items.length,
          };
        } catch {
          return { docId: handle.docId, name: fallback, itemCount: null };
        }
      }),
    ).then((loaded) => {
      if (alive) setCandidates(loaded);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const nameOf = (target: Id) =>
    candidates.find((c) => c.docId === target)?.name ?? 'the other inventory';

  const move = async (dropMissingPhotos: boolean) => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await moveItemToInventory(docId, selected, itemId, { dropMissingPhotos });
      if (result.status === 'photos-missing') {
        setMissingPhotos({ missing: result.photosMissing, total: result.photosTotal });
        return;
      }
      onMoved({ docId: selected, name: nameOf(selected) }, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The item could not be moved');
    } finally {
      setBusy(false);
    }
  };

  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  return (
    <Modal
      title="Move to another inventory"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={!selected || busy || candidates.length === 0}
            onClick={() => void move(missingPhotos !== null)}
          >
            {busy
              ? 'Moving…'
              : missingPhotos
                ? `Move without ${missingPhotos.missing} ${plural(missingPhotos.missing, 'photo', 'photos')}`
                : 'Move item'}
          </button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="small muted">
          There is no other inventory on this device you can write to. Create or open a second
          inventory with edit rights first.
        </p>
      ) : (
        <>
          <div className="card flush">
            <div className="list-rows">
              {candidates.map((candidate) => (
                <button
                  key={candidate.docId}
                  type="button"
                  className="list-row"
                  aria-pressed={selected === candidate.docId}
                  onClick={() => {
                    setSelected(candidate.docId);
                    setMissingPhotos(null);
                    setError(null);
                  }}
                >
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{candidate.name}</div>
                    <div className="tiny faint">
                      {candidate.itemCount === null
                        ? '…'
                        : `${candidate.itemCount} ${plural(candidate.itemCount, 'item', 'items')}`}
                    </div>
                  </div>
                  {selected === candidate.docId ? (
                    <span className="chip accent">Selected</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          <p className="tiny faint">
            The whole item moves: quantity, translations, and the full location and owner history.
            Photos are re-encrypted for the target inventory and queued for upload, so this works
            offline. A box assignment only survives when the target has a box with the same name,
            and share links pointing at this item stop working.
          </p>
        </>
      )}

      {missingPhotos ? (
        <p className="small warn-text">
          {missingPhotos.missing} of {missingPhotos.total}{' '}
          {plural(missingPhotos.total, 'photo is', 'photos are')} not on this device and could not
          be downloaded. Moving now leaves {plural(missingPhotos.missing, 'it', 'them')} behind for
          good — connect this device to a relay first, or move without{' '}
          {plural(missingPhotos.missing, 'it', 'them')}.
        </p>
      ) : null}
      {error ? <p className="small warn-text">{error}</p> : null}
    </Modal>
  );
}
