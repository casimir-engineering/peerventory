# Peerventory Connector

Chrome (MV3) extension that turns your Peerventory profile into a selling
assistant: it syncs all your end-to-end encrypted inventories read-only,
lets you search them from the toolbar popup, and autofills
[Anibis](https://www.anibis.ch) / [Facebook Marketplace](https://www.facebook.com/marketplace)
listing forms per item. Neither platform has a public listing API, so filling
the form the user is looking at — never submitting — is the whole design.

## How it works

```
Peerventory app                     Connector extension
┌─────────────────────┐            ┌───────────────────────────────────────┐
│ Inventories →       │  QR scan / │ onboarding: decode profile link       │
│ Backup / transfer   │  QR image /│  → origin + tokens + E2E keys         │
│ (profile share link │  paste link│    into chrome.storage.local          │
│  = backup payload)  ├───────────►│ sync: Hocuspocus wss <origin>/sync,   │
└─────────────────────┘            │  ro token, decrypt enc:log (AES-GCM)  │
        ▲                          │  → items cached locally               │
        │ same relay               │ popup: search all inventories,        │
┌───────┴────────┐   ciphertext    │  thumbnails via blob API + decrypt,   │
│ sync relay VPS │◄───────────────►│  "Sell on Anibis / Facebook" per item │
│ (sees nothing) │                 │ content scripts: autofill + overlay   │
└────────────────┘                 └───────────────────────────────────────┘
```

- **Onboarding** — one of: *Scan QR with camera* (opens a dedicated
  `scan.html` extension tab, since MV3 popups cannot hold the camera
  permission), *drop/paste/upload a QR image* into the popup, or *paste the
  profile share link*. All paths decode to the same backup URL
  (`https://<origin>/#/restore/<payload>`, payload v2 per CONTRACTS.md) and
  funnel through one import routine. The origin in the link doubles as the
  relay address. The AI key that may ride in a backup payload is
  **deliberately dropped** — the extension never holds it.
- **Sync** — for each inventory handle the extension connects to
  `wss://<origin>/sync` (Hocuspocus) with the **read-only token** when the
  payload carries one, pulls the opaque outer doc, decrypts the `enc:log`
  entries (AES-256-GCM, AAD = docId) into a throwaway inner doc, projects the
  items, disconnects. It never writes to the log. Results are cached in
  `chrome.storage.local`, so browsing and selling work offline; a sync
  refresh runs on popup open when the cache is older than 10 minutes.
- **Search** — one box across all inventories: description, brand/model,
  category, tags, notes, inventory name.
- **Photos** — thumbnails are fetched from the blob API
  (`GET <origin>/api/blobs/<docId>/<hash>`, `x-token` header; the server
  already serves `Access-Control-Allow-Origin: *`), decrypted locally and
  cached in the extension's IndexedDB. On **Sell**, the decrypted photos are
  staged as base64 in `chrome.storage.local` (`pv:photos`) and the content
  script attaches them to the form's `<input type="file">` via `DataTransfer`
  — no dragging needed. The per-item **Photos** button still downloads the
  files as a manual fallback. Stagings expire after 10 minutes and are
  replaced on every Sell click, so another item's photos never attach.
- **Sell on X** — each result row has *Sell on Anibis* and *Sell on
  Facebook*. If the active tab is that marketplace (detected by pinging the
  content script — no `tabs` permission needed), the listing form is filled
  immediately. Otherwise the extension opens the listing form in a new tab
  and the content script fills it as soon as the form renders (one-shot
  `pv:pending` flag, expires after 2 minutes).
- **Listing copy & language** — generated from the item by the same template
  the app uses (title from brand+description, price from `valueCurrent`
  rounded, or 60% of `valueNew`). The popup's **Settings — listing language
  & AI** section selects the language of the generated content (Français /
  Deutsch / Italiano / English, default **French** — Anibis is Swiss). The
  template translates its fixed boilerplate ("Marque / modèle", "État",
  closing line…) per language; the item's own description/notes stay as
  written unless an AI is linked.
- **Link AI (optional)** — paste an Anthropic API key (`sk-ant-…`) or the
  app's `inv-ai:` key link, or decode the app's AI-key QR screenshot, in the
  same Settings section. With a key linked, **Sell on X**:
  - drafts the title and a well-structured description **in the selected
    language** (prices/units preserved) with a tiny haiku-class prompt;
  - on Anibis, sends each scraped level of the live category menu to the AI
    (via the background worker) and clicks the option it names — this
    overrides the synonyms heuristic, which remains the fallback;
  - the on-page overlay says **"AI-drafted in French — review before
    publishing"** (vs "Template fill") and "AI-picked" on the category row.

  Every AI call has a 10 s timeout and any failure silently falls back to
  the template / synonyms path — the fill never blocks on the AI. The key
  lives only in `chrome.storage.local`, is sent only to `api.anthropic.com`
  (the profile backup payload deliberately never carries it into the
  extension — linking is a separate opt-in), and **Disconnect** wipes it.
  Only Anthropic ships as a provider: Cursor's cloud API was evaluated and
  skipped (the SDK needs a local Node bridge, and REST `/v1/agents` spins a
  repo-cloning VM per request — seconds-to-minutes latency, wrong tool for
  one-shot listing copy). The app's **Sell / export listing** dialog +
  paste-payload box still works as before and overrides everything.

### Security model

- Tokens and E2E content keys live **only** in `chrome.storage.local`
  (never `storage.sync`) and are only ever sent to the relay origin from the
  profile link. Photo caches hold decrypted images in the extension's own
  IndexedDB. **Disconnect** in the popup wipes everything.
- The serial *number* of an item never enters the extension — only the fact
  that one is on record.
- The extension is read-only towards the relay: ro token preferred, and the
  sync engine has no code path that appends to the encrypted log.

## Build & install (Brave/Chrome, unpacked)

```bash
cd connector
npm install
npm run build     # bundles src/ -> chrome-extension/popup.js + scan.js
```

Then `brave://extensions` (or `chrome://extensions`) → Developer mode →
**Load unpacked** → select **`connector/chrome-extension/`** — the same
folder as before; the bundles are generated into it (and gitignored), so
after pulling changes just rebuild and hit the extension's reload button.

## Payload schema (v1)

Unchanged contract between the app (`app/src/ui/lib/listing.ts`), the
extension popup (`src/listing.ts`) and the content scripts
(`chrome-extension/content/fill-core.js`, `validPayload`). Keep all three in
sync.

```jsonc
{
  "v": 1,
  "source": "peerventory",
  "item": {
    "title": "string (≤ ~60 chars)",
    "description": "string",
    "descriptionTranslations": { "fr": "string?", "de": "string?" }, // optional, for Anibis
    "priceAmount": 120,          // number; 0 = no price set
    "priceCurrency": "CHF",      // ISO 4217
    "condition": "string?",
    "category": "string?",       // free text; drives the Anibis auto-pick, hint elsewhere
    "brandModel": "string?",
    "weightGrams": 254,          // optional, only when measured exactly
    "dimensionsMm": { "l": 1, "w": 1, "h": 1 },  // optional, only when measured
    "serialIncluded": true       // item has a serial on record (number itself never exported)
  },
  "photosNote": "string — human hint about the photo workflow"
}
```

## What can and cannot be automated

| Field | Anibis | Facebook Marketplace |
| --- | --- | --- |
| Title | autofilled (AI-drafted in the selected language when linked, template otherwise) | autofilled (same) |
| Description | autofilled (AI-drafted in the selected language when linked; template with localized boilerplate otherwise; FR/DE translation matching page language for app-pasted payloads) | autofilled |
| Price | autofilled (CHF warning if payload is another currency) | autofilled (number only; account currency assumed) |
| Condition | autofilled when it is a native `<select>`; otherwise manual hint | manual hint (custom combobox) |
| Category | **auto-picked**: with an AI linked, each scraped menu level is decided by the model (overrides the heuristic); otherwise/on failure the cascading MUI menu is matched against the item's category (accent-insensitive + synonyms table in `content/anibis.js`); falls back to the manual hint when nothing matches confidently | manual hint (custom combobox) |
| Photos | **auto-attached** (decrypted bytes → `File` → `DataTransfer` on the hidden file input, capped by the "x/5 photos" counter; verified live) | auto-attach via the same mechanism (capped at 10, **not verified against the live site**) |
| Publish | manual, always | manual, always |

When the Anibis auto-pick finds no confident match, the on-page overlay says
so explicitly ("No Anibis category matches X — pick one manually…") and the
fill waits up to 10 minutes for the manual pick before giving up, so the
fallback never looks like a silent failure. Nothing is ever published — the
user always reviews the draft and clicks Publish themselves.

**Facebook anti-automation, honestly:** Facebook actively fingerprints
automation, and account restrictions are a real risk for anything that looks
scripted. On Facebook this extension is deliberately manual-assist only: it
performs one fill on a page you opened (or asked it to open) and are looking
at, does not click through Facebook's dropdowns (the menu traversal is an
Anibis-only feature), never submits, and runs no background activity. Use
it as a typing aid, not a bot. If Facebook redesigns the form, fields fall
back to "manual" in the overlay rather than misfiring.

