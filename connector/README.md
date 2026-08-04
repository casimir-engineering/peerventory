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
  cached in the extension's IndexedDB. Each item also has a **Photos** button
  that downloads the decrypted photos as files — extensions cannot attach
  files to a form, so you drag them in yourself.
- **Sell on X** — each result row has *Sell on Anibis* and *Sell on
  Facebook*. If the active tab is that marketplace (detected by pinging the
  content script — no `tabs` permission needed), the listing form is filled
  immediately. Otherwise the extension opens the listing form in a new tab
  and the content script fills it as soon as the form renders (one-shot
  `pv:pending` flag, expires after 2 minutes).
- **Listing copy** — generated from the item by the same template the app
  uses (title from brand+description, price from `valueCurrent` rounded, or
  60% of `valueNew`). For AI-drafted copy, keep using the app's **Sell /
  export listing** dialog and paste the payload into the popup's advanced
  box — same fill path, and the Anthropic key stays in the app.

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
    "category": "string?",       // hint only — pickers stay manual
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
| Title | autofilled | autofilled |
| Description | autofilled (FR/DE translation matching page language, when present) | autofilled |
| Price | autofilled (CHF warning if payload is another currency) | autofilled (number only; account currency assumed) |
| Condition | autofilled when it is a native `<select>`; otherwise manual hint | manual hint (custom combobox) |
| Category | manual hint (multi-step picker dialog) | manual hint (custom combobox) |
| Photos | manual drag & drop of downloaded files | manual drag & drop |
| Publish | manual, always | manual, always |

**Facebook anti-automation, honestly:** Facebook actively fingerprints
automation, and account restrictions are a real risk for anything that looks
scripted. This extension is deliberately manual-assist only: it performs one
fill on a page you opened (or asked it to open) and are looking at, does not
click through dropdowns, never submits, and runs no background activity. Use
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
    listing.ts                  item -> listing payload v1 (template draft)
    qr.ts                       QR decode: BarcodeDetector + jsQR fallback
    storage.ts                  chrome.storage.local keys + photo cache
    core.ts                     barrel bundled for the Node tests
  chrome-extension/             ← load THIS folder unpacked (after npm run build)
    manifest.json               MV3; storage, unlimitedStorage, activeTab, clipboardRead
    popup.html / popup.js       popup (popup.js is generated, gitignored)
    scan.html / scan.js         camera QR scan tab (scan.js generated)
    background.js               empty service worker
    content/fill-core.js        field finder, React-safe setters, overlay,
                                PV_PING/PV_FILL, pending autofill
    content/anibis.js           Anibis field map
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
  fixture (same wire format as the app), checks the listing-payload contract
  and that serial numbers / AI keys never leak into the extension.
- `npm run test:relay` — boots the real `server/` relay on a temp dir,
  publishes an encrypted doc through it and syncs it back with the shipped
  `syncInventory` using the read-only token.
- `test/run-tests.mjs` — real extension in Chromium: QR-image onboarding
  (an actual QR PNG is generated and dropped), camera page smoke test (fake
  camera), cached search, per-item sell fill on the Anibis fixture, the
  pending-autofill flow on the React-controlled Facebook fixture, the
  app-payload paste path and the wrong-page guard.

**Not covered — needs a live, logged-in manual test:** the real Anibis and
Facebook form markup (fixtures mirror typical structure only), Facebook's
rich-text description variant, category/condition pickers, photo drag &
drop, publishing, and a real webcam scan.
