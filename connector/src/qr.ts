/**
 * QR decoding for onboarding, ported from the app (app/src/ui/lib/qrDecode.ts
 * and app/src/ui/components/QrScanner.tsx): native BarcodeDetector where
 * Chrome supports it, jsQR fallback everywhere else. Failures are "no
 * result", never throws — callers show one consistent error UI.
 */

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

/** Decode a QR code from an uploaded / dropped / pasted image. */
export async function decodeQrImage(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const native = await makeNativeDetector();
    const sourceLongEdge = Math.max(bitmap.width, bitmap.height);
    // Two renderings: a fast normal-size pass, then an upscaled pass that
    // also tries inverted modules (dark-mode screenshots).
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

const SCAN_INTERVAL_MS = 200;
const JSQR_MAX_EDGE = 640;

export interface CameraScanner {
  stop(): void;
}

/**
 * Live camera scan loop (mirrors the app's QrScanner): attach a stream to
 * `video`, decode every 200 ms, call `onResult` once per distinct code.
 * `onError` receives a user-displayable message when the camera cannot start.
 */
export async function startCameraScan(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError: (message: string) => void,
): Promise<CameraScanner> {
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastValue = '';

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
  };

  if (!navigator.mediaDevices?.getUserMedia) {
    onError('Camera access is not available in this browser.');
    return { stop };
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    onError(
      name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access for this extension and try again.'
        : name === 'NotFoundError'
          ? 'No camera found on this device.'
          : 'Could not start the camera.',
    );
    return { stop };
  }
  if (stopped) {
    stream.getTracks().forEach((t) => t.stop());
    return { stop };
  }
  video.srcObject = stream;
  await video.play().catch(() => {});

  const native = await makeNativeDetector();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (video.readyState >= 2) {
      let value: string | null = null;
      if (native) {
        try {
          const codes = await native.detect(video);
          value = codes[0]?.rawValue ?? null;
        } catch {
          /* frame not ready; retry next tick */
        }
      } else if (ctx) {
        const scale = Math.min(1, JSQR_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        value = code?.data ?? null;
      }
      if (value && value !== lastValue) {
        lastValue = value;
        onResult(value);
      }
      if (!value) lastValue = '';
    }
    timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
  };
  void tick();
  return { stop };
}
