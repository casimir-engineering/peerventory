/**
 * UI-side image helpers. The downscale itself lives in the store's image
 * pipeline (worker + hardware decode), so a photo prepared here is byte for
 * byte what addPhoto would have stored anyway.
 */
import { normalizeImage } from '../../store';
import { context2d, canvasToBlob, decodeScaled } from '../../store/imageCodec';

const MAX_EDGE = 2048;

export async function downscaleImage(file: Blob, maxEdge = MAX_EDGE): Promise<Blob> {
  try {
    const { bytes } = await normalizeImage(file, maxEdge);
    return bytes;
  } catch {
    return file;
  }
}

const THUMB_MAX_EDGE = 160;
const THUMB_QUALITY = 0.8;

export interface ExportThumb {
  /** JPEG bytes. */
  data: ArrayBuffer;
  width: number;
  height: number;
}

/**
 * Small JPEG thumbnail for embedding into spreadsheet exports. Always
 * re-encodes (sources may be webp/png, which Excel embeds poorly or not at
 * all) and returns pixel dimensions, which the anchor math needs.
 */
export async function makeExportThumb(
  file: Blob,
  maxEdge = THUMB_MAX_EDGE,
): Promise<ExportThumb | null> {
  try {
    const bitmap = await decodeScaled(file, maxEdge);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = context2d(canvas);
    if (!ctx) {
      bitmap.close();
      return null;
    }
    // JPEG has no alpha; keep transparent PNG edges white instead of black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close();

    const blob = await canvasToBlob(canvas, 'image/jpeg', THUMB_QUALITY);
    if (!blob) return null;
    return { data: await blob.arrayBuffer(), width: targetW, height: targetH };
  } catch {
    return null;
  }
}
