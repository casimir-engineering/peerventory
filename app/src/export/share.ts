/**
 * OS share sheet for exported files, with a download fallback so a failed or
 * dismissed share never loses the file.
 *
 * - Capacitor APK: the WebView has no navigator.share and blob-anchor
 *   downloads silently do nothing, so the file is written to the app cache
 *   and handed to the native share sheet. There is no second chance here:
 *   when the sheet cannot be opened the outcome is 'failed', never a
 *   "downloaded" that did not happen.
 * - Browser: Web Share API level 2 (files) when available, else the classic
 *   anchor download.
 */

import { Capacitor } from '@capacitor/core';

import { downloadBlob } from './download';

export interface OutFile {
  blob: Blob;
  filename: string;
}

/**
 * Where the file actually ended up. 'canceled' means the user dismissed the
 * sheet (nothing to apologise for); 'failed' means nothing left the app.
 */
export type ShareOutcome = 'shared' | 'downloaded' | 'canceled' | 'failed';

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/** A dismissed sheet rejects like an error; only the message tells them apart. */
function isCancel(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /cancel|abort|dismiss/i.test(message);
}

async function shareNative(files: OutFile[], title: string): Promise<ShareOutcome> {
  let uris: string[];
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    uris = [];
    for (const file of files) {
      const written = await Filesystem.writeFile({
        path: `exports/${file.filename}`,
        data: await blobToBase64(file.blob),
        directory: Directory.Cache,
        recursive: true,
      });
      uris.push(written.uri);
    }
  } catch (err) {
    console.warn('[export] could not stage the file for sharing', err);
    return 'failed';
  }
  try {
    const { Share } = await import('@capacitor/share');
    await Share.share({ title, files: uris });
    return 'shared';
  } catch (err) {
    return isCancel(err) ? 'canceled' : 'failed';
  }
}

async function shareWeb(files: OutFile[], title: string): Promise<ShareOutcome> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return 'failed';
  const shareFiles = files.map((f) => new File([f.blob], f.filename, { type: f.blob.type }));
  if (typeof navigator.canShare !== 'function' || !navigator.canShare({ files: shareFiles })) {
    return 'failed';
  }
  try {
    await navigator.share({ files: shareFiles, title });
    return 'shared';
  } catch (err) {
    return isCancel(err) ? 'canceled' : 'failed';
  }
}

/**
 * Opens the share sheet when possible; on the web a refusal falls back to a
 * plain download. Native has no fallback — see the note at the top.
 */
export async function shareOrDownloadFiles(
  files: OutFile[],
  title: string,
): Promise<ShareOutcome> {
  if (files.length === 0) return 'failed';
  if (Capacitor.isNativePlatform()) return shareNative(files, title);

  const outcome = await shareWeb(files, title);
  if (outcome !== 'failed') return outcome;
  for (const file of files) downloadBlob(file.blob, file.filename);
  return 'downloaded';
}

export async function shareOrDownloadFile(
  blob: Blob,
  filename: string,
  title: string,
): Promise<ShareOutcome> {
  return shareOrDownloadFiles([{ blob, filename }], title);
}
