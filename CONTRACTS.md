# Cross-component contracts

Single source of truth for how `app/` (client) and `server/` talk. The data model
contract lives in `app/src/types.ts`; the store<->UI contract in `app/src/store/contract.ts`.

## IDs and tokens

- All entity IDs: 10-char nanoid, base58 alphabet (`123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`).
- Tokens (rw/ro): 16-char nanoid, same alphabet.
- Server stores only sha256 hashes of tokens.

## Sync protocol (Yjs / Hocuspocus)

- WebSocket endpoint: `wss://<host>/sync` (server listens on `/sync`).
- Hocuspocus document name = inventory `docId`.
- Client connects with Hocuspocus `token` field = JSON string:
  - Normal connect: `{"t": "<rwToken or roToken>"}`
  - First-ever connect for a doc the client created:
    `{"t": "<rwToken>", "create": {"rwHash": "<sha256hex(rwToken)>", "roHash": "<sha256hex(roToken)>"}}`
- Server behavior (`onAuthenticate`):
  - Unknown docId + `create` payload present + sha256(t) == rwHash: store `{rwHash, roHash}` in doc meta, grant read-write.
  - Unknown docId without valid `create`: reject.
  - Known docId: sha256(t) == rwHash -> read-write; == roHash -> set connection readonly; else reject.
- Server returns access level to the client via the Hocuspocus auth payload/context so the
  client can mark its handle readonly.
- Server persists docs to disk (Hocuspocus SQLite extension or LevelDB) under `server/data/`.
- The synced Hocuspocus document is always the opaque OUTER doc (see
  "End-to-end encryption"); everything in this section applies to it
  unchanged. The server is content-agnostic and must never inspect doc
  content — from its point of view every doc is just Yjs bytes.

## End-to-end encryption

The relay protocol is E2E-only for clients: every inventory is end-to-end
encrypted, and the app has no plaintext sync mode. The relay (and anyone who
can read its disk) only ever sees ciphertext; it keeps enforcing access
control via the rw/ro tokens exactly as before. (The server itself stays
content-agnostic — a non-app client could sync plaintext through it, which is
what the server e2e test does as a control.)

### Content key

- Per-document symmetric key: 32 random bytes (WebCrypto AES-256-GCM),
  encoded base64url (43 chars) everywhere it travels.
- The key NEVER reaches the server. It travels only in URL hash fragments
  (share links/QR, never sent in HTTP requests), in device-backup payloads,
  and lives in the local registry (`InventoryHandle.key`).
- Both ro and rw holders receive the same content key: read access means
  decrypt access. Write-vs-read stays enforced server-side by the auth tokens.
- A device holding the tokens but not the key can relay/store ciphertext but
  shows "Encryption key missing" instead of content.

### Sync protocol (outer/inner doc wrapping)

Chosen design: the Hocuspocus document named `docId` is an OUTER Y.Doc whose
only content is opaque ciphertext; the real inventory doc (the INNER doc,
schema in contract.ts) exists only on clients (y-indexeddb, key = docId).
Auth, the create-handshake, readonly enforcement and the server code are
completely unchanged — the server still merges the outer doc via
extension-sqlite, but everything it merges is ciphertext.

Outer doc schema:

- `Y.Array('enc:log')` — append-log of entries
  `{ v: 1, dev: <deviceId>, seq: <number>, snap?: true, iv: Uint8Array(12), ct: Uint8Array }`
- `ct` = AES-256-GCM(content key, iv, AAD = docId bytes) over a Yjs update of
  the inner doc (`snap: true` marks a full-state snapshot). The AAD binds an
  entry to its document, so ciphertext cannot be replayed into another doc.

Client pipeline (app/src/store/e2ee.ts):

- Local inner-doc edits are encrypted and appended to the log; incoming log
  entries are decrypted and applied to the inner doc. Applying Yjs updates is
  idempotent and commutative, so replay order and duplicates are harmless.
- A client-side SHADOW doc mirrors exactly the state representable from the
  log. After loading and on every server sync, the client applies
  `diff = encodeStateAsUpdate(inner, stateVector(shadow))` as a new log entry
  when non-empty. This pushes edits made offline (or before the wrapper
  started) without needing per-update bookkeeping.
- Compaction: when the log exceeds 40 entries or 400 KB of ciphertext, the
  writer that authored the LAST entry replaces all entries it has successfully
  decrypted with one `snap: true` full-state entry (encrypted
  `encodeStateAsUpdate(shadow)`). Concurrent appends are safe (Y.Array keeps
  concurrently inserted items); concurrent double-compaction is safe (two full
  snapshots merge to the same state); entries a client could not decrypt are
  never deleted by it.

Design alternatives considered (decision record):

