import { useState } from 'react';

import { importSnapshot } from '../../store';
import type { ParsedImport } from '../lib/importFile';
import { Spinner } from './Common';
import { Modal } from './Modal';
import { useToast } from './Toast';

export function ImportModal({
  parsed,
  fileName,
  onClose,
  onImported,
}: {
  parsed: ParsedImport;
  fileName: string;
  onClose: () => void;
  onImported: (docId: string) => void;
}) {
  const { toastError } = useToast();
  const [busy, setBusy] = useState(false);
  const photoReferenceCount = parsed.snapshot.items.reduce(
    (total, item) => total + item.photos.length,
    0,
  );

  const runImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const docId = await importSnapshot(parsed.snapshot, parsed.photoBlobs);
      onImported(docId);
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not import the inventory');
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal
      title="Import inventory"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn grow" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={busy}
            onClick={() => void runImport()}
          >
            {busy ? <Spinner /> : null}
            {busy ? 'Importing' : 'Import as new inventory'}
          </button>
        </>
      }
    >
      <div className="stack tight">
        <p>
          <strong>{parsed.snapshot.meta.name}</strong>
        </p>
        <p className="tiny faint">{fileName}</p>
      </div>

      <div className="stack tight">
        <p>{parsed.snapshot.items.length} items</p>
        <p>{parsed.snapshot.boxes.length} boxes</p>
        {parsed.photoBlobs.size > 0 ? (
          <p>{parsed.photoBlobs.size} photos included</p>
        ) : photoReferenceCount > 0 ? (
          <p>
            {photoReferenceCount} photo references without files (YAML has no photos — import the
            ZIP to keep them)
          </p>
        ) : null}
        {parsed.skippedItems > 0 ? <p>{parsed.skippedItems} invalid items skipped</p> : null}
      </div>

      <p className="small muted">
        This creates a fresh inventory with new share tokens. It does not merge into an existing
        inventory.
      </p>
    </Modal>
  );
}
