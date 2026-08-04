import { useEffect, useRef, useState } from 'react';
import { OEM, PSM, createWorker } from 'tesseract.js';
import type { Worker as OcrWorker } from 'tesseract.js';

/*
 * Continuous camera OCR. Every asset tesseract needs is served from
 * /public/ocr, so a pass never touches the network: the app also runs from an
 * Android WebView and from places where a CDN is not reachable.
 */

const OCR_BASE = `${import.meta.env.BASE_URL}ocr`;

/** wasm-feature-detect's SIMD probe, inlined to keep it on the main thread. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

/** Only the two bundled cores exist locally, so the variant is picked here. */
function corePath(): string {
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_PROBE);
  } catch {
    /* very old engine: the plain core still runs */
  }
  return `${OCR_BASE}/tesseract-core-${simd ? 'simd-' : ''}lstm.wasm.js`;
}

const IDLE_TERMINATE_MS = 60_000;

let workerPromise: Promise<OcrWorker> | null = null;
let users = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** One worker for the whole app: starting it costs seconds. */
function acquireWorker(): Promise<OcrWorker> {
  users += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!workerPromise) {
    const started = createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${OCR_BASE}/worker.min.js`,
      corePath: corePath(),
      // Reads eng.traineddata.gz from here, then caches it in IndexedDB.
      langPath: OCR_BASE,
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        user_defined_dpi: '300',
      });
      return worker;
    });
    // A failed start must not be cached, or every later open fails with it.
    started.catch(() => {
      if (workerPromise === started) workerPromise = null;
    });
    workerPromise = started;
  }
  return workerPromise;
}

/** Kept warm briefly, because scanning two items in a row is the normal case. */
function releaseWorker(): void {
  users = Math.max(0, users - 1);
  if (users > 0 || workerPromise === null || idleTimer !== null) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const pending = workerPromise;
    workerPromise = null;
    void pending?.then((worker) => worker.terminate()).catch(() => {});
  }, IDLE_TERMINATE_MS);
}

const PASS_INTERVAL_MS = 1500;
const PASS_WIDTH = 1000;
const MAX_CANDIDATES = 4;
/** Share of the frame the reticle covers; mirrors `.ocr-band` in entry.css. */
const BAND = { x: 0.06, y: 0.36, w: 0.88, h: 0.28 };

/** Central band of the frame, downscaled and greyscaled for the recognizer. */
function grabBand(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): boolean {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (vw === 0 || vh === 0) return false;
  const sw = vw * BAND.w;
  const sh = vh * BAND.h;
  canvas.width = PASS_WIDTH;
  canvas.height = Math.max(1, Math.round((sh * PASS_WIDTH) / sw));
  ctx.drawImage(video, vw * BAND.x, vh * BAND.y, sw, sh, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = frame.data;
  for (let i = 0; i < px.length; i += 4) {
    const grey = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    px[i] = grey;
    px[i + 1] = grey;
    px[i + 2] = grey;
  }
  ctx.putImageData(frame, 0, 0);
  return true;
}

export function OcrScanner({
  match,
  onResult,
  onCandidates,
  paused = false,
}: {
  /** Picks the wanted value out of one pass, or null when nothing fits. */
  match: (lines: string[]) => string | null;
  /** Fired once a value was read twice in a row, or when a chip is tapped. */
  onResult: (text: string) => void;
  /** Every value the matcher accepted in the latest pass, best first. */
  onCandidates?: (candidates: string[]) => void;
  /** Freeze the passes without dropping the camera. */
  paused?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const matchRef = useRef(match);
  matchRef.current = match;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onCandidatesRef = useRef(onCandidates);
  onCandidatesRef.current = onCandidates;

  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [reading, setReading] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    // OCR misreads single frames, so a value only counts once it repeats.
    let previous: string | null = null;
    let fired: string | null = null;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const readPass = (text: string) => {
      const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');

      const value = matchRef.current(lines);

      // The matcher also decides what a tappable candidate is: run it over each
      // line and word so the chips carry its normalisation too.
      const found: string[] = value !== null ? [value] : [];
      for (const line of lines) {
        for (const piece of [line, ...line.split(/\s+/)]) {
          const other = matchRef.current([piece]);
          if (other !== null && !found.includes(other)) found.push(other);
        }
      }
      const top = found.slice(0, MAX_CANDIDATES);
      setCandidates(top);
      onCandidatesRef.current?.(top);

      if (value !== null && value === previous && value !== fired) {
        fired = value;
        onResultRef.current(value);
      }
      previous = value;
    };

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera access is not available in this browser.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
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

      let worker: OcrWorker;
      try {
        worker = await acquireWorker();
      } catch {
        if (!stopped) setError('Text recognition could not start on this device.');
        return;
      }
      if (stopped) return;
      setReady(true);

      const tick = async () => {
        if (stopped) return;
        const v = videoRef.current;
        if (v && v.readyState >= 2 && !pausedRef.current && ctx && grabBand(v, canvas, ctx)) {
          setReading(true);
          try {
            const { data } = await worker.recognize(canvas);
            if (stopped) return;
            readPass(data.text);
          } catch {
            /* unreadable frame; the next pass tries again */
          }
          if (stopped) return;
          setReading(false);
        }
        timer = setTimeout(tick, PASS_INTERVAL_MS);
      };
      void tick();
    }

    void start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      releaseWorker();
    };
  }, []);

  if (error) {
    return (
      <div className="ocr-scanner error">
        <p className="muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="stack tight">
      <div className="ocr-scanner">
        {/* muted+playsInline are required for autoplay inside Android WebView and iOS Safari */}
        <video ref={videoRef} muted playsInline />
        <div className="ocr-band" aria-hidden="true" />
        <span className="ocr-status">
          {!ready ? 'Starting' : reading ? 'Reading…' : 'Hold steady'}
        </span>
      </div>
      {candidates.length > 0 ? (
        <div className="ocr-candidates">
          {candidates.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className="ocr-chip"
              onClick={() => onResultRef.current(candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>
      ) : (
        <p className="tiny faint">Line the band up with the serial number.</p>
      )}
    </div>
  );
}
