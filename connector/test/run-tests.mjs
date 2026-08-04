/**
 * End-to-end test of the Peerventory Chrome extension against local fixture
 * pages, without touching the live sites:
 *
 *  1. Builds the React-controlled Facebook fixture with esbuild.
 *  2. Serves both fixtures over local HTTPS (self-signed cert).
 *  3. Launches Chromium with the UNMODIFIED extension loaded and
 *     --host-resolver-rules mapping www.anibis.ch / www.facebook.com to the
 *     local server — so the real manifest matches, content-script injection,
 *     popup → storage → tabs.sendMessage plumbing and the fill engine all run
 *     exactly as they would in production.
 *  4. Asserts filled values, React state updates and the status overlay.
 *
 * Run: cd connector/test && npm install && npm test
 * (Chromium comes from the Playwright cache; no network needed beyond npm.)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', 'chrome-extension');
const TMP = join(HERE, '.tmp');
const PORT = 5299;

const payload = JSON.parse(readFileSync(join(HERE, 'sample-payload.json'), 'utf8'));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* 1. Build the React fixture ---------------------------------------- */

mkdirSync(join(HERE, 'dist'), { recursive: true });
execFileSync(
  join(HERE, 'node_modules', '.bin', 'esbuild'),
  [
    join(HERE, 'fixture-facebook.jsx'),
    '--bundle',
    '--jsx=automatic',
    '--define:process.env.NODE_ENV="production"',
    `--outfile=${join(HERE, 'dist', 'fixture-facebook.js')}`,
  ],
  { stdio: 'inherit' },
);

/* 2. Self-signed cert + HTTPS fixture server ------------------------- */

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7',
  '-keyout', join(TMP, 'key.pem'), '-out', join(TMP, 'cert.pem'),
  '-subj', '/CN=peerventory-test',
]);

const routes = {
  '/fr/publier': ['fixture-anibis.html', 'text/html; charset=utf-8'],
  '/marketplace/create/item': ['fixture-facebook.html', 'text/html; charset=utf-8'],
  '/dist/fixture-facebook.js': ['dist/fixture-facebook.js', 'text/javascript'],
};

const server = createServer(
  { key: readFileSync(join(TMP, 'key.pem')), cert: readFileSync(join(TMP, 'cert.pem')) },
  (req, res) => {
    const route = routes[new URL(req.url, 'https://x').pathname];
    if (!route || !existsSync(join(HERE, route[0]))) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': route[1] });
    res.end(readFileSync(join(HERE, route[0])));
  },
);
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

/* 3. Chromium with the extension ------------------------------------- */

const context = await chromium.launchPersistentContext(join(TMP, 'profile'), {
  // Extensions need the full Chromium build; the default headless shell
  // silently ignores --load-extension.
  channel: 'chromium',
  headless: true,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP www.anibis.ch 127.0.0.1:${PORT}, MAP www.facebook.com 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
  ],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extId = new URL(sw.url()).host;
  console.log(`extension loaded, id ${extId}`);
  check('extension loads in Chromium (load-unpacked equivalent)', Boolean(extId));

  /* Popup: paste + save the payload ---------------------------------- */

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  check('popup renders', (await popup.title()) !== '' || (await popup.locator('h1').count()) === 1);

  // Invalid payload is rejected with a readable error.
  await popup.fill('#payload', '{"not":"a payload"}');
  await popup.click('#save');
  check(
    'popup rejects a non-Peerventory payload',
    (await popup.locator('#status').textContent()).includes('Not a Peerventory'),
  );

  await popup.fill('#payload', JSON.stringify(payload, null, 2));
  await popup.click('#save');
  check(
    'popup accepts and stores the payload',
    (await popup.locator('#status').textContent()).includes('Payload saved'),
  );
  check(
    'popup summary shows title and price',
    (await popup.locator('#summary-title').textContent()) === payload.item.title &&
      (await popup.locator('#summary-price').textContent()).includes('120'),
  );

  /**
   * Send PV_FILL to `page` the way the popup does in production: the user is
   * looking at the listing tab (bringToFront makes it the active tab), the
   * popup messages the active tab. Retries while the content script loads.
   * The extension has no "tabs" permission, so tab URLs are invisible here —
   * exactly like in production.
   */
  const sendFill = async (page) => {
    await page.bringToFront();
    return popup.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true });
      if (!tab) return { ok: false, error: 'no active tab' };
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          return await chrome.tabs.sendMessage(tab.id, { type: 'PV_FILL' });
        } catch (err) {
          await new Promise((r) => setTimeout(r, 500));
          if (attempt === 9) return { ok: false, error: String(err) };
        }
      }
    });
  };

  /* Anibis fixture ---------------------------------------------------- */

  console.log('\nAnibis (fixture at https://www.anibis.ch/fr/publier):');
  const anibis = await context.newPage();
  await anibis.goto('https://www.anibis.ch/fr/publier');
  const resA = await sendFill(anibis);
  check('content script answers on anibis', resA && resA.ok, JSON.stringify(resA));
  if (resA && resA.ok) {
    const status = Object.fromEntries(resA.results.map((r) => [r.key, r.status]));
    check('title filled', (await anibis.inputValue('input[name="title"]')) === payload.item.title);
    check(
      'description filled with FR translation (page lang=fr)',
      (await anibis.inputValue('textarea[name="description"]')) ===
        payload.item.descriptionTranslations.fr,
    );
    check('price filled', (await anibis.inputValue('input[name="price"]')) === '120');
    check(
      'condition select matched by option text',
      (await anibis.inputValue('select[name="condition"]')) === 'good',
    );
    check('category reported as manual', status.category === 'manual');
    check('status overlay shown', (await anibis.locator('#pv-fill-overlay').count()) === 1);
  }

  /* Facebook fixture (React-controlled) -------------------------------- */

  console.log('\nFacebook Marketplace (fixture at https://www.facebook.com/marketplace/create/item):');
  const fb = await context.newPage();
  await fb.goto('https://www.facebook.com/marketplace/create/item');
  await fb.waitForSelector('#state');
  const resF = await sendFill(fb);
  check('content script answers on facebook', resF && resF.ok, JSON.stringify(resF));
  if (resF && resF.ok) {
    const status = Object.fromEntries(resF.results.map((r) => [r.key, r.status]));
    const state = JSON.parse(await fb.locator('#state').textContent());
    check('React state received the title (native-setter trick)', state.title === payload.item.title);
    check('React state received the price', state.price === '120');
    check('React state received the description', state.description === payload.item.description);
    check('category reported as manual', status.category === 'manual');
    check('condition reported as manual', status.condition === 'manual');
    check('status overlay shown', (await fb.locator('#pv-fill-overlay').count()) === 1);
  }

  /* Wrong-page guard ---------------------------------------------------- */

  const elsewhere = await context.newPage();
  await elsewhere.goto('https://www.facebook.com/dist/fixture-facebook.js');
  const resW = await sendFill(elsewhere);
  check(
    'facebook script refuses to fill outside /marketplace/create',
    resW && resW.ok === false && resW.error === 'not-listing-page',
    JSON.stringify(resW),
  );
} finally {
  await context.close();
  server.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
