<p align="center">
  <img src="app/public/icon-192.png" width="96" alt="Peerventory icon" />
</p>

# Peerventory

Local-first inventory app for customs manifests and shipping personal effects
across borders. Every device holds the full database and works completely
offline; devices sync through any number of small self-hosted relays over WSS
on port 443 (looks like ordinary HTTPS traffic, works on restrictive
networks) and directly with each other over WebRTC on the same network. Sync
is end-to-end encrypted: relays only ever store ciphertext, are fully
interchangeable, and any one of them can disappear without data loss. No
third-party services hold your data.

Runs as an installable web PWA (desktop + mobile) and as an Android APK built
from the same codebase with Capacitor (with native niceties like system
back-button navigation through the app's screens).

## Install on Android

Download **`inventory-release.apk`** from the
[latest release](https://github.com/casimir-engineering/peerventory/releases/latest)
and open it on the phone. Android asks once for permission to install apps from
your browser; after that the APK installs like any other app. There is no Play
Store listing — the app is sideloaded.

The app checks GitHub for a newer release on start and shows a dismissible
"Update available" strip; Account & sync also has a manual **Check for
updates** with the installed version. Tapping Download hands the APK to your
browser, and the finished download installs over the existing app, keeping all
data. Every release is signed with the same key, which is what lets Android
treat it as an update rather than a different app.

On desktop or as a PWA nothing is needed: the service worker picks up new
versions on its own.

The launcher label is **Peerventory**, so searching your app drawer for
"inventory" will not find it — launcher search matches the label as a substring
(or a fuzzy subsequence), and "Peerventory" contains neither an "i" nor
"inventory". Search for "peer" or "ventory" instead. An `activity-alias`
labelled "Inventory" would make it searchable, but only with
`category.LAUNCHER`, which puts a second icon in the drawer — not worth it, so
the alias is deliberately not shipped.

## Screenshots

An invented demo account seeded on a local dev instance — regenerate with
`scripts/screenshots/`:

<p align="center">
  <img src="docs/screenshots/01-home.png" width="30%" alt="Home screen: the inventories on this device with item counts, totals and sync state" />
  <img src="docs/screenshots/02-search.png" width="30%" alt="One search field finds items across every inventory on the device" />
  <img src="docs/screenshots/03-items.png" width="30%" alt="Item list with photos, quantities, weights, cartons and values" />
</p>
<p align="center">
  <img src="docs/screenshots/04-item.png" width="30%" alt="Item sheet: photos, AI autofill, values in any currency" />
  <img src="docs/screenshots/05-move.png" width="30%" alt="Moving an item to another inventory, with its photos and history" />
  <img src="docs/screenshots/06-share.png" width="30%" alt="Share modal: view-only or can-edit QR code carrying the decryption key" />
</p>
<p align="center">
  <img src="docs/screenshots/07-stats.png" width="30%" alt="Statistics: totals, and breakdowns by box and category" />
  <img src="docs/screenshots/08-settings.png" width="30%" alt="Inventory settings: boxes and the three export formats" />
</p>
<p align="center">
  <img src="docs/screenshots/09-account.png" width="30%" alt="Account and sync: your devices, the device-link QR and the account backup" />
  <img src="docs/screenshots/10-relays.png" width="30%" alt="Account and sync: relays with health dots, direct device-to-device sync, AI key" />
</p>

## What it does

**Item sheets built for customs.** Photos, current/new value, mandatory
weight and size quick-classes (refinable to exact grams and L×W×H mm),
serial numbers, HS codes, lithium-battery flag, country of origin,
condition, purchase info, translations — the fields a forwarder or customs
desk actually asks about, and that an AI cannot reconstruct later.

**One list, one search.** The home screen shows every inventory on the
device with its item count, value, weight, volume and last sync, and its
search field looks inside all of them at once — descriptions, brands,
categories, serial numbers, conditions and place labels — so an item is one
query away even when you cannot remember which shipment it went into.
Everything about you and this phone (devices, backups, relays, AI key) sits
behind the ⚙︎ icon in the header, on the **Account & sync** screen.

**Sync that survives bad networks.** The store is a Yjs CRDT persisted in
IndexedDB. Everything works offline; changes merge conflict-free when a
connection to the relay comes back. Two people can edit the same inventory
simultaneously. The relay speaks ordinary WSS on 443, which passes through
restrictive networks.

**End-to-end encrypted.** Items and photos are encrypted on-device
(AES-256-GCM) before they reach the relay; the relay — and anyone who can
read its disk — only stores opaque ciphertext and enforces access tokens.
The per-inventory decryption key travels exclusively in the URL **fragment**
of share links/QR codes and in device backups, which browsers never send to
any server.

**Sharing by link or QR.** Any inventory, single item, or item selection can
be shared with a short link / QR code, as **view only** or **can edit**
(separate revocable-by-rotation tokens). The link carries the decryption key
in its fragment, so read access means decrypt access. Opening a link pulls
the whole inventory to the new device, photos included, where it keeps
working offline.

**Values in any currency.** Prices can be typed in any currency ("150 cny");
conversion tables are fetched at launch and cached for offline use. Totals are
shown in the inventory's main currency.

**Locations with history.** GPS or manual entry with worldwide place search;
place labels are remembered and re-suggested within 250 m. Inventories can be
set to store **labels only** so coordinates never enter the synced document.

**Owner tracking.** Per-item owner history (on by default, disableable per
item or per inventory) — useful when a shipment mixes several people's things.

**Moving items between inventories.** An item can be moved to any other
inventory this device can edit, with everything it carries: quantity,
translations, and the full location and owner history. Its photos are
re-encrypted under the target inventory's key and queued for upload, so the
move works offline. If a photo was never downloaded to this device, the app
says so and asks before leaving it behind.

**Selecting several items at once.** Press and hold an item card (or tap
**Select items**) to enter selection mode: tapping cards ticks them, the bar
counts them and offers Select all, and the actions at the bottom share,
export, save the picks as a list, or delete them. Deleting asks for a second
tap — **Delete (n)** turns red and reads **Confirm** for a couple of seconds
— and then removes the whole selection in one synced change. Back (or
Escape) leaves selection mode rather than the screen.

**Statistics.** Total value, weight, and volume per inventory, broken down by
carton and category — matching what goes on the customs manifest. An item
sheet describes one object, so every total multiplies its per-unit value,
weight and volume by that item's quantity; counts stay counts of items, with
the unit count shown beside them whenever the two differ.

**Exports and imports.** An inventory's Settings has one tap each for
**Spreadsheet (.xlsx)** (the customs manifest, with photo thumbnails),
**Archive with photos (.zip)** (spreadsheet + data file + every photo) and
**Data only (.yaml)** (the canonical backup); a selection of items can be
exported to a spreadsheet of its own from any list. The same files import
back — drop them anywhere on the home screen (or use Restore / import from
file on Account & sync) to rebuild an inventory, photos included.

**Link a device / backup.** Your devices form one account: on **Account &
sync**, "Link another device" shows a small QR, you scan it with Open / Scan
on the second phone, and every inventory — today's and tomorrow's — arrives
through sync. "Share backup (.zip)" writes one file with the whole account
and the full contents of every inventory; a full-backup link or QR image
carries every access token alone, for archiving or for the browser
extension. Backups never downgrade existing local access, and "Leave account
on this device" cleanly removes the account from one phone without touching
the others.

**On-device AI autofill (optional).** Point it at the item photos and it
fills description, brand, values, weight, dimensions, HS code, translations.
Calls go directly from the device to the Anthropic API with a user-supplied
key stored only on that device (provisionable by QR). Nothing AI-related
transits the relay.

**Offline OCR.** Serial numbers can be captured with the camera; Tesseract
runs fully on-device (no CDN, works behind restrictive firewalls).

## Selling connector

Every item sheet has a **Sell / export listing** button that drafts
marketplace copy (AI-written when a Claude key is on the device, field
template otherwise) and exports it as a JSON payload plus the item's photos.
A companion Chrome extension in `connector/` autofills the listing forms of
Anibis and Facebook Marketplace from that payload — manual-assist only, the
user always reviews and publishes. See `connector/README.md` for the payload
contract and workflow.

## Architecture: relays are interchangeable encrypted mailboxes

```
┌──────────┐  encrypted Yjs log, WSS :443  ┌────────────────────┐
│  device  │ ◄───────────────────────────► │   relay A (yours)  │
│ (PWA/APK)│ ◄──────────────────────────┐  │  Hocuspocus + blob │
│ IndexedDB│                            │  │  store + signaling │
└────┬─────┘                            │  └────────────────────┘
     │ WebRTC (direct, LAN/NAT)         └► ┌────────────────────┐
┌────┴─────┐   signaling via own relays    │ relay B (a friend's│
│  device  │ ◄───────────────────────────► │ box, a VPS, ...)   │
└──────────┘                               └────────────────────┘
```

- **Relays are dumb, content-agnostic and interchangeable.** A relay routes
  and persists an opaque append-log of AES-256-GCM-encrypted CRDT updates
  plus encrypted photo blobs; access is by per-document token (sha-256
  hashes stored server-side). The real inventory document exists only on
  devices; decryption keys never reach any relay. No relay is special and
  relays know nothing about each other.
- **Multi-relay replication.** Every device keeps a relay list; every
  inventory records which relays it lives on and syncs through ALL of them
  simultaneously. The same access tokens work on every relay ("replicate to
  all my relays" registers the doc on new relays through the ordinary
  creation handshake and pushes the encrypted state + photos). Kill a relay
  and the doc keeps syncing through the others; a share link's origin is
  just a hint for one relay it lives on.
- **Direct device-to-device sync.** Devices holding the same inventory also
  connect over WebRTC (y-webrtc) and exchange the same encrypted bytes a
  relay would see — two phones on one Wi-Fi sync even with no relay
  reachable. Peer discovery ("signaling") runs on your own relays' `/signal`
  endpoint, never on public servers, and rooms are unguessable HMACs of the
  document id under its encryption key, plus an encrypted-signaling room
  password — strangers on a relay cannot discover or join your documents.
- **Devices are the source of truth**: full database on every device,
  offline first; any relay can be rebuilt from any device that holds the
  documents.

## Self-hosting a relay

Any box that can run Docker can be a relay for your inventories (and only
stores ciphertext for whatever gets pushed to it):

```bash
git clone <this repo> && cd inventory-app
# Build the PWA the relay serves (set the origin the relay will live at)
cd app && npm install && VITE_SERVER_ORIGIN=https://inv.example.com npm run build && cd ..
# Standalone with automatic TLS (Caddy):
cd deploy && echo 'INVENTORY_HOST=inv.example.com' > .env && docker compose up -d --build
# ...or behind an existing reverse proxy: see deploy/npm-proxy/README.md
```

Then, in the app, open **⚙︎ Account & sync → Sync & relays** and add
`inv.example.com`; each relay shows a health dot once it answers. New
inventories use it automatically, and "Replicate to all my relays" in an
inventory's Settings pushes existing ones there.

## Layout

- `app/` — Vite + React + TypeScript PWA; Yjs CRDT store (`y-indexeddb` local
  persistence, one Hocuspocus sync client per relay, y-webrtc direct sync);
  Capacitor Android packaging
- `server/` — single Node service (one instance = one relay): Hocuspocus
  sync (`/sync`) + content-addressed photo blob API (`/api/blobs`) + WebRTC
  signaling (`/signal`)
- `connector/` — Chrome extension (MV3) that autofills marketplace listing
  forms from the app's Sell payload, plus its tests
- `deploy/` — Docker Compose deployments: standalone with Caddy TLS
  (`deploy/`), or behind an existing reverse proxy (`deploy/npm-proxy/`)
- `design/` — `icon-source.png`, the 1024×1024 master every app icon is cut
  from, plus the generated `icon-preview.png` contact sheet
- `scripts/screenshots/` — Playwright driver that seeds an invented demo
  account into a dev build and recaptures every image above
- `CONTRACTS.md` — binding protocol contracts between app and server
- `docs/screenshots/` — the images above

## Development

```bash
cd server && npm install && npm run dev     # sync + blob server on :8787
cd app && npm install
echo 'VITE_SERVER_ORIGIN=http://localhost:8787' > .env.local
npm run dev                                 # PWA on http://localhost:5173
```

In dev builds the store is exposed as `window.__store` / `window.__services`
for console debugging and demo seeding. The README screenshots are produced
through that hook: with the dev server and a local relay running,
`npm install && npm run capture` in `scripts/screenshots/` reseeds the demo
account and rewrites `docs/screenshots/` (details in `capture.mjs`).

## Building

```bash
# Web (set the public origin so share links and the APK point at your server)
cd app && VITE_SERVER_ORIGIN=https://inventory.example.com npm run build

# Android APK (requires Android SDK + JDK 21)
npx cap sync android
cd android && ./gradlew assembleRelease
# then zipalign + apksigner with your own keystore
```

`app/package.json`'s `version` is the single source of truth: vite bakes it
into the bundle as the version the updater compares against, and
`app/android/app/build.gradle` reads the same file for `versionName` plus a
derived `versionCode` (1.1.0 → 10100).

### Icons

```bash
scripts/gen-icons.sh --preview   # rewrite every icon from design/icon-source.png
```

Every launcher, PWA, splash, and favicon asset is generated from
`design/icon-source.png` with ImageMagick, so the icon is never edited in
place. The script cuts two derivatives from the master — the whole tile with
the area outside its rounded corners made transparent, and the boxes alone on
transparency — and sizes the second one so its bounding box clears a circular
mask in every context that applies one (Android adaptive foreground and
monochrome layers, `ic_launcher_round`, the maskable PWA icon).
`--preview` writes `design/icon-preview.png`, which shows the real generated
files under each of those masks.

## Releasing

```bash
scripts/release.sh 1.2.0     # bump, build web + signed APK, publish to GitHub
scripts/release.sh --dry-run # everything except the GitHub release
scripts/release.sh --apk-only
```

One command does the version bump, the production web build, `cap sync`,
`assembleRelease`, zipalign, apksigner, and `gh release create` with the APK
attached and notes generated from the commits since the previous tag. It
refuses to run if `scripts/secret-scan.sh` fails or the tag already exists.

Releases are cut from the maintainer's machine, not CI, and deliberately so:
the upload key lives in `secrets/release.keystore` (gitignored, never
uploaded). Android only accepts an update signed with the same key as the
installed app, so that keystore is the one irreplaceable artifact — losing it
means every user has to uninstall and reinstall. The script reads its password
from `PV_KEYSTORE_PASS` or `secrets/keystore.pass`.

`scripts/secret-scan.sh` runs in CI on every push and as a pre-commit hook
(`git config core.hooksPath .githooks`), failing on API keys, tokens, private
keys, signing passwords, and any attempt to track `secrets/`, `.env`, or
keystore/APK files.

## Deployment

See `deploy/README.md` (standalone, Caddy terminates TLS) or
`deploy/npm-proxy/README.md` (behind an existing reverse proxy). Both are a
single `docker compose up -d` once DNS points at the box.

## Security notes

- Share links and backups carry bearer tokens **and the decryption key**:
  whoever has the link/QR has the access it grants. Treat backups like
  passwords.
- All inventories are end-to-end encrypted; a relay operator only ever
  sees ciphertext, blob sizes, and coarse metadata (doc ids, update timing,
  random per-device write ids). The key rides in the URL fragment, which the
  browser never sends to any server. The same tokens work on every relay a
  document is replicated to — only push documents to relays run by people
  you would hand the (encrypted) mailbox to.
- Direct device-to-device sync never uses public signaling servers: peers
  meet through your own relays, in rooms derived from the document's
  encryption key (unguessable without it), with signaling payloads
  additionally encrypted by a key-derived room password. A signaling relay
  learns only opaque room ids, IP addresses and timing. WebRTC's STUN step
  uses standard public STUN servers (they see IPs, never data).
- The optional Anthropic key is stored only in the device's localStorage and
  is sent only to the Anthropic API, never to the relay.
