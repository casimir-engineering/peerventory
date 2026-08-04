import { useState } from 'react';
import { getPhotoBlob, snapshotInventory } from '../../store';
import {
  downloadBlob,
  downloadText,
  inventoryToXlsx,
  inventoryToYaml,
  inventoryToZip,
} from '../../export';
import type { Id, InventorySnapshot } from '../../types';
import { safeFilename } from '../lib/format';
import { Spinner } from './Common';
import { useToast } from './Toast';

type ExportKind = 'yaml' | 'xlsx' | 'zip';

/**
 * Exports are the customs deliverable, so they are reachable from settings and
 * from any list. `itemIds` narrows the spreadsheet to the current selection.
 */
export function ExportButtons({
  docId,
  inventoryName,
  itemIds,
  selectionLabel,
}: {
  docId: Id;
  inventoryName: string;
  itemIds?: Id[];
  selectionLabel?: string;
}) {
  const { toast, toastError } = useToast();
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const base = safeFilename(inventoryName);

  const run = async (kind: ExportKind) => {
    if (busy) return;
    setBusy(kind);
    try {
      const snapshot: InventorySnapshot = await snapshotInventory(docId);
      if (kind === 'yaml') {
        downloadText(inventoryToYaml(snapshot), `${base}.yaml`);
      } else if (kind === 'xlsx') {
        const blob = await inventoryToXlsx(snapshot, itemIds);
        downloadBlob(blob, `${base}.xlsx`);
      } else {
        const blob = await inventoryToZip(snapshot, (hash: string) => getPhotoBlob(docId, hash));
        downloadBlob(blob, `${base}.zip`);
      }
      toast('Export ready');
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  const xlsxLabel = itemIds ? `XLSX (${selectionLabel ?? `${itemIds.length} items`})` : 'XLSX';

  return (
    <div className="stack tight">
      <div className="row wrap">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => run('yaml')}>
          {busy === 'yaml' ? <Spinner /> : null} YAML
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => run('xlsx')}>
          {busy === 'xlsx' ? <Spinner /> : null} {xlsxLabel}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => run('zip')}>
          {busy === 'zip' ? <Spinner /> : null} Full archive ZIP
        </button>
      </div>
      <p className="tiny faint">
        {itemIds
          ? 'The spreadsheet covers this list only. YAML and the archive always contain the whole inventory.'
          : 'The archive bundles the spreadsheet, the YAML manifest and every photo.'}
      </p>
    </div>
  );
}
