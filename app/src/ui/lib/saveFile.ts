/**
 * The one way the UI gets a file out of the app.
 *
 * Anchor downloads (`a.download` + blob URL) do nothing at all inside the
 * Capacitor WebView, which is how several exports ended up saying "export
 * ready" while producing no file. Every export therefore goes through
 * shareOrDownloadFiles (native: cache file + OS share sheet, web: Web Share
 * with files, else a download) and reports what actually happened — the
 * toast is never allowed to claim success the user cannot verify.
 */

import { useCallback } from 'react';

import { shareOrDownloadFiles } from '../../export';
import type { OutFile, ShareOutcome } from '../../export';
import { useToast } from '../components/Toast';

export type { OutFile, ShareOutcome };

export interface FileSaver {
  /** `label` names the file in the toast, e.g. "YAML export". */
  saveFile(blob: Blob, filename: string, label: string): Promise<ShareOutcome>;
  saveFiles(files: OutFile[], label: string): Promise<ShareOutcome>;
}

export function useFileSaver(): FileSaver {
  const { toast, toastError } = useToast();

  const saveFiles = useCallback(
    async (files: OutFile[], label: string): Promise<ShareOutcome> => {
      const outcome = await shareOrDownloadFiles(files, label);
      if (outcome === 'shared') toast(`${label} shared`);
      else if (outcome === 'downloaded') toast(`${label} downloaded`);
      else if (outcome === 'canceled') toast('Sharing canceled — nothing was saved');
      else toastError(`Could not save ${label} — no app accepted the file`);
      return outcome;
    },
    [toast, toastError],
  );

  const saveFile = useCallback(
    (blob: Blob, filename: string, label: string) => saveFiles([{ blob, filename }], label),
    [saveFiles],
  );

  return { saveFile, saveFiles };
}

/** data:...;base64,... produced by canvas/QR rendering, as a Blob. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const mime = /data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}