- Encrypting values inside the existing doc: not E2E — Yjs structure, keys,
  ids and edit patterns stay visible, and the server-side merge requires
  readable CRDT structure.
- secsync-style custom protocol (replace Hocuspocus with a bespoke encrypted
  snapshot/update relay): the cleanest theoretical fit, but it replaces the
  entire transport (server + provider + reconnect/backoff/auth plumbing) with
  new custom code and drops battle-tested pieces this app already relies on.
- Outer/inner wrapping (chosen): zero server changes, keeps the Hocuspocus
  provider, auth and offline behavior; costs one layer of indirection on the
  client and ~2x transient storage for the log until compaction. Tradeoff
  accepted: the server can still see coarse metadata — doc ids, ciphertext
  sizes, update timing/frequency, and roughly how many devices write (device
  ids in the log are random, not linked to identity).

### Photo blobs

- Blobs are encrypted client-side before upload; the server stores opaque
  bytes and the blob hash addresses the CIPHERTEXT:
  `hash = sha256hex(iv || AES-GCM(key, iv, envelope))` where
  `envelope = mimeLen(u16 BE) || mime || imageBytes`.
- The IV is deterministic: `HMAC-SHA256(key, "peerventory:photo-iv:" +
  sha256hex(envelope))` truncated to 12 bytes. Same key + same photo bytes ->
  same ciphertext, so content addressing, HEAD-based dedupe and idempotent
  uploads keep working. IV reuse across distinct plaintexts is impossible by
  construction (the IV commits to the plaintext).
- Upload uses `content-type: application/octet-stream`; the real mime lives
  encrypted in the envelope (and in the PhotoRef inside the encrypted doc).

### Share links, backups

- Share links carry the key in the fragment:
  `#/join/<docId>/<token>/k/<base64urlKey>[/i/...|/l/...|/sl/...]`.
  A link without `/k/` still joins (tokens grant relay access) but the device
  cannot decrypt: the UI shows "Encryption key missing" until a full link or
  QR code delivers the key.
