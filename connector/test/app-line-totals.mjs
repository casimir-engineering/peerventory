/**
 * App-side check that a row is worth its line total (1.1.7).
 *
 * A row in a list answers "what is this line worth", so the value it shows is
 * the line total and the FX conversion converts that total. The unit price
 * stays visible as a hint. The item sheet is the exception and stays per unit.
 *
 * The case from the bug report: 5 × $10 must read $50, not $10.
 *
 *   app: cd app && npx vite --port 5203
 *
 * Run: cd connector/test && node app-line-totals.mjs
 */

import { chromium } from 'playwright';

const APP = process.env.APP_ORIGIN ?? 'http://localhost:5203';
const SHOTS = process.env.SHOT_DIR ?? '/tmp';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await context.newPage();

try {
  await page.goto(APP);
  // 1 USD = 0.809 CHF reproduces the "$10 ≈ CHF 8.09" from the screenshot.
  await page.evaluate(() => {
    localStorage.setItem(
      'fx:v1',
      JSON.stringify({ fetchedAt: Date.now(), rates: { USD: 1, CHF: 0.809 } }),
    );
  });
  await page.reload();
  await page.waitForFunction(() => window.__store && window.__store.importSnapshot, undefined, {
    timeout: 30_000,
  });

  const docId = await page.evaluate(async () => {
    const now = Date.now();
    const base = {
      createdAt: now,
      updatedAt: now,
      photos: [],
      locationHistory: [],
      ownerHistory: [],
      weight: { class: 'kg1_2', exactGrams: 1200 },
      dimensions: { class: 'shoebox' },
    };
    return window.__store.importSnapshot(
      {
        meta: {
          id: 'lineinv0001',
          name: 'Line totals',
          createdAt: now,
          ownerTrackingEnabled: false,
          currency: 'CHF',
        },
        items: [
          {
            ...base,
            id: 'lineitem01',
            description: 'Five of a thing',
            quantity: 5,
            valueCurrent: { amount: 10, currency: 'USD' },
          },
          {
            ...base,
            id: 'lineitem02',
            description: 'One of a thing',
            quantity: 1,
            valueCurrent: { amount: 10, currency: 'USD' },
          },
        ],
        boxes: [],
        savedLists: [],
      },
      new Map(),
    );
  });
  check('inventory seeded', typeof docId === 'string' && docId.length > 0);

  /* ------------------------------------------------------------ item cards */

  await page.goto(`${APP}/#/inv/${docId}`);
  await page.waitForSelector('.item-card', { timeout: 20_000 });
  const cardText = (id) =>
    page.evaluate((id) => {
      const card = [...document.querySelectorAll('.item-card')].find((c) =>
        c.textContent.includes(id),
      );
      return card ? card.querySelector('.meta').innerText.replace(/\s+/g, ' ').trim() : null;
    }, id);

  const many = await cardText('Five of a thing');
  check('card shows the line total', many?.includes('$50'), many);
  check('card converts the total', many?.includes('CHF 40.45'), many);
  check('card keeps the unit price', many?.includes('$10 each'), many);
  check('card does not lead with the unit price', !/^\D*\$10\b/.test(many ?? ''), many);
  check('card keeps its quantity chip', many?.includes('×5'), many);

  const one = await cardText('One of a thing');
  check('a single unit is unchanged', one?.includes('$10') && one?.includes('CHF 8.09'), one);
  check('a single unit says nothing about units', !one?.includes('each'), one);

  await page.screenshot({ path: `${SHOTS}/pv-cards.png`, fullPage: true });

  /* ------------------------------------------------------- manifest rows */

  await page.goto(`${APP}/#/inv/${docId}/l/lineitem01.lineitem02`);
  await page.waitForSelector('table.data tbody tr', { timeout: 20_000 });
  const rowText = await page.evaluate(() => {
    const row = [...document.querySelectorAll('table.data tbody tr')].find((r) =>
      r.textContent.includes('Five of a thing'),
    );
    return row ? row.innerText.replace(/\s+/g, ' ').trim() : null;
  });
  check('manifest row shows the line total', rowText?.includes('$50'), rowText);
  check('manifest row keeps the unit price', rowText?.includes('$10 each'), rowText);
  check('manifest row totals the weight', rowText?.includes('6.00 kg'), rowText);
  check('manifest row keeps the unit weight', rowText?.includes('1.20 kg each'), rowText);
  await page.screenshot({ path: `${SHOTS}/pv-manifest.png`, fullPage: true });

  /* ---------------------------------------------- search rows and the sheet */

  await page.goto(`${APP}/#/`);
  await page.waitForSelector('input[type="search"], input', { timeout: 20_000 });
  await page.fill('input', 'Five of a thing');
  await page.waitForTimeout(600);
  const searchRow = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.list-row')].find((r) =>
      r.textContent.includes('Five of a thing'),
    );
    return row ? row.innerText.replace(/\s+/g, ' ').trim() : null;
  });
  check('search row shows the line total', searchRow?.includes('$50'), searchRow);
  check('search row keeps the unit price', searchRow?.includes('$10 each'), searchRow);
  await page.screenshot({ path: `${SHOTS}/pv-search.png`, fullPage: true });

  await page.goto(`${APP}/#/inv/${docId}/i/lineitem01`);
  await page.waitForTimeout(1200);
  const sheet = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  check('the item sheet still describes one unit', sheet?.includes('× 5 = total'), 
    sheet?.match(/Every figure[^.]*\./)?.[0] ?? '');
  await page.screenshot({ path: `${SHOTS}/pv-sheet.png`, fullPage: true });
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nline totals: all checks passed' : `\nline totals: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