Both sites change their markup regularly. Field lookups are resilient
(aria-label / placeholder / `<label>` text / name, in that order,
multilingual FR/DE/IT/EN) and each site's map is a small self-contained file:
`chrome-extension/content/anibis.js`, `content/facebook.js`.

## Layout

```
connector/
  README.md                     ← you are here (payload contract lives here)
  package.json / tsconfig.json  ← build tooling (esbuild + tsc)
  build.mjs                     ← bundles src/ into chrome-extension/
  src/                          ← TypeScript popup/scan sources
    popup.ts                    popup UI (onboarding, search, sell)
    scan.ts                     camera scan page logic
    onboard.ts                  shared profile-import path (all input methods)
    backup.ts                   profile/backup link decoding
    crypto.ts                   AES-GCM decrypt (updates + photo blobs)
    materialize.ts              enc:log -> inner Y.Doc -> plain items
    sync.ts                     Hocuspocus read-only sync per inventory
    photos.ts                   blob fetch + decrypt + IndexedDB cache
    listing.ts                  item -> listing payload v1 (localized template draft)
    ai.ts                       "Link AI": key parsing, Anthropic draft +
                                category-pick prompts (10s timeout, haiku-class)
    background.ts               service worker: PV_AI_AVAILABLE / PV_AI_CATEGORY
    qr.ts                       QR decode: BarcodeDetector + jsQR fallback
    storage.ts                  chrome.storage.local keys (incl. pv:ai) + photo cache
    core.ts                     barrel bundled for the Node tests
  chrome-extension/             ← load THIS folder unpacked (after npm run build)
    manifest.json               MV3; storage, unlimitedStorage, activeTab,
                                clipboardRead; host permission api.anthropic.com
    popup.html / popup.js       popup (popup.js is generated, gitignored)
    scan.html / scan.js         camera QR scan tab (scan.js generated)
    background.js               generated from src/background.ts (gitignored)
    content/fill-core.js        field finder, React-safe setters, overlay,
                                staged-photo attach, PV_PING/PV_FILL,
                                pending autofill
    content/anibis.js           Anibis field map + category auto-pick
                                (menu scrape, synonyms, safe fuzzy match)
    content/facebook.js         Facebook Marketplace field map
  test/
    unit-tests.mjs              Node: link decode, enc:log decrypt, payload contract
    integration-relay.mjs       Node: real server/ relay + the shipped syncInventory
    run-tests.mjs               Chromium e2e: onboarding (QR drop + link), search,
                                sell flows, pending autofill, guards
    fixture-anibis.html / fixture-facebook.jsx / sample-payload.json
```

