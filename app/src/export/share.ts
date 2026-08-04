/**
 * OS share sheet for exported files, with a download fallback so a failed or
 * dismissed share never loses the file.
 *
 * - Capacitor APK: the WebView has no navigator.share and blob-anchor
 *   downloads are unreliable, so the file is written to the app cache and
 *   handed to the native share sheet.
 * - Browser: Web Share API level 2 (files) when available, else the classic
 *   anchor download.
 */

import { Capacitor } from '@capacitor/core';

import { downloadBlob } from './download';

export type ShareOutcome = 'shared' | 'downloaded';

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

async function shareNative(blob: Blob, filename: string, title: string): Promise<boolean> {
  try {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor/share'),
    ]);
    const written = await Filesystem.writeFile({
      path: `exports/${filename}`,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({ title, files: [written.uri] });
    return true;
  } catch {
    // Plugin missing, write failed, or the user dismissed the sheet.
    return false;
  }
}

async function shareWeb(blob: Blob, filename: string, title: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
  const file = new File([blob], filename, { type: blob.type });
  if (typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) {
    return false;
  }
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch {
    return false;
  }
}

/** Opens the share sheet when possible; falls back to a plain download. */
export async function shareOrDownloadFile(
  blob: Blob,
  filename: string,
  title: string,
): Promise<ShareOutcome> {
  const shared = Capacitor.isNativePlatform()
    ? await shareNative(blob, filename, title)
    : await shareWeb(blob, filename, title);
  if (shared) return 'shared';
  downloadBlob(blob, filename);
  return 'downloaded';
}
