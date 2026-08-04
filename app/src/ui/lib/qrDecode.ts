import jsQR from 'jsqr';

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

async function makeNativeDetector(): Promise<BarcodeDetectorLike | null> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;
  if (!Ctor) return null;

  try {
    const formats = await Ctor.getSupportedFormats();
    return formats.includes('qr_code') ? new Ctor({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

/**
 * Decode a QR code from a screenshot or photo. Image and detector failures are
 * deliberately treated as "no result" so callers can show one consistent UI.
 */
export async function decodeQrImage(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;

  try {
    bitmap = await createImageBitmap(blob);
    const native = await makeNativeDetector();
    const sourceLongEdge = Math.max(bitmap.width, bitmap.height);
    const attempts = [
      { scale: Math.min(1, 1400 / sourceLongEdge), inversion: 'dontInvert' as const },
      { scale: Math.min(2, 2800 / sourceLongEdge), inversion: 'attemptBoth' as const },
    ];

    for (const attempt of attempts) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * attempt.scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * attempt.scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;

      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      if (native) {
        try {
          const detected = await native.detect(canvas);
          const value = detected[0]?.rawValue;
          if (value) return value;
        } catch {
          // Fall through to jsQR for this rendering.
        }
      }

      try {
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, {
          inversionAttempts: attempt.inversion,
        });
        if (code?.data) return code.data;
      } catch {
        // Try the second rendering, or return null after it.
      }
    }
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }

  return null;
}
