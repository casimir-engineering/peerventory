/**
 * Decode / downscale / re-encode, written to run unchanged on the main thread
 * and inside image.worker.ts (see imagePipeline.ts for the dispatch).
 *
 * The expensive part of storing a phone photo is decoding it: a 12MP JPEG is
 * ~36MB of pixels before anything is scaled. Two things avoid that here:
 * a header-only size probe (no decode at all when the capture is already
 * small enough), and createImageBitmap's resize options, which let the
 * browser decode straight into the target size — on Android that is the
 * hardware JPEG path, several times faster than decode + canvas scale.
 */

export const MAX_EDGE = 2048;
export const JPEG_QUALITY = 0.85;

export interface NormalizedImage {
  bytes: Blob;
  mime: string;
}

export interface ProbedSize {
  width: number;
  height: number;
  /** EXIF orientation, 1..8; 5..8 swap width and height when applied. */
  orientation: number;
}

/* ---------- header-only size probe ---------- */

/** Enough for a JPEG's EXIF block (thumbnail included) and then some. */
const PROBE_BYTES = 256 * 1024;

/**
 * Pixel size straight out of the file header, without decoding. Returns null
 * for anything unrecognised, in which case callers fall back to decoding.
 */
export async function probeImageSize(blob: Blob): Promise<ProbedSize | null> {
  try {
    const head = new DataView(await blob.slice(0, PROBE_BYTES).arrayBuffer());
    return probeJpeg(head) ?? probePng(head) ?? probeWebp(head);
  } catch {
    return null;
  }
}

