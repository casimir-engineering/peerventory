/**
 * App-side check of multi-select and the two-step bulk delete added for 1.1.5:
 *
 *   - a long press on an item card enters selection mode with that card
 *     already picked, and does not open the item sheet,
 *   - tapping cards toggles the selection instead of navigating, the bar
 *     counts them and "Select all" picks the lot,
 *   - the Delete button says how many it would take, arms on the first click
 *     ("Confirm", red, nothing deleted), lets the arming lapse, and only
 *     deletes on a second click while armed,
 *   - the delete removes every selected item in one go and leaves selection
 *     mode with a toast.
 *
 *   app: cd app && npx vite --port 5203
 *
 * Run: cd connector/test && node app-bulk-delete.mjs
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

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const itemIds = ['bulk1', 'bulk2', 'bulk3', 'bulk4'];
const itemsLeft = (docId) =>
  page.evaluate(async (docId) => {
    const snap = await window.__store.snapshotInventory(docId);
    return snap.items.map((i) => i.id).sort();
  }, docId);

try {
  await page.goto(APP);
  await page.waitForFunction(() => window.__store && window.__store.importSnapshot, undefined, {
    timeout: 30_000,
  });

  const docId = await page.evaluate(async (itemIds) => {
    const now = Date.now();
    return window.__store.importSnapshot(
      {
        meta: {
          id: 'bulkinv0001',
          name: 'Bulk deletion inventory',
          createdAt: now,
          ownerTrackingEnabled: false,
          currency: 'CHF',
        },
        items: itemIds.map((id, n) => ({
          id,
          createdAt: now - n,
          updatedAt: now,
          description: `Item ${n + 1}`,
          quantity: 1,
          photos: [],
          locationHistory: [],
          ownerHistory: [],
        })),
        boxes: [],
        savedLists: [],
      },
      new Map(),
    );
  }, itemIds);
  check('inventory seeded', typeof docId === 'string' && docId.length > 0);

  await page.goto(`${APP}/#/inv/${docId}`);
  await page.waitForSelector('.item-card', { timeout: 20_000 });
  const cards = page.locator('.item-card');
  check('the four seeded items are listed', (await cards.count()) === 4);

  /* 1. Entering selection mode ---------------------------------------------- */

  console.log('\nSelection mode:');
  check('it is off to begin with', (await page.locator('.select-bar').count()) === 0);

  const box = await cards.first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForSelector('.select-bar', { timeout: 5_000 });
  check(
    'a long press enters selection mode with that card picked',
    (await page.locator('.select-bar .count').innerText()) === '1 selected' &&
      (await page.locator('.item-card.selected').count()) === 1,
  );
  check('the long press did not open the item sheet', page.url().includes(`/inv/${docId}`) && !page.url().includes('/i/'));
  check(
    'the picked card shows its checkmark',
    (await page.locator('.item-card.selected .checkbox-dot.on').count()) === 1,
  );

  await cards.nth(1).click();
  check(
    'tapping another card adds it instead of navigating',
    (await page.locator('.select-bar .count').innerText()) === '2 selected' &&
      !page.url().includes('/i/'),
  );
  await cards.nth(1).click();
  check(
    'tapping a picked card drops it again',
    (await page.locator('.select-bar .count').innerText()) === '1 selected',
  );

  await page.locator('.select-bar .link-btn', { hasText: 'Select all' }).click();
  check(
    'Select all takes the whole list',
    (await page.locator('.select-bar .count').innerText()) === '4 selected' &&
      (await page.locator('.item-card.selected').count()) === 4,
  );
  await page.locator('.select-bar .link-btn', { hasText: 'Select none' }).click();
  check(
    'and Select none lets go of it',
    (await page.locator('.select-bar .count').innerText()) === '0 selected',
  );

  /* 2. Two-step bulk deletion ----------------------------------------------- */

  console.log('\nTwo-step bulk deletion:');
  const del = page.locator('.bottom-bar .btn.two-step');
  check('the delete button is disabled with nothing selected', await del.isDisabled());

  await cards.nth(0).click();
  await cards.nth(1).click();
  await cards.nth(2).click();
  check('the button counts what it would delete', (await del.innerText()).trim() === 'Delete (3)');

  await del.click();
  const armedClass = await del.getAttribute('class');
  check('the first click only arms it', armedClass.includes('armed'));
  check('the armed button says Confirm', (await del.innerText()).trim() === 'Confirm');
  await page.waitForTimeout(300); // .btn transitions its background over 120ms
  const armedStyle = await del.evaluate((el) => {
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
  check('nothing was deleted by the first click', (await itemsLeft(docId)).length === 4);

  await page.waitForTimeout(ARMED_MS + 600);
  check(
    'the arming lapses on its own',
    !(await del.getAttribute('class')).includes('armed') &&
      (await del.innerText()).trim() === 'Delete (3)',
  );
  check('a lapsed arming deletes nothing', (await itemsLeft(docId)).length === 4);

  await del.click();
  await cards.nth(3).click();
  check(
    'changing the selection disarms the button',
    !(await del.getAttribute('class')).includes('armed') &&
      (await del.innerText()).trim() === 'Delete (4)',
  );
  await page.locator('.item-card', { hasText: 'Item 4' }).click();

  await del.click();
  await del.click();
  await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 1, undefined, {
    timeout: 10_000,
  });
  check('the second click while armed deletes every selected item', (await itemsLeft(docId)).join() === 'bulk4');
  check('selection mode ends with the deletion', (await page.locator('.select-bar').count()) === 0);
  check(
    'a toast says how many went',
    (await page.locator('.toast').first().innerText()).includes('3 items deleted'),
  );
} finally {
  await context.close();
  await browser.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
