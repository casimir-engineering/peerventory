import { useState } from 'react';
import { getPhotoBlob, snapshotInventory } from '../../store';
import { inventoryToXlsx, inventoryToYaml, inventoryToZip } from '../../export';
import { ensureRates } from '../../services/currency';
import type { Id, InventorySnapshot, PhotoRef } from '../../types';
import { safeFilename } from '../lib/format';
import { makeExportThumb } from '../lib/image';
import { useFileSaver } from '../lib/saveFile';
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
  const { toastError } = useToast();
  const { saveFile } = useFileSaver();
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const base = safeFilename(inventoryName);

  const run = async (kind: ExportKind) => {
    if (busy) return;
    setBusy(kind);
    try {
      const snapshot: InventorySnapshot = await snapshotInventory(docId);
      if (kind === 'yaml') {
        const blob = new Blob([inventoryToYaml(snapshot)], {
          type: 'text/yaml;charset=utf-8',
        });
        await saveFile(blob, `${base}.yaml`, 'YAML export');
      } else if (kind === 'xlsx') {
        // Totals are converted to the inventory currency; make sure FX rates
        // are cached (never throws, degrades to per-currency totals offline).
        await ensureRates();
        const loadPhoto = async (photo: PhotoRef) => {
          const photoBlob = await getPhotoBlob(docId, photo.hash);
          return photoBlob ? makeExportThumb(photoBlob) : null;
        };
        const blob = await inventoryToXlsx(snapshot, itemIds, loadPhoto);
        await saveFile(blob, `${base}.xlsx`, 'Spreadsheet');
      } else {
        const blob = await inventoryToZip(snapshot, (hash: string) => getPhotoBlob(docId, hash));
        await saveFile(blob, `${base}.zip`, 'Archive ZIP');
      }
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
