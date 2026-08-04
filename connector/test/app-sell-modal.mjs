/**
 * App-side check of the "Sell / export listing" flow, against a locally
 * running dev stack:
 *
 *   server:  cd server && INVENTORY_DATA_DIR=/tmp/sell-data PORT=8787 npm run dev
 *   app:     cd app && VITE_SERVER_ORIGIN=http://localhost:8787 npx vite --port 5202
 *
 * Seeds one inventory+item through the dev-only window.__store hook, opens
 * the item sheet, opens the Sell modal and asserts the template draft, the
 * v1 payload JSON (schema in connector/README.md), the text version and the
 * clipboard copy. The AI path is not exercised (no key in the test browser —
 * the template fallback is the deterministic path).
 *
 * Run: cd connector/test && node app-sell-modal.mjs
 */

import { chromium } from 'playwright';

const APP = 'http://localhost:5202';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext();
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
const page = await context.newPage();

try {
  await page.goto(APP);
  await page.waitForFunction(() => window.__store && window.__store.importSnapshot, undefined, {
    timeout: 20_000,
  });

  /* Seed one inventory with one sellable item ------------------------- */

  const itemId = 'selltest01';
  const docId = await page.evaluate(async (itemId) => {
    const now = Date.now();
    return window.__store.importSnapshot(
      {
        meta: {
          id: 'seedinv001',
          name: 'Sell test inventory',
          createdAt: now,
          ownerTrackingEnabled: false,
          currency: 'CHF',
        },
        items: [
          {
            id: itemId,
            createdAt: now,
            updatedAt: now,
            description: 'Sony WH-1000XM4 noise-cancelling headphones',
            category: 'Audio',
            tags: ['electronics'],
            quantity: 1,
            valueCurrent: { amount: 120, currency: 'CHF' },
            valueNew: { amount: 379, currency: 'CHF' },
            photos: [],
            locationHistory: [],
            ownerHistory: [],
            weight: { class: 'g200_500', exactGrams: 254 },
            dimensions: { class: 'shoebox', exactMm: { l: 254, w: 203, h: 76 } },
            serialNumber: 'SN-TEST-123',
            condition: 'Bon état',
            brandModel: 'Sony WH-1000XM4',
            notes: 'Original case included.',
          },
        ],
        boxes: [],
        savedLists: [],
      },
      new Map(),
    );
  }, itemId);
  check('inventory seeded via window.__store.importSnapshot', typeof docId === 'string' && docId.length > 0);

  /* Open the item sheet and the Sell modal ----------------------------- */

  await page.goto(`${APP}/#/inv/${docId}/i/${itemId}`);
  const sellButton = page.getByRole('button', { name: 'Sell / export listing' });
  await sellButton.waitFor({ timeout: 15_000 });
  check('Sell / export listing button on the item sheet', await sellButton.isVisible());
  await sellButton.click();

  const modal = page.getByRole('dialog', { name: 'Sell / export listing' });
  await modal.waitFor({ timeout: 5_000 });
  check('Sell modal opens', await modal.isVisible());

  const title = await modal.getByLabel('Listing title').inputValue();
  check('template title from brand+description', title.includes('Sony'), title);
  const description = await modal.getByLabel('Listing description').inputValue();
  check('template description mentions condition', description.includes('Bon état'));
  check(
    'price suggested from valueCurrent',
    (await modal.getByLabel('Listing price').inputValue()) === '120' &&
      (await modal.getByLabel('Listing currency').inputValue()) === 'CHF',
  );
  check(
    'no-AI fallback hint shown (no key on device)',
    (await modal.getByText('Add a Claude API key').count()) === 1,
  );
  check(
    'photo download disabled for photo-less item',
    await modal.getByRole('button', { name: /Download photos \(0\)/ }).isDisabled(),
  );

  /* Payload preview ----------------------------------------------------- */

  await modal.getByText('Payload preview').click();
  const payload = JSON.parse(await modal.getByTestId('listing-payload').textContent());
  check('payload v1 / source', payload.v === 1 && payload.source === 'peerventory');
  check(
    'payload item core fields',
    payload.item.title === title &&
      payload.item.priceAmount === 120 &&
      payload.item.priceCurrency === 'CHF' &&
      payload.item.condition === 'Bon état' &&
      payload.item.category === 'Audio' &&
      payload.item.brandModel === 'Sony WH-1000XM4' &&
      payload.item.weightGrams === 254 &&
      payload.item.dimensionsMm.l === 254 &&
      payload.item.serialIncluded === true,
    JSON.stringify(payload.item),
  );
  check(
    'serial number itself is NOT exported',
    !JSON.stringify(payload).includes('SN-TEST-123'),
  );

  /* Clipboard actions ---------------------------------------------------- */

  await modal.getByRole('button', { name: 'Copy for extension' }).click();
  const copiedJson = await page.evaluate(() => navigator.clipboard.readText());
  let copiedOk = false;
  try {
    const parsed = JSON.parse(copiedJson);
    copiedOk = parsed.v === 1 && parsed.item.title === title;
  } catch {
    copiedOk = false;
  }
  check('Copy for extension puts the JSON payload on the clipboard', copiedOk);

  await modal.getByRole('button', { name: 'Copy as text' }).click();
  const copiedText = await page.evaluate(() => navigator.clipboard.readText());
  check(
    'Copy as text puts a human-readable listing on the clipboard',
    copiedText.startsWith(title) && copiedText.includes('Price: 120 CHF'),
    copiedText.slice(0, 120),
  );

  await page.keyboard.press('Escape');
  check('modal closes on Escape', (await modal.count()) === 0);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