/** SOF0..SOF15 minus the markers that are not frame headers (DHT/JPG/DAC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function probeJpeg(v: DataView): ProbedSize | null {
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= v.byteLength) {
    // Segments are 0xFF-prefixed; fill bytes between them are skipped.
    if (v.getUint8(offset) !== 0xff) {
      offset++;
      continue;
    }
    const marker = v.getUint8(offset + 1);
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // entropy data: no frame header seen
    const length = v.getUint16(offset + 2);
    if (length < 2) return null;
    const payload = offset + 4;
    if (marker === 0xe1) orientation = exifOrientation(v, payload) ?? orientation;
    if (isStartOfFrame(marker) && payload + 5 <= v.byteLength) {
      const height = v.getUint16(payload + 1);
      const width = v.getUint16(payload + 3);
      if (width > 0 && height > 0) return { width, height, orientation };
    }
    offset = payload + length - 2;
  }
  return null;
}

/** Orientation tag out of an APP1/Exif segment starting at `start`. */
function exifOrientation(v: DataView, start: number): number | null {
  if (start + 16 > v.byteLength) return null;
  if (v.getUint32(start) !== 0x45786966 || v.getUint16(start + 4) !== 0) return null; // "Exif\0\0"
  const tiff = start + 6;
  const little = v.getUint16(tiff) === 0x4949;
  if (!little && v.getUint16(tiff) !== 0x4d4d) return null;
  if (v.getUint16(tiff + 2, little) !== 42) return null;
  const ifd0 = tiff + v.getUint32(tiff + 4, little);
  if (ifd0 + 2 > v.byteLength) return null;
  const count = v.getUint16(ifd0, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > v.byteLength) break;
    if (v.getUint16(entry, little) !== 0x0112) continue;
    const value = v.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

function probePng(v: DataView): ProbedSize | null {
  if (v.byteLength < 24) return null;
  if (v.getUint32(0) !== 0x89504e47 || v.getUint32(4) !== 0x0d0a1a0a) return null;
  if (v.getUint32(12) !== 0x49484452) return null; // "IHDR"
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  return width > 0 && height > 0 ? { width, height, orientation: 1 } : null;
}

function probeWebp(v: DataView): ProbedSize | null {
  if (v.byteLength < 30) return null;
  if (v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57454250) return null; // "RIFF"/"WEBP"
  const chunk = v.getUint32(12);
  if (chunk === 0x56503858) {
    // VP8X: canvas size as two 24-bit little-endian values, minus one.
    const width = (v.getUint8(24) | (v.getUint8(25) << 8) | (v.getUint8(26) << 16)) + 1;
    const height = (v.getUint8(27) | (v.getUint8(28) << 8) | (v.getUint8(29) << 16)) + 1;
    return { width, height, orientation: 1 };
  }
  if (chunk === 0x56503820) {
    // VP8 (lossy): keyframe sync code, then 14-bit width/height.
    if (v.getUint8(23) !== 0x9d || v.getUint8(24) !== 0x01 || v.getUint8(25) !== 0x2a) return null;
    return {
      width: v.getUint16(26, true) & 0x3fff,
      height: v.getUint16(28, true) & 0x3fff,
      orientation: 1,
    };
  }
  if (chunk === 0x5650384c) {
    // VP8L (lossless): 14-bit width/height packed after the 0x2f signature.
    const bits = v.getUint32(21, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      orientation: 1,
    };
  }
  return null;
}

/* ---------- decode ---------- */

/**
 * Decode `blob`, asking the browser to scale down to `maxEdge` as part of the
 * decode when it can. Only the long edge is constrained, so the aspect ratio
 * is the browser's to keep: that stays correct whether it measures the image
 * before or after applying the EXIF rotation. A browser that ignores the
 * resize options simply returns the full-size bitmap, which drawToJpeg then
 * scales the old way.
 */
export async function decodeScaled(
  blob: Blob,
  maxEdge: number,
  probed?: ProbedSize | null,
): Promise<ImageBitmap> {
  const size = probed === undefined ? await probeImageSize(blob) : probed;
  const options: ImageBitmapOptions = { imageOrientation: 'from-image' };
  if (size && Math.max(size.width, size.height) > maxEdge) {
    // Rotated captures (orientation 5..8) come out with the axes swapped.
    const swapped = size.orientation >= 5;
    const width = swapped ? size.height : size.width;
    const height = swapped ? size.width : size.height;
    if (width >= height) options.resizeWidth = maxEdge;
    else options.resizeHeight = maxEdge;
    // resizeQuality is left at the browser default on purpose: measured on
    // Chromium, 'high' costs ~2x the whole decode for a result that differs
    // from the default by ~1.8/255 per channel — which is also how far the
    // canvas drawImage this replaces sat from it.
  }
  try {
    return await createImageBitmap(blob, options);
  } catch {
    // Old WebViews reject unknown ImageBitmapOptions members instead of
    // ignoring them; a plain decode still works there.
    return createImageBitmap(blob);
  }
}

/* ---------- encode ---------- */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): AnyCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function context2d(
  canvas: AnyCanvas,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  return 'convertToBlob' in canvas ? canvas.getContext('2d') : canvas.getContext('2d');
}

export async function canvasToBlob(
  canvas: AnyCanvas,
  type: string,
  quality: number,
): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality }).catch(() => null);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Draw (scaling down if the decode did not already) and encode as JPEG. */
async function drawToJpeg(
  bitmap: ImageBitmap,
  maxEdge: number,
  quality: number,
): Promise<Blob | null> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const ctx = context2d(canvas);
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvasToBlob(canvas, 'image/jpeg', quality);
}

/**
 * The stored form of a capture: JPEG, long edge at most `maxEdge`. Undecodable
 * bytes are passed through untouched (the store keeps them as captured).
 */
export async function resizeToJpeg(
  blob: Blob,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
  probed?: ProbedSize | null,
): Promise<NormalizedImage> {
  const asIs = (): NormalizedImage => ({
    bytes: blob,
    mime: blob.type || 'application/octet-stream',
  });
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeScaled(blob, maxEdge, probed);
  } catch {
    return asIs();
  }
  try {
    const out = await drawToJpeg(bitmap, maxEdge, quality);
    return out ? { bytes: out, mime: 'image/jpeg' } : asIs();
  } finally {
    bitmap.close();
  }
}