- Backup payload v2: handle entries carry `ek` (content key) and the payload
  carries `oi` (the user's stable owner id, see "Owner identity") and `p`
  (the synced-profile doc handle, see "Synced profile"); v1 payloads (no
  keys) and payloads without `oi`/`p` are still accepted on restore.

## Blob API (photos)

Photos are content-addressed: `hash = sha256hex(bytes)` where `bytes` are the
encrypted blob (see "End-to-end encryption") of the final (client-side
resized, max 2048px, JPEG/WebP) image: the hash addresses ciphertext and the
server never sees image contents or the real mime type.

- `PUT /api/blobs/:docId/:hash` — body: raw bytes, headers: `x-token: <rwToken>`, `content-type: <mime>`.
  Server verifies rw token for docId, verifies sha256(body) == hash, stores at
  `server/data/blobs/<hash[0:2]>/<hash>` (global dedupe) and records `<docId> -> hash` reference
  plus the mime type. Returns 204. Idempotent.
- `GET /api/blobs/:docId/:hash` — header `x-token: <rwToken or roToken>`. Returns bytes with stored content-type.
- `HEAD` same as GET without body (used by upload queue to skip existing).
- Max blob size: 10 MB. Anything else: 413.

## Share links (client-side routing, hash router)

- Inventory: `https://<host>/#/join/<docId>/<token>/k/<base64urlKey>` — token
  may be rw or ro; the content key always directly follows the token; joining
  flow stores a handle then redirects to `#/inv/<docId>`. Links without `/k/`
  still parse and join, but content stays unreadable ("Encryption key
  missing") until the key arrives.
- Item: `https://<host>/#/join/<docId>/<token>/k/<key>/i/<itemId>`
- Item list: `https://<host>/#/join/<docId>/<token>/k/<key>/l/<id1>.<id2>.<id3>` (dot-joined item IDs; UI offers "save as list" for long selections, which shares `#/join/<docId>/<token>/k/<key>/sl/<listId>` instead).
- Already-joined shortcuts (no token): `#/inv/<docId>`, `#/inv/<docId>/i/<itemId>`, `#/inv/<docId>/l/...`, `#/inv/<docId>/sl/<listId>`.

## Client server-config

`app/src/config.ts` exports `getServerConfig(): { wsUrl: string; httpUrl: string }`.
Defaults derive from `import.meta.env.VITE_SERVER_ORIGIN` (e.g. `https://inv.example.com`),
falling back to `window.location.origin`. `wsUrl = origin.replace(/^http/, 'ws') + '/sync'`,
`httpUrl = origin + '/api'`.

## Client services (app/src/services/) — v2 features

All services degrade silently offline; the app never blocks on them.

- `currency.ts`: `ensureRates(): Promise<void>` (fetch https://open.er-api.com/v6/latest/USD once per 24h, cache in localStorage `fx:v1`, keep stale cache offline); `convert(amount: number, from: string, to: string): number | null`; `knownCurrencies(): string[]`; `ratesAgeMs(): number | null`.
- `units.ts`: `parseWeightToGrams(input: string): number | null` (accepts `200`, `200g`, `0.2 kg`, `1.5kg`, `2 lb`, `3oz`, comma decimals; bare number = grams); `formatGrams(g: number): string` (< 1000 -> `850 g`, else `1.5 kg`); `parseLengthToMm(input: string): number | null` (mm/cm/m/in; bare number = mm); `formatMm(mm: number): string` (mm < 100, cm < 1000, else m); `weightGramsOfItem(item): { grams: number; estimated: boolean }` (exactGrams or class midpoint, gt20kg -> minG); `volumeM3OfItem(item): { m3: number; estimated: boolean }` (exact L*W*H else SIZE_CLASSES approxLiters; per single unit, caller multiplies by quantity).
- `geocode.ts`: `searchPlaces(query: string): Promise<PlaceHit[]>` (Photon `https://photon.komoot.io/api/?q=...&limit=6&lang=en`; `PlaceHit = { label: string; lat: number; lon: number }`; [] on any failure); `rememberPlace(label, lat, lon)` (localStorage `places:v1`, dedupe by label+~coords); `nearestPlaceLabel(lat, lon, maxMeters = 250): string | null` (haversine, closest under threshold).
- `profile.ts`: `getUserName() / setUserName(name)` (localStorage `profile:v1`); `getOwnerId()` (stable owner id, generated once — see "Owner identity"); `effectiveOwnerId(docId)` = per-doc linked owner id ?? `getOwnerId()`; `ownerAliasFor(docId) / setOwnerAlias(docId, name)`; `effectiveOwnerName(docId)` = alias ?? username; `subscribeOwnerName(cb)` (fires on name/alias/owner-link changes; the store uses it to push renames into open docs); `rememberInput(key, value)` / `suggestInputs(key): string[]` (generic recent-values history `inputs:v1`, most-recent-first, cap 20 per key; keys in use: `currency`, `category`, `vendor`, `country`, `owner`); `getLastCurrency() / setLastCurrency(code)`.
- `ai.ts`: `analyzeItemPhotos(docId, photos: Blob[], context: { description?: string; mainCurrency: string }): Promise<AiSuggestions>` — calls the Anthropic Messages API DIRECTLY from the device (CORS via `anthropic-dangerous-direct-browser-access`), using the per-device key from `aikey.ts`. Photos are downscaled to 1024px JPEG before upload to keep vision-token cost low. Throws `Error` with a user-displayable message on failure.
- `aikey.ts`: per-device Anthropic key in localStorage `aiKey:v1` (never synced, never sent to our server). `getAiKey/setAiKey/clearAiKey/maskedAiKey`, and QR provisioning: a scanned code `inv-ai:<key>` (see `parseAiKeyQr`, handled by the Open/Scan flow) installs the key on the device.

`AiSuggestions` (all fields optional): `description, category, tags: string[], brandModel, valueCurrent: {amount,currency}, valueNew: {amount,currency}, weightGrams: number, dimensionsMm: {l,w,h}, lithiumBattery: boolean, countryOfOrigin, hsCode, condition, translations: Record<string,string>`.

## Synced profile (device group)

The set of inventory handles itself syncs between a user's devices through a
dedicated PROFILE DOC (`app/src/store/profileSync.ts`), so a backup QR links
devices permanently instead of copying a static snapshot. To the relay the
profile doc is just another doc: same outer `enc:log` E2E wrapping, same
rw/ro tokens with sha256-hash auth and the same create handshake — zero
server changes.

- Identity: `{ docId, rwToken, roToken, key }` stored locally in
  `profile:v1` (`profileDoc`), generated lazily on first app start (the
  migration path for existing installs: the engine then seeds the doc from
  the current local registry). Devices share it only via backup payloads.
- Inner doc schema:
  - `Y.Map('profile')`: `{ name?: string, ownerId?: string }` — the display
    name syncs (doc wins on sync; an explicit local rename pushes); ownerId
    is fill-only, same rule as backup import.
  - `Y.Map('inventories')`: `docId -> { d, rw?, ro?, ek?, nm?, removed?,
    at }` — one plain-object entry per inventory keyed by docId, so
    concurrent list edits merge per inventory (LWW per entry). The AI key is
    NEVER stored here.
- Mirroring: doc -> registry goes through `importHandles` (never downgrades
  access); newly arrived handles are opened immediately so the inventory
  materializes through normal sync. Registry -> doc is a debounced fill-only
  merge (a device missing a token/key cannot erase it from the entry).
- Removal semantics (chosen): leaving/forgetting an inventory writes a
  `removed: true` tombstone. Other devices drop the handle from their
  registry/list but RETAIN their locally cached doc data (close without
  clear) — nothing is silently deleted; re-joining via share link or backup
  import writes a live entry over the tombstone and revives the inventory
  everywhere.
- Backups: payload v2 gains `p = { d, rw?, ro?, ek }`. Import with `p` =
  "join that profile" (an existing local profile is switched to the imported
  one and the local registry is pushed into it, so both devices converge on
  one list). Old payloads without `p` import statically as before, and the
  imported handles are merged into the importing device's own profile doc.

## Owner identity (stable owner ids)

Owners are identified by a stable id, not by display-name strings, so a
rename propagates to every synced copy. All changes are additive: docs and
backups from before owner ids keep working.

- Profile: each user has a permanent `ownerId` (10-char nanoid), generated
  once in `services/profile.ts`, stored in localStorage `profile:v1` and
  carried in device backups (`oi`) so all of a user's devices share it.
- Owners directory: the inner doc has a `Y.Map('owners')` mapping
  `ownerId -> { name, updatedAt }` (current display name). Every device with
  write access (and the content key) upserts its user's entry on doc
  load/sync and whenever the profile name or per-doc alias changes.
- `ownerHistory` entries are `{ time, ownerId?, owner }`: new entries always
  carry `ownerId` plus the name at write time; legacy entries only have the
  string. Display resolution: `ownerId` -> directory current name -> stored
  `owner` string (`ownerDisplayName()` in `store/owners.ts`).
- Name matching: the first time a user appears in a doc, an existing
  directory entry with the same display name (case-insensitive) is adopted
  instead of duplicated — the adopted id is remembered per doc in the profile
  (`effectiveOwnerId(docId)`). Transfers to a name already in the directory
  reuse that entry's id; unknown names mint a fresh id and register it.
- Device presence entries (`devices` map) additionally carry the writer's
  `ownerId` when the user has a name.

## AI endpoint (server) — DEPRECATED

AI calls now run on-device (see `ai.ts` above): user keys must not transit or
live on the relay, and a VPS may egress from a region the Anthropic API
refuses (403 "Request not allowed"). The endpoint below still exists but is
unused by the client and returns 503 unless `ANTHROPIC_API_KEY` is set.

`POST /api/ai/analyze` — headers `x-token: <rwToken>`, JSON body
`{ docId, photos: [{ mime, dataBase64 }], context: { description?, mainCurrency? } }`.
1-3 photos, each <= 2 MB decoded. Auth: sha256(token) must equal the doc's rwHash.
Server requires env `ANTHROPIC_API_KEY` (503 `{ error: "ai-not-configured" }` when unset);
`ANTHROPIC_MODEL` optional (default `claude-sonnet-4-5`). Calls the Anthropic Messages API
with the images and a strict-JSON instruction, parses the reply (tolerating code fences),
responds `{ suggestions: AiSuggestions }`. In-memory rate limit: 5 requests/min per docId (429).

## Listing connector (Chrome extension, connector/)

The connector is a second CLIENT of the contracts above — the server knows
nothing about it and needs no changes for it.

- Onboarding: the user scans / uploads the profile QR or pastes the backup
  link (`#/restore/<payload>`, payload v2 above). The URL's origin doubles as
  the relay origin (`wss <origin>/sync`, `<origin>/api`). The `k` (AI key)
  field of a backup payload is deliberately dropped by the extension.
- Sync: per handle, a read-only Hocuspocus client of the OUTER doc — auth
  token JSON `{"t": "<roToken ?? rwToken>"}`, no create-handshake — that
  decrypts `enc:log` per "End-to-end encryption" and never appends to it.
  Materialized items are cached in `chrome.storage.local`; tokens and
  content keys also live only there (never `storage.sync`, never sent
  anywhere but the relay).
- Photos: `GET /api/blobs/:docId/:hash` with `x-token`, decrypted
  client-side; relies on the blob API's `Access-Control-Allow-Origin: *`
  (chrome-extension:// origins are cross-origin to the relay).
- The item projection stores whether a serial number exists, never the
  number itself.
- Listing payload v1 (app "Copy for extension" -> popup -> content scripts)
  is documented in connector/README.md; `app/src/ui/lib/listing.ts`,
  `connector/src/listing.ts` and `connector/chrome-extension/content/fill-core.js`
  must stay in sync.

## Deployment shape

Single VPS, Docker Compose (`deploy/`):
- `caddy` terminates TLS on 443, serves the built PWA static files, reverse-proxies
  `/sync` (websocket) and `/api/*` to the node service.
- `server` (node) runs Hocuspocus + blob API on internal port 8787.
- Volumes: `server/data` (docs + blobs), caddy data (certs).