## Testing

```bash
cd connector
npm install && (cd test && npm install)
npm test          # unit + relay integration + Chromium e2e
```

- `npm run test:unit` — decodes a backup payload, decrypts an encrypted-doc
  fixture (same wire format as the app), checks the listing-payload contract,
  the localized template boilerplate, the AI prompt/response plumbing against
  a mocked fetch (never a real API), and that serial numbers / profile-carried
  AI keys never leak into the extension.
- `npm run test:relay` — boots the real `server/` relay on a temp dir,
  publishes an encrypted doc through it and syncs it back with the shipped
  `syncInventory` using the read-only token.
- `test/run-tests.mjs` — real extension in Chromium: QR-image onboarding
  (an actual QR PNG is generated and dropped), camera page smoke test (fake
  camera), cached search, per-item sell fill on the Anibis fixture with
  automatic category pick (one- and two-level traversal, fuzzy word match,
  no-guess fallback) and staged-photo attach, the pending-autofill flow on
  the React-controlled Facebook fixture (incl. photo attach through React),
  the app-payload paste path, the wrong-page guard, the listing-language
  templates, and the AI-assisted fill (api.anthropic.com is host-mapped to a
  local mock — the real popup/background fetch paths run, no real API call).

**Verified live** (logged-in anibis.ch, 2026-08): category auto-pick on the
real MUI menu, field fill, automatic photo upload. **Not covered — needs a
live, logged-in manual test:** the real Facebook form markup (the fixture
mirrors typical structure only), Facebook's rich-text description variant
and photo input, publishing (never automated), and a real webcam scan.
