/**
 * Camera photos off a modern phone are 4000px+ / several MB. The blob contract
 * hashes the *final* bytes (max 2048px), so images are downscaled here before
 * they ever reach the store. Safe to drop if the store downscales internally.
 */

const MAX_EDGE = 2048;
const QUALITY = 0.85;

export async function downscaleImage(file: Blob, maxEdge = MAX_EDGE): Promise<Blob> {
  try {
    const bitmap = await loadBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    if (scale >= 1 && file.size < 1_500_000) {
      closeBitmap(bitmap);
      return file;
    }
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      closeBitmap(bitmap);
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    closeBitmap(bitmap);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', QUALITY);
    });
    return blob ?? file;
  } catch {
    return file;
  }
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
  } finally {
    // The bitmap is already decoded into the element by the time it loads.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function closeBitmap(bitmap: ImageBitmap | HTMLImageElement): void {
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
}
