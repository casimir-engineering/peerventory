/**
 * App-side check of the two deletion/capture behaviours added for 1.1.3:
 *
 *   - the webcam capture modal (desktop browsers): it opens, the fake camera
 *     stream reaches a shutter-ready state, a capture becomes a shot, and
 *     "Add" pushes the frames through the normal addPhotos path,
 *   - the two-step delete button: the first click only arms it (red + the
 *     `armed` class, nothing deleted), the arming lapses on its own, and a
 *     second click while armed is what actually deletes.
 *
 *   app: cd app && npx vite --port 5203
 *
 * Run: cd connector/test && node app-delete-camera.mjs
 */

import { chromium } from 'playwright';

const APP = process.env.APP_ORIGIN ?? 'http://localhost:5203';
const ARMED_MS = 2500;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({ permissions: ['camera'] });
const page = await context.newPage();

const itemId = 'deltest';
const photosOf = (docId) =>
  page.evaluate(
    async ([docId, itemId]) => {
      const snap = await window.__store.snapshotInventory(docId);
      return snap.items.find((i) => i.id === itemId).photos.length;
    },
    [docId, itemId],
  );

try {
  await page.goto(APP);
  await page.waitForFunction(() => window.__store && window.__store.importSnapshot, undefined, {
    timeout: 30_000,
  });

  const docId = await page.evaluate(async (itemId) => {
    const now = Date.now();
    return window.__store.importSnapshot(
      {
        meta: {
          id: 'delinv0001',
          name: 'Deletion inventory',
          createdAt: now,
          ownerTrackingEnabled: false,
          currency: 'CHF',
        },
        items: [
          {
            id: itemId,
            createdAt: now,
            updatedAt: now,
            description: 'Item that gets a photo and loses it',
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

  /* 1. Camera capture ------------------------------------------------------ */

  console.log('\nWebcam capture:');
  const cameraTile = page.locator('.gallery .photo-add', { hasText: 'Take photo' });
  check('the gallery offers a camera tile next to the file picker', (await cameraTile.count()) === 1);
  check(
    'the file picker is still there, as "Upload"',
    (await page.locator('.gallery .photo-add', { hasText: 'Upload' }).count()) === 1,
  );

  await cameraTile.click();
  await page.waitForSelector('.camera-view video', { timeout: 10_000 });
  const shutter = page.locator('button.camera-shutter');
  await shutter.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => {
      const button = document.querySelector('button.camera-shutter');
      return button && !button.disabled;
    },
    undefined,
    { timeout: 15_000 },
  );
  check('the fake camera stream starts and the shutter unlocks', true);

  await shutter.click();
  await page.waitForSelector('.modal img[alt="Captured photo"]', { timeout: 10_000 });
  await shutter.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.modal img[alt="Captured photo"]').length === 2,
    undefined,
    { timeout: 10_000 },
  );
  check('several shots can be taken without closing the modal', true);

  await page.locator('.modal button', { hasText: 'Add 2 photos' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.gallery .gallery-item:not(.pending) img').length === 2,
    undefined,
    { timeout: 30_000 },
  );
  check('the captures land on the item through the normal photo path', (await photosOf(docId)) === 2);

  /* 2. Two-step deletion --------------------------------------------------- */

  console.log('\nTwo-step deletion:');
  const remove = page.locator('.gallery .gallery-item:not(.pending) .remove').first();
  check(
    'the remove button starts unarmed and says what it does',
    (await remove.getAttribute('aria-label')) === 'Remove photo' &&
      !(await remove.getAttribute('class')).includes('armed'),
  );

  await remove.click();
  const armedClass = await remove.getAttribute('class');
  check('the first click arms the button', armedClass.includes('two-step') && armedClass.includes('armed'));
  check(
    'the armed button asks for a second tap',
    (await remove.getAttribute('aria-label')) === 'Tap again to delete',
  );
  const armedStyle = await remove.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, animation: s.animationName, touch: s.touchAction };
  });
  check(
    'the armed state is red, animated and safe to double-tap',
    armedStyle.background === 'rgb(239, 95, 82)' &&
      armedStyle.animation === 'two-step-arm' &&
      armedStyle.touch === 'manipulation',
    JSON.stringify(armedStyle),
  );
  check('nothing was deleted by the first click', (await photosOf(docId)) === 2);

  await page.waitForTimeout(ARMED_MS + 600);
  check(
    'the arming lapses on its own',
    !(await remove.getAttribute('class')).includes('armed') &&
      (await remove.getAttribute('aria-label')) === 'Remove photo',
  );
  check('a lapsed arming deletes nothing', (await photosOf(docId)) === 2);

  await remove.click();
  await remove.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.gallery .gallery-item:not(.pending) img').length === 1,
    undefined,
    { timeout: 10_000 },
  );
  check('the second click while armed deletes', (await photosOf(docId)) === 1);
} finally {
  await context.close();
  await browser.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
