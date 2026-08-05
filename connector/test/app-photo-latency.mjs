/**
 * App-side check of the photo capture path: how fast a freshly taken photo
 * shows up on the item sheet, and that the stored bytes are still the
 * contract's <=2048px JPEG.
 *
 *   app: cd app && npx vite --port 5203
 *
 * Seeds one inventory+item through the dev-only window.__store hook, opens the
 * item sheet and pushes a synthetic 12MP capture into the hidden file input
 * (the same path a camera capture takes), then measures:
 *   - time from "file chosen" to a preview on screen (the optimistic tile),
 *   - time until the stored photo replaces it,
 *   - whether a "Loading" placeholder was ever shown (it must not be: the
 *     object URL is pre-warmed by addPhoto),
 *   - the stored pixel size, incl. an EXIF-rotated capture.
 *
 * Run: cd connector/test && node app-photo-latency.mjs
 */

import { chromium } from 'playwright';

const APP = process.env.APP_ORIGIN ?? 'http://localhost:5203';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
const timings = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[photo]')) timings.push(text);
});

/** In-page helpers: synthetic captures + the instrumentation. */
const HELPERS = `
window.__pv = {
  /** A JPEG of w*h, optionally carrying an EXIF orientation tag. */
  async capture(w, h, orientation) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Noise, so the JPEG does not compress down to nothing.
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = (i * 7) % 255;
      img.data[i + 1] = (i * 13) % 255;
      img.data[i + 2] = (i * 29) % 255;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (orientation) bytes = window.__pv.withOrientation(bytes, orientation);
    return new File([bytes], 'capture.jpg', { type: 'image/jpeg' });
  },

  withOrientation(bytes, orientation) {
    const exif = [
      0x45, 0x78, 0x69, 0x66, 0, 0,
      0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0,
      1, 0,
      0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0,
      0, 0, 0, 0,
    ];
    const length = exif.length + 2;
    const app1 = [0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...exif];
    const out = new Uint8Array(bytes.length + app1.length);
    out.set(bytes.subarray(0, 2), 0);
    out.set(app1, 2);
    out.set(bytes.subarray(2), 2 + app1.length);
    return out;
  },

  /** Watch the gallery: first preview, first "Loading" tile, stored photo. */
  watch() {
    const state = { t0: 0, preview: null, loading: false, stored: null };
    window.__pvState = state;
    const gallery = document.querySelector('.gallery');
    const scan = () => {
      const now = performance.now() - state.t0;
      if (state.preview === null && gallery.querySelector('.gallery-item.pending img')) {
        state.preview = now;
      }
      if (gallery.querySelector('.thumb-empty')) state.loading = true;
      const real = gallery.querySelector('.gallery-item:not(.pending) img');
      if (state.stored === null && real) state.stored = now;
    };
    new MutationObserver(scan).observe(gallery, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    return state;
  },

  async choose(file, index = 0) {
    const input = document.querySelectorAll('input.hidden-input[type=file]')[index];
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    window.__pvState.t0 = performance.now();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  },

  /** Pixel size of a stored blob. */
  async sizeOf(docId, hash) {
    const blob = await window.__store.getPhotoBlob(docId, hash);
    if (!blob) return null;
    const bmp = await createImageBitmap(blob);
    const out = { width: bmp.width, height: bmp.height, bytes: blob.size, type: blob.type };
    bmp.close();
    return out;
  },
};
`;

