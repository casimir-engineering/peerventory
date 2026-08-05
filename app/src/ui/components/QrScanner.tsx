import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

/** Native BarcodeDetector (Chrome/Edge/Android WebView); jsQR fallback elsewhere. */
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
  const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = await Ctor.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    return new Ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

const SCAN_INTERVAL_MS = 200;
/**
 * Downscaling helps jsQR find the finder patterns, but cutting a dense code
 * below ~2px per module destroys it. 1024 keeps a version-25 code readable
 * while staying fast enough for a 5fps loop.
 */
const JSQR_MAX_EDGE = 1024;
/** Nothing decoded for this long: tell the user instead of staring silently. */
const STALLED_AFTER_MS = 6_000;

export function QrScanner({
  onResult,
  onStalled,
  paused = false,
}: {
  /** Called once per decoded code; scanning pauses until `paused` flips back to false. */
  onResult: (text: string) => void;
  /** Fired once when several seconds of scanning have decoded nothing at all. */
  onStalled?: () => void;
  /** Freeze scanning (e.g. while showing an "invalid code" message). */
  paused?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onStalledRef = useRef(onStalled);
  onStalledRef.current = onStalled;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stalledTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let lastValue = '';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera access is not available in this browser.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // A denser code needs the pixels: a 640x480 default frame cannot
          // resolve the modules of anything past about QR version 15.
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access and try again.'
            : name === 'NotFoundError'
              ? 'No camera found on this device.'
              : 'Could not start the camera.',
        );
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const native = await makeNativeDetector();

      stalledTimer = setTimeout(() => {
        if (!stopped) onStalledRef.current?.();
      }, STALLED_AFTER_MS);

      const tick = async () => {
        if (stopped) return;
        const v = videoRef.current;
        if (v && v.readyState >= 2 && !pausedRef.current) {
          let value: string | null = null;
          if (native) {
            try {
              const codes = await native.detect(v);
              value = codes[0]?.rawValue ?? null;
            } catch {
              /* frame not ready; retry next tick */
            }
          } else if (ctx) {
            const scale = Math.min(1, JSQR_MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
            canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, {
              inversionAttempts: 'dontInvert',
            });
            value = code?.data ?? null;
          }
          if (value && value !== lastValue) {
            lastValue = value;
            if (stalledTimer) {
              clearTimeout(stalledTimer);
              stalledTimer = null;
            }
            onResultRef.current(value);
          }
          if (!value) lastValue = '';
        }
        timer = setTimeout(tick, SCAN_INTERVAL_MS);
      };
      void tick();
    }

    void start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stalledTimer) clearTimeout(stalledTimer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  if (error) {
    return (
      <div className="qr-scanner error">
        <p className="muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="qr-scanner">
      {/* muted+playsInline are required for autoplay inside Android WebView and iOS Safari */}
      <video ref={videoRef} muted playsInline />
      <div className="qr-reticle" aria-hidden="true" />
    </div>
  );
}
