/**
 * Downscale + JPEG encode off the main thread, so the frame that shows the
 * instant preview of a capture is never blocked by its decode. Driven by
 * imagePipeline.ts, which falls back to the main thread if this fails to
 * start (no module workers / no OffscreenCanvas).
 */
import { resizeToJpeg, type ProbedSize } from './imageCodec';

export interface ResizeRequest {
  id: number;
  blob: Blob;
  maxEdge: number;
  quality: number;
  /** Already probed on the caller's side; skips re-reading the header here. */
  probed: ProbedSize | null;
}

export type ResizeResponse =
  | { id: number; ok: true; bytes: Blob; mime: string }
  | { id: number; ok: false; error: string };

/**
 * The project compiles against the DOM lib, where `self` is a Window; the two
 * members this worker needs are declared rather than pulling in (and clashing
 * with) the webworker lib.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ResizeRequest>) => void) | null;
  postMessage(message: ResizeResponse): void;
}

const worker = self as unknown as WorkerScope;

worker.onmessage = async (event: MessageEvent<ResizeRequest>) => {
  const { id, blob, maxEdge, quality, probed } = event.data;
  try {
    const { bytes, mime } = await resizeToJpeg(blob, maxEdge, quality, probed);
    worker.postMessage({ id, ok: true, bytes, mime } satisfies ResizeResponse);
  } catch (err) {
    worker.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ResizeResponse);
  }
};
