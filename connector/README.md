# Peerventory Listing Connector

Sell an item from your Peerventory inventory on [Anibis](https://www.anibis.ch)
(Swiss classifieds) and [Facebook Marketplace](https://www.facebook.com/marketplace).

Neither platform has a public listing-creation API (Facebook's Marketplace API
is restricted to approved commerce partners; Anibis has none), so the connector
is a **manual-assist Chrome extension**: the app drafts the listing, the
extension autofills the listing form the user already has open, and the user
reviews and publishes. Nothing is submitted automatically.

## Architecture

```
Peerventory app (item sheet)                Chrome extension (this folder)
┌─────────────────────────────┐             ┌────────────────────────────────┐
│ "Sell / export listing"     │             │ popup: paste / read clipboard, │
│  · drafts copy (AI if a     │  clipboard  │   validate, store payload      │
│    Claude key is on device, ├────────────►│ content scripts:               │
│    template otherwise)      │   (JSON)    │   anibis.ch, facebook.com      │
│  · price from valueCurrent  │             │   → autofill visible form,     │
│  · downloads decrypted      │             │     status overlay             │
│    photos as files          │  drag&drop  │                                │
│                             ├────────────►│ (photos: user drags the files) │
└─────────────────────────────┘             └────────────────────────────────┘
```

- The AI copywriting happens **in the app** (`app/src/ui/lib/listing.ts`),
  with the device's own Anthropic key. The extension never sees the key.
- The extension is fully local: no remote code, no analytics, no servers.
  The payload lives in `chrome.storage.local` until you clear it.
- Photos cannot be programmatically attached by an extension (file inputs
  require a user gesture with a real file). The app downloads the decrypted
  photos as loose files; the overlay reminds you to drag them into the form.

## Payload schema (v1)

Produced by `app/src/ui/lib/listing.ts` (`buildPayload`), consumed by
`chrome-extension/content/fill-core.js` (`validPayload`). Keep them in sync.

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
    "serialIncluded": true       // item has a serial number on record (number itself never exported)
  },
  "photosNote": "string — human hint about the downloaded photos"
}
```

## Using it

1. In the app, open an item → **Sell / export listing** → review/edit the
   draft → **Copy for extension** (and **Download photos**).
2. Load the extension (once): `chrome://extensions` → enable **Developer
   mode** → **Load unpacked** → select `connector/chrome-extension/`.
3. Open the listing form:
   - Anibis: the publish flow (e.g. `anibis.ch/fr/publier`)
   - Facebook: `facebook.com/marketplace/create/item`
   (If the page was already open before installing, reload it.)
4. Click the extension icon → **Read clipboard** (or paste) → **Fill this
   page**. An overlay on the page shows what was filled and what needs manual
   attention. Drag the downloaded photos into the form, pick category /
   condition, review, publish.

## What can and cannot be automated

| Field | Anibis | Facebook Marketplace |
| --- | --- | --- |
| Title | autofilled | autofilled |
| Description | autofilled (FR/DE translation matching page language) | autofilled |
| Price | autofilled (CHF warning if payload is another currency) | autofilled (number only; account currency assumed) |
| Condition | autofilled when it is a native `<select>`; otherwise manual hint | manual hint (custom combobox) |
| Category | manual hint (multi-step picker dialog) | manual hint (custom combobox) |
| Photos | manual drag & drop of downloaded files | manual drag & drop |
| Publish | manual, always | manual, always |

**Facebook anti-automation, honestly:** Facebook actively fingerprints
automation, and account restrictions are a real risk for anything that looks
scripted. This extension is deliberately manual-assist only: it performs one
fill on a page you opened and are looking at, does not click through
dropdowns, never navigates, never submits, and runs no background activity.
Use it as a typing aid, not a bot. If Facebook redesigns the form, fields fall
back to "manual" in the overlay rather than misfiring.

Both sites change their markup regularly. Field lookups are resilient
(aria-label / placeholder / `<label>` text / name, in that order, multilingual
FR/DE/IT/EN) and each site's map is a small self-contained file that is easy
to update: `chrome-extension/content/anibis.js`, `content/facebook.js`.

## Layout

```
connector/
  README.md                     ← you are here (payload contract lives here)
  chrome-extension/             ← load this folder unpacked; no build step
    manifest.json               MV3; storage + activeTab + clipboardRead only
    background.js               empty service worker (tooling/ID discovery)
    popup.html / popup.js       payload intake + "Fill this page"
    content/fill-core.js        field finder, React-safe setters, overlay
    content/anibis.js           Anibis field map
    content/facebook.js         Facebook Marketplace field map
  test/                         ← automated tests (fixtures, not live sites)
    run-tests.mjs               end-to-end: real extension in Chromium
    fixture-anibis.html         plain-form stand-in (FR labels)
    fixture-facebook.jsx        React-19-controlled stand-in
    sample-payload.json
```

## Testing

```bash
cd connector/test
npm install
npm test
```

The test launches Chromium with the unmodified extension loaded, maps
`www.anibis.ch` / `www.facebook.com` to a local HTTPS fixture server
(`--host-resolver-rules`), and asserts: extension + popup load, payload
validation, content-script injection through the real manifest matches,
autofill of plain and React-controlled forms (native-setter trick verified via
React state), select-option matching, manual-hint reporting, the status
overlay, and the not-a-listing-page guard.

**Not covered — needs a live, logged-in manual test:** the real Anibis and
Facebook form markup (fixtures mirror typical structure only), Facebook's
rich-text description variant (contenteditable path), category/condition
pickers, photo drag & drop, and publishing.