try {
  await page.goto(APP);
  await page.waitForFunction(() => window.__store && window.__store.importSnapshot, undefined, {
    timeout: 30_000,
  });
  await page.evaluate(HELPERS);

  const itemId = 'phototest';
  const docId = await page.evaluate(async (itemId) => {
    const now = Date.now();
    return window.__store.importSnapshot(
      {
        meta: {
          id: 'photoinv01',
          name: 'Photo latency inventory',
          createdAt: now,
          ownerTrackingEnabled: false,
          currency: 'CHF',
        },
        items: [
          {
            id: itemId,
            createdAt: now,
            updatedAt: now,
            description: 'Item that gets photographed',
            quantity: 1,
            photos: [],
            locationHistory: [],
            ownerHistory: [],
          },
        ],
        boxes: [],
        savedLists: [],
      },
      new Map(),
    );
  }, itemId);
  check('inventory seeded', typeof docId === 'string' && docId.length > 0);

  await page.goto(`${APP}/#/inv/${docId}/i/${itemId}`);
  await page.waitForSelector('.gallery', { timeout: 20_000 });
  await page.evaluate(HELPERS);

  /* 1. A 12MP capture ---------------------------------------------------- */

  console.log('\n12MP capture (4000x3000):');
  await page.evaluate(() => window.__pv.watch());
  await page.evaluate(async () => {
    const file = await window.__pv.capture(4000, 3000);
    window.__pvBytes = file.size;
    await window.__pv.choose(file);
  });
  await page.waitForFunction(() => window.__pvState.preview !== null, undefined, {
    timeout: 10_000,
  });
  const previewMs = await page.evaluate(() => window.__pvState.preview);
  check('preview on screen in under 300ms', previewMs < 300, `${Math.round(previewMs)}ms`);

  await page.waitForFunction(() => window.__pvState.stored !== null, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('.gallery-item.pending').length === 0, {
    timeout: 30_000,
  });
  const state = await page.evaluate(() => window.__pvState);
  check('stored photo replaces the preview', state.stored !== null, `${Math.round(state.stored)}ms`);
  check('no "Loading" placeholder is ever shown (pre-warmed object URL)', !state.loading);

  const stored = await page.evaluate(
    async ([docId, itemId]) => {
      const item = (await window.__store.snapshotInventory(docId)).items.find((i) => i.id === itemId);
      const ref = item.photos[0];
      return { ref, ...(await window.__pv.sizeOf(docId, ref.hash)) };
    },
    [docId, itemId],
  );
  check(
    'stored at 2048px JPEG, aspect kept',
    Math.max(stored.width, stored.height) === 2048 &&
      Math.abs(stored.width / stored.height - 4 / 3) < 0.02 &&
      stored.type === 'image/jpeg',
    `${stored.width}x${stored.height} ${Math.round(stored.bytes / 1024)}KB`,
  );

  /* 2. EXIF-rotated capture ---------------------------------------------- */

  console.log('\nEXIF orientation 6 capture (4000x3000 stored rotated):');
  await page.evaluate(async () => {
    window.__pv.watch();
    const file = await window.__pv.capture(4000, 3000, 6);
    await window.__pv.choose(file);
  });
  await page.waitForFunction(() => window.__pvState.preview !== null, undefined, {
    timeout: 10_000,
  });
  const rotatedPreview = await page.evaluate(() => window.__pvState.preview);
  check('rotated capture previews instantly too', rotatedPreview < 300, `${Math.round(rotatedPreview)}ms`);
  await page.waitForFunction(
    () => document.querySelectorAll('.gallery-item:not(.pending) img').length === 2,
    undefined,
    { timeout: 30_000 },
  );
  const rotated = await page.evaluate(
    async ([docId, itemId]) => {
      const item = (await window.__store.snapshotInventory(docId)).items.find((i) => i.id === itemId);
      return window.__pv.sizeOf(docId, item.photos[1].hash);
    },
    [docId, itemId],
  );
  check(
    'rotated capture keeps its aspect ratio and fits 2048px',
    Math.max(rotated.width, rotated.height) <= 2048 &&
      Math.abs(rotated.width / rotated.height - 3 / 4) < 0.02,
    `${rotated.width}x${rotated.height}`,
  );

  /* 3. New item form ------------------------------------------------------ */

  console.log('\nNew item form:');
  await page.goto(`${APP}/#/inv/${docId}/new`);
  await page.waitForSelector('.gallery', { timeout: 20_000 });
  await page.evaluate(HELPERS);
  const formPreview = await page.evaluate(async () => {
    const gallery = document.querySelector('.gallery');
    const file = await window.__pv.capture(4000, 3000);
    const seen = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (gallery.querySelector('img')) {
          observer.disconnect();
          resolve(performance.now());
        }
      });
      observer.observe(gallery, { childList: true, subtree: true });
    });
    const input = document.querySelectorAll('input.hidden-input[type=file]')[0];
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    const started = performance.now();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return (await seen) - started;
  });
  check(
    'the new item form previews the raw capture immediately',
    formPreview < 300,
    `${Math.round(formPreview)}ms`,
  );

  /* 4. Pipeline behaviour ------------------------------------------------- */

  console.log('\nPipeline:');
  const small = await page.evaluate(async () => {
    const file = await window.__pv.capture(1200, 900);
    const out = await window.__store.normalizeImage(file);
    return { same: out.bytes === file, mime: out.mime };
  });
  check('a capture that already fits is stored untouched', small.same && small.mime === 'image/jpeg');

  const forAi = await page.evaluate(async () => {
    const file = await window.__pv.capture(4000, 3000);
    const { bytes } = await window.__store.normalizeImage(file, 1024, 0.75);
    const bmp = await createImageBitmap(bytes);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  });
  check(
    'the same pipeline serves the AI uploads at 1024px',
    Math.max(forAi.width, forAi.height) === 1024,
    `${forAi.width}x${forAi.height}`,
  );

  const bench = await page.evaluate(async () => {
    const file = await window.__pv.capture(4000, 3000);
    // What the store used to do: full-resolution decode, then scale and
    // re-encode through a canvas, all on the main thread.
    const old = async () => {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = 2048;
      canvas.height = 1536;
      canvas.getContext('2d').drawImage(bmp, 0, 0, 2048, 1536);
      bmp.close();
      await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    };
    /**
     * Wall-clock plus the longest stall of a 4ms heartbeat: the second number
     * is the one the user feels, since a blocked main thread is a frozen UI.
     */
    const measure = async (fn) => {
      let last = performance.now();
      let stall = 0;
      const beat = setInterval(() => {
        const now = performance.now();
        stall = Math.max(stall, now - last);
        last = now;
      }, 4);
      const started = performance.now();
      await fn();
      const total = performance.now() - started;
      clearInterval(beat);
      return { total: Math.round(total), stall: Math.round(stall) };
    };
    await old(); // warm the decoder
    await window.__store.normalizeImage(file);
    return {
      before: await measure(old),
      after: await measure(() => window.__store.normalizeImage(file)),
      bytes: file.size,
    };
  });
  console.log(
    `  info  4000x3000 (${Math.round(bench.bytes / 1024)}KB): decode+canvas on the main thread ` +
      `${bench.before.total}ms (blocked ${bench.before.stall}ms), ` +
      `worker + resize-on-decode ${bench.after.total}ms (blocked ${bench.after.stall}ms)`,
  );
  check(
    'the worker pipeline is no slower than the old main-thread one',
    bench.after.total <= bench.before.total * 1.2 && bench.after.stall <= bench.before.stall,
    `${bench.after.total}ms vs ${bench.before.total}ms`,
  );

  /* 5. Fallbacks ---------------------------------------------------------- */

  console.log('\nFallbacks (older WebViews):');
  const fallback = await page.evaluate(async () => {
    // No OffscreenCanvas: no worker either, everything on the main thread.
    delete window.OffscreenCanvas;
    const { normalizeImage } = await import('/src/store/imagePipeline.ts?nooffscreen');
    const file = await window.__pv.capture(4000, 3000);
    const { bytes, mime } = await normalizeImage(file);
    const bmp = await createImageBitmap(bytes);
    const out = { width: bmp.width, height: bmp.height, mime };
    bmp.close();
    return out;
  });
  check(
    'without OffscreenCanvas the main-thread path still produces the stored form',
    Math.max(fallback.width, fallback.height) === 2048 && fallback.mime === 'image/jpeg',
    `${fallback.width}x${fallback.height}`,
  );

  const thumb = await page.evaluate(async () => {
    const { makeExportThumb } = await import('/src/ui/lib/image.ts');
    const file = await window.__pv.capture(4000, 3000);
    const out = await makeExportThumb(file);
    return out && { width: out.width, height: out.height, bytes: out.data.byteLength };
  });
  check(
    'export thumbnails still come out at 160px',
    thumb && Math.max(thumb.width, thumb.height) === 160 && thumb.bytes > 0,
    thumb ? `${thumb.width}x${thumb.height}` : 'null',
  );

  if (timings.length > 0) console.log('\nDev timings:\n  ' + timings.join('\n  '));
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
