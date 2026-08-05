/**
 * The one place a capture becomes the stored form of a photo (<=2048px JPEG).
 *
 * Order of preference, fastest first:
 *   1. nothing at all — the header says the capture already fits;
 *   2. a worker with OffscreenCanvas, so the decode never blocks a frame;
 *   3. the main thread, for browsers without module workers or OffscreenCanvas.
 */
import {
  JPEG_QUALITY,
  MAX_EDGE,
  probeImageSize,
  resizeToJpeg,
  type NormalizedImage,
  type ProbedSize,
} from './imageCodec';
import type { ResizeRequest, ResizeResponse } from './image.worker';

/** undefined = not tried yet, null = unusable here. */
let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, (result: NormalizedImage | null) => void>();

function settleAll(): void {
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker !== 'function' || typeof OffscreenCanvas === 'undefined') return worker;
  try {
    const spawned = new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' });
    spawned.onmessage = (event: MessageEvent<ResizeResponse>) => {
      const message = event.data;
      const resolve = pending.get(message.id);
      if (!resolve) return;
      pending.delete(message.id);
      resolve(message.ok ? { bytes: message.bytes, mime: message.mime } : null);
    };
    spawned.onerror = () => {
      // Whatever broke, it breaks for every request: stop using the worker.
      worker = null;
      settleAll();
    };
    worker = spawned;
  } catch {
    worker = null;
  }
  return worker;
}

function runInWorker(
  blob: Blob,
  maxEdge: number,
  quality: number,
  probed: ProbedSize | null,
): Promise<NormalizedImage | null> {
  const active = getWorker();
  if (!active) return Promise.resolve(null);
  const id = nextId++;
  return new Promise<NormalizedImage | null>((resolve) => {
    pending.set(id, resolve);
    try {
      active.postMessage({ id, blob, maxEdge, quality, probed } satisfies ResizeRequest);
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Dev-only: the numbers behind "why did that photo take so long". */
export function logPhotoTiming(step: string, startedAt: number, extra?: string): void {
  if (!import.meta.env.DEV) return;
  const ms = Math.round(nowMs() - startedAt);
  console.debug(`[photo] ${step} ${ms}ms${extra ? ` ${extra}` : ''}`);
}

/**
 * Camera photos off a modern phone are 4000px+ and several MB. The blob
 * contract hashes the *final* bytes, so this is what defines them.
 */
export async function normalizeImage(
  blob: Blob,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
): Promise<NormalizedImage> {
  const startedAt = nowMs();
  const probed = await probeImageSize(blob);
  const source = probed ? `${probed.width}x${probed.height}` : 'unknown size';

  // A capture that already fits is stored byte for byte: no decode, no
  // re-encode, no generation loss.
  const compact = probed !== null && Math.max(probed.width, probed.height) <= maxEdge;
  if (compact && (blob.type === 'image/jpeg' || blob.type === 'image/webp')) {
    logPhotoTiming('kept as captured', startedAt, `${source} ${Math.round(blob.size / 1024)}KB`);
    return { bytes: blob, mime: blob.type };
  }

  const viaWorker = await runInWorker(blob, maxEdge, quality, probed);
  if (viaWorker) {
    logPhotoTiming('resized in worker', startedAt, `${source} -> ${Math.round(viaWorker.bytes.size / 1024)}KB`);
    return viaWorker;
  }

  const out = await resizeToJpeg(blob, maxEdge, quality, probed);
  logPhotoTiming('resized on main thread', startedAt, `${source} -> ${Math.round(out.bytes.size / 1024)}KB`);
  return out;
}
