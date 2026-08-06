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

## Multi-relay replication

Relays are interchangeable dumb encrypted mailboxes. Nothing in the protocol
assumes a single global server, and relays never talk to each other —
replication happens through clients.

- Tokens and the content key are RELAY-AGNOSTIC by design: a token is just a
  per-doc access password whose sha256 hash a relay stores at doc-creation
  time, and the relay only ever guards ciphertext. The same `{rwToken,
  roToken, key}` triple is therefore valid on every relay the doc is pushed
  to; there is no per-relay credential.
- Registration on an additional relay reuses the create-handshake above: a
  client whose rw token is server-confirmed (or still pending creation)
  ALWAYS sends the `create: {rwHash, roHash}` payload. A relay that already
  knows the doc ignores it; a relay that does not stores the hashes and
  grants rw. "Replicate to relay B" is thus simply "connect to relay B" —
  the client's Hocuspocus provider then pushes the full encrypted state.
  (Replication requires holding BOTH tokens: the ro hash must be registered
  along with the rw hash. Read-only holders cannot introduce a doc to a new
  relay.)
- Client relay set (`app/src/store/relays.ts`): each device keeps a list of
  relay origins (localStorage `relays:v1`, `{url, enabled}`), seeded with the
  configured default. Each `InventoryHandle` carries `relays: string[]` — the
  origins the doc is known to live on. A share link's origin is *a* relay
  hint recorded at join time, not "the" server.
- ACCOUNT relay list (`store/accountRelays.ts` + profileSync): the relay set
  is account-level state, synced through the profile doc's `Y.Map('relays')`
  (`origin -> { u, at, removed? }`). Adding a relay on any device adds it on
  all of the account's devices; removing writes a `removed: true` tombstone
  so other devices drop it without resurrection (an explicit re-add revives
  a tombstone). Existing local lists union into the doc on first sync
  (migration). Two things stay PER-DEVICE: the enable/disable override and
  health display (reachability differs per device — a LAN relay may be
  phone-only), and each device's own configured default origin, which is
  pinned and survives an account-level removal.
- Replication policy (`store/replication.ts`): inventories OWNED by the
  account replicate automatically to every relay enabled on the device
  (doc registration via the create-handshake + photo upload queueing),
  re-checked whenever the relay set or the registry changes. Ownership =
  `owned: true` stamped on the handle at creation and propagated through the
  profile doc (`ow`); pre-flag inventories fall back to a capability test
  (both tokens + server-confirmed or pending-create write access — exactly
  what registering on a new relay requires anyway). Joined/shared
  inventories NEVER auto-replicate: pushing someone else's inventory to new
  relays is explicit, via the per-inventory "Replicate to all my relays"
  button (hidden for owned inventories, where it is automatic) or the
  one-time prompt offered right after adding a relay.
- Connection layer (`docs.ts`): every open doc runs ONE HocuspocusProvider
  PER configured relay on the same outer Y.Doc — Yjs updates dedupe by
  design, so multi-homing is safe and keeps all relays converged while at
  least one shared client is online. Doc status aggregates per-relay states
  (synced anywhere = synced). Read-only/downgrade verdicts from one relay are
  ignored while another relay grants rw (relays share token hashes by
  construction; disagreement means a stale or hostile relay).
- Blobs: uploads go to EVERY relay of the doc (the upload queue tracks
  per-origin completion); downloads try the relays in order and take the
  first hit.
- The profile doc (see "Synced profile") always connects to every enabled
  relay and always sends the create payload (its tokens are minted locally,
  so self-registration is always safe). Inventory entries in the profile doc
  carry `rl: string[]` (union-merged, add-only), so relay hints propagate
  across a user's devices.

## Relay data lifecycle (lease GC + explicit delete)

A relay must be nothing but an interchangeable, disposable mailbox — so it
must also be able to EMPTY itself. It is blind (ciphertext only) and cannot
see tombstones or "this inventory was forgotten"; deletion therefore works
two ways:

- LEASE GC (server, automatic): every authenticated access renews a per-doc
  lease — a successful sync authentication (`onAuthenticate`) and any
  authorized blob GET/PUT/HEAD stamp `doc_meta.last_access_at`. Writes are
  throttled to once per day per doc (a conditional UPDATE; retention is
  measured in months, day-granularity is plenty). A daily sweep deletes every
  doc whose lease is older than the retention window: its Yjs state
  (`documents` row), its token record (`doc_meta`, cascading `blob_refs`) and
  its blob files — except files still referenced by another doc (blobs are
  content-addressed and globally deduped). Retention comes from env
  `RETENTION_DAYS` (default 180; `0` disables GC entirely). Docs from before
  the lease column (NULL `last_access_at`) are stamped "now" by the first
  sweep instead of being deleted — a fresh deploy never mass-deletes. The
  sweep logs COUNTS only, never doc ids. Consequence for clients: a relay
  holds data only for docs some device still syncs; if all peers forget a doc
  (or die), the relay forgets it too after the window.
- EXPLICIT DELETE (server): `DELETE /api/docs/:docId` with header
  `x-token: <rwToken>`. 401 without a token; 403 when the doc exists and the
  token is not its rw token; 204 on success AND for unknown docs, so the call
  is idempotent (a retry after a success, whose token record is already gone,
  is still 204). Deletes the same three things as the sweep, immediately, and
  closes the doc's live sync connections first. A debounced Hocuspocus store
  racing the delete can at most leave an orphan `documents` row with no token
  record — unusable (nothing authenticates against a doc without meta) and
  removed by the next sweep.
- APP FLOW: the forget-inventory confirmation offers "Also delete from my
  relays" for inventories the account OWNS (`owned` flag; needs the rw
  token) — default ON, hidden for joined/shared inventories. After local
  removal the app fires the DELETE on every relay recorded on the handle,
  best-effort in parallel (`store/remoteDelete.ts`): failures (offline
  relays) are surfaced in a toast and otherwise left to that relay's lease
  GC. "Leave account on this device" NEVER deletes relay data — other
  devices depend on it; only the explicit forget-with-checkbox does.
  Re-registration after deletion stays possible by design: a client holding
  BOTH tokens can re-create the doc via the create-handshake (same as
  introducing it to a brand-new relay).

## Direct device-to-device sync (WebRTC)

Devices holding the same inventory sync directly (LAN or NAT-permitting)
via y-webrtc on the OUTER (encrypted) doc — the exact bytes a relay would
see, decrypted through the same e2ee pipeline. Zero reachable relays still
sync if the P2P link is already established; see the limitation below.

- Signaling NEVER uses public y-webrtc servers (that is why P2P was removed
  once before). Each relay exposes a `/signal` WebSocket endpoint
  (`server/src/signaling.ts`) speaking y-webrtc's pub/sub protocol
  (`subscribe`/`unsubscribe`/`publish`/`ping` JSON messages on topic names).
- Signaling redundancy: a doc's room announces on `wss://<relay>/signal` of
  EVERY enabled relay of the device PLUS every relay on the doc's handle
  (`p2pSignalingOrigins`) — one socket per relay, announces on all, so two
  peers meet as long as they share ANY reachable relay (verified by
  `server npm run e2e:signal`). The lib0 websocket client reconnects forever
  with backoff and re-subscribes on connect, so a relay coming back is
  re-used automatically; when the origin set itself changes (relay
  added/removed, gossiped hints), the provider is restarted with the new
  URL list.
- Room privacy: the room name is
  `base64url(HMAC-SHA256(contentKey, "peerventory:webrtc-room:" + docId))` —
  unguessable without the E2E content key — and y-webrtc's room password
  (`base64url(HMAC-SHA256(contentKey, "peerventory:webrtc-pw:" + docId))`)
  additionally AES-GCM-encrypts all signaling payloads. The signaling server
  learns only: opaque room ids, peer IPs, timing, and encrypted SDP blobs.
  Strangers on the signaling server can neither discover nor join a doc's
  room; devices without the content key (including token-only relays-of-
  convenience) cannot participate.
- ICE: simple-peer defaults (public STUN for NAT traversal; STUN servers see
  IPs only, never data). On a shared LAN, host candidates suffice.
- Toggle: "Direct device-to-device sync", localStorage `p2p:v1`, default ON.
  UI shows the live direct-peer count per inventory. The profile doc runs a
  P2P room of its own, so account devices sharing no inventory still gossip.
- Discovery limitation, much narrower than before: two devices that share no
  reachable relay, no common already-connected peer (gossip below) and are
  not on the same LAN (Android, below) cannot be introduced. Once ANY
  introduction path exists, coordinates spread (gossiped relay hints) and
  established data channels keep syncing with zero relays.

### Peer gossip & introduction (gossip.ts)

Connected peers help each other stay connected. The protocol rides
y-webrtc's AWARENESS states — awareness floods transitively through every
connected peer of a room (each peer re-broadcasts applied updates), giving a
store-and-forward channel with zero y-webrtc changes. Two local state
fields, adapted onto each room by p2p.ts:

- `pv` — the peer's card: `{ v: 1, pid (room peer id), dev (device id),
  plat?, rl? (relay origins it syncs this doc through) }`. Receivers union
  `rl` into the doc handle's relay list (cross-pollination between accounts
  sharing an inventory, even when no relay/profile doc is reachable — capped
  at 12 origins) and feed `dev`/`plat` into the account-wide "reachable via
  P2P" presence.
- `pvi` — an outbox of INTRODUCTION envelopes: `{ t (target pid), f (sender
  pid), s (session nonce), i (sequence), tk? (glare token), ts?, sg (the
  simple-peer offer/answer/ICE payload) }`. Because awareness floods, A's
  envelope for C travels through B when A↔B and B↔C are connected but A and
  C share no relay — one-hop introduction forwarding without B doing
  anything but being connected. Receivers dedupe per `(f, s)` stream by
  sequence; senders prune the outbox on connection success or after 45 s.
- Driver: peers visible in awareness but not directly connected get an
  introduction attempt after a 4 s grace period (the relay path gets first
  try); the DETERMINISTIC initiator is the smaller room peer id (so exactly
  one side offers; simultaneous-offer glare is resolved with y-webrtc's own
  glare tokens); up to 3 attempts, 20 s apart, half-open connections reset
  between attempts.
- Privacy: awareness rides the room's data channels/BroadcastChannel, which
  require the doc key to join — relay origins and SDP are not secrets
  *within* a room, and nothing here touches a signaling server. Protocol is
  unit-tested under node (`app npm run test:store`).

### LAN discovery (Android ↔ Android, zero infrastructure)

Two Android devices on the same network find each other with no relay and
no internet (`store/lan.ts` + the `LanDiscovery` Capacitor plugin in
`app/android`):

- Each device advertises an mDNS/NSD service `_peerventory._tcp` whose TXT
  record carries its deviceId, and runs a tiny embedded WebSocket server
  (random port) that is a direct port of `server/src/signaling.ts` — it only
  ferries opaque topic subscriptions and encrypted publishes.
- Discovered peers' endpoints (`ws://<lan-ip>:<port>`) each get a standalone
  y-webrtc `SignalingConn`. y-webrtc keeps a module-global room registry, so
  a standalone connection transparently serves EVERY open doc room:
  subscribe + announce on connect, and rooms opened later (or still
  peer-less) are (re-)announced by lan.ts every 20 s. From the announce on,
  it is the normal y-webrtc flow — same HMAC room names, same room-password
  encryption of SDP: a stranger's phone on the LAN learns only opaque room
  ids and ciphertext.
- Native surface (kept minimal): `start({deviceId}) -> {port}`, `stop()`,
  `peersChanged` event with `{deviceId, host, port}[]`. NSD needs no runtime
  permission; the manifest adds `ACCESS_WIFI_STATE` +
  `CHANGE_WIFI_MULTICAST_STATE` for the multicast lock that keeps mDNS
  reliable, plus `usesCleartextTraffic` / `allowMixedContent` because
  link-local `ws://` cannot carry TLS (payloads are E2E-protected anyway).
- Web/desktop cannot do mDNS: LAN discovery is Android↔Android. A desktop
  still reaches phones through any shared relay — or through gossip once
  any path exists (e.g. phone A introduces desktop↔phone B).
- Follows the P2P toggle; web builds and non-Android platforms no-op.

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
  carries `oi` (the user's stable owner id, see "Owner identity"), `p`
  (the synced-profile doc handle, see "Synced profile") and `rl` (the
  exporting device's enabled relay origins, capped at 4). `rl` makes the
  payload RELAY-INDEPENDENT: the importer adds those relays to its set and
  fetches the profile doc from whichever answers — the URL that wrapped the
  QR is browser-open convenience plus one more hint, never "the" server.
  v1 payloads (no keys) and payloads without `oi`/`p`/`rl` are still
  accepted on restore (the wrapper origin stays the only hint, as before).
- Two flavours of that same v2 payload share the `#/restore/<payload>` route:
  - DEVICE LINK TOKEN (`encodeLinkToken`, `h: []`): identity + `p` + `rl`,
    ~250-350 bytes of payload / ~280-380 bytes of URL = QR version 12-15
    (~330 B payload with three listed relays). This is what the app renders
    on screen. Everything else reaches the joining device through
    profile-doc sync.
  - FULL BACKUP (`encodeBackup`): every handle as well. A five-inventory
    profile is ~1.2 kB of URL = QR version 29 (133x133 modules), which a
    camera cannot read off another phone's screen, and past ~11 inventories
    it exceeds the QR byte limit entirely. It therefore travels as a LINK or
    a saved PNG (decoded from clean pixels), never as an on-screen QR.
  Decoders accept both: a link token is a payload with no handles. A payload
  with neither handles nor `p` is rejected.
- FULL ACCOUNT BACKUP (`.zip`, `app/src/export/account.ts`): access AND data,
  for restoring with no relay in reach. Layout:

  ```
  account.json                          { schema: 'peerventory-account', version: 1,
                                          exportedAt, name?, ownerId?, backup: <v2 payload>,
                                          relays: [...], inventories: [{ docId, name, folder,
                                          items, photos }] }
  README.txt
  inventories/<docId>/inventory.yaml    same document as a single-inventory export
  inventories/<docId>/photos/<hash>.<ext>
  inventories/<docId>/photo-index.yaml
  ```

  Restore = `importBackup(decodeBackup(account.backup))` (identical merge
  semantics to the QR/link, including the "switch account?" confirmation)
  followed by writing each inventory's contents back into its own docId.
  Contents are only written into a doc that is EMPTY on this device: replaying
  an archived snapshot over a live doc would resurrect deleted items. Photo
  hashes are reproducible for a given content key, so re-adding archived blobs
  recreates the same refs instead of duplicates.

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
- Every authorized blob request renews the doc's GC lease (see "Relay data
  lifecycle").
- `DELETE /api/docs/:docId` — header `x-token: <rwToken>`; removes the doc,
  its token record and its blobs immediately (idempotent 204, see "Relay
  data lifecycle").

## Share links (client-side routing, hash router)

- Inventory: `https://<host>/#/join/<docId>/<token>/k/<base64urlKey>` — token
  may be rw or ro; the content key always directly follows the token; joining
  flow stores a handle then redirects to `#/inv/<docId>`. Links without `/k/`
  still parse and join, but content stays unreadable ("Encryption key
  missing") until the key arrives.
- Item: `https://<host>/#/join/<docId>/<token>/k/<key>/i/<itemId>`
- Item list: `https://<host>/#/join/<docId>/<token>/k/<key>/l/<id1>.<id2>.<id3>` (dot-joined item IDs; UI offers "save as list" for long selections, which shares `#/join/<docId>/<token>/k/<key>/sl/<listId>` instead).
- RELAY HINTS (`?r=`): new links append the doc's OTHER relays as a query
  string INSIDE the fragment — `...#/join/.../k/<key>[/i/...]?r=<o1>,<o2>`
  (max 3, wrapper origin excluded; `https://` prefixes dropped when they
  round-trip, LAN/`http://` origins verbatim; ~20-30 bytes per origin, a
  typical link stays ≈150 B / QR version 8). The joiner records the wrapper
  origin AND every `?r=` origin as relay hints on the handle, so the link
  keeps working when the wrapper relay is gone. Backward and forward
  compatible by construction: old builds' hash router matches the same route
  and ignores the query; links without `?r=` parse as before.
- Already-joined shortcuts (no token): `#/inv/<docId>`, `#/inv/<docId>/i/<itemId>`, `#/inv/<docId>/l/...`, `#/inv/<docId>/sl/<listId>`.

## Client server-config

`app/src/config.ts` exports `getServerConfig(): { wsUrl: string; httpUrl: string }`.
Defaults derive from localStorage `serverOrigin` (runtime override, used by the
APK), then `import.meta.env.VITE_SERVER_ORIGIN` (e.g. `https://inv.example.com`),
falling back to `window.location.origin`. `wsUrl = origin.replace(/^http/, 'ws') + '/sync'`,
`httpUrl = origin + '/api'`.

This configured origin is only the DEFAULT relay that seeds the device relay
set (see "Multi-relay replication"); all live connections resolve through
`store/relays.ts`, never through a single global origin.

## Client services (app/src/services/) — v2 features

All services degrade silently offline; the app never blocks on them.

- `currency.ts`: `ensureRates(): Promise<void>` (fetch https://open.er-api.com/v6/latest/USD once per 24h, cache in localStorage `fx:v1`, keep stale cache offline); `convert(amount: number, from: string, to: string): number | null`; `knownCurrencies(): string[]`; `ratesAgeMs(): number | null`.
- `units.ts`: `parseWeightToGrams(input: string): number | null` (accepts `200`, `200g`, `0.2 kg`, `1.5kg`, `2 lb`, `3oz`, comma decimals; bare number = grams); `formatGrams(g: number): string` (< 1000 -> `850 g`, else `1.5 kg`); `parseLengthToMm(input: string): number | null` (mm/cm/m/in; bare number = mm); `formatMm(mm: number): string` (mm < 100, cm < 1000, else m); `weightGramsOfItem(item): { grams: number; estimated: boolean }` (exactGrams or class midpoint, gt20kg -> minG); `volumeM3OfItem(item): { m3: number; estimated: boolean }` (exact L*W*H else SIZE_CLASSES approxLiters; per single unit, caller multiplies by quantity).
- `stats.ts`: the one place that turns per-unit item figures into totals. An item sheet describes a SINGLE object, so every aggregate multiplies by the item's quantity. `unitCount(item): number` (quantity normalized: missing/0/negative/NaN -> 1, fractions rounded); `itemWeightGrams(item) / itemVolumeM3(item)` (the per-unit `units.ts` figures × `unitCount`, keeping the `estimated` flag); `itemValueTotal(item, field = 'valueCurrent'): MoneyValue | null` (line total, unpriced -> null); `summarizeValue(items, field, mainCurrency): ValueSummary` (line totals converted where a rate exists, the rest grouped per currency); `summarizeItems(items, mainCurrency): ItemsSummary` (`itemCount` = sheets, `unitCount` = physical units, weight/volume/value totals). Item counts and unit counts stay distinct in the UI: a count is a count of sheets, and the unit count is shown next to it when the two differ. Covered by `npm run check:stats`.
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
  - `Y.Map('inventories')`: `docId -> { d, rw?, ro?, ek?, nm?, rl?, ow?,
    removed?, at }` — one plain-object entry per inventory keyed by docId, so
    concurrent list edits merge per inventory (LWW per entry). `rl` is the
    inventory's relay-origin list (union-merged on push, add-only — see
    "Multi-relay replication"); `ow` marks account ownership (fill-only,
    drives auto-replication). The AI key is NEVER stored here.
  - `Y.Map('relays')`: the account relay list, `origin -> { u, at,
    removed? }` — see "Multi-relay replication" for the merge semantics
    (tombstones, per-device enable override, pinned default).
  - `Y.Map('devices')`: `deviceId -> { id, label ("Alex · Android"), at }` —
    each writing device records itself (throttled to every 5 min). The
    Account & sync page lists these with last-seen time and marks the ones
    currently reachable over any live P2P data channel (gossip presence).
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
- Joining semantics shown to the user (`RestorePage`): same profile docId =
  "already linked", no-op; no local profile = plain join; DIFFERENT profile
  docId = an explicit account switch that must be confirmed, described
  honestly as a MERGE, because that is what the push above does — the local
  inventories land in the joined account and appear on its devices. The old
  account is simply forgotten by this device; nothing is tombstoned there.
- Unlink (`unlinkDevice`, store/hooks.ts): leave the account and become a
  fresh install. Stops the engine and clears the profile doc's local data,
  then per inventory `closeDoc({clearData:true})` + clear upload queue +
  `removeHandle`, then every `blob:`/`uploadq:` key, then
  `resetProfileIdentity()` (drops `profileDoc`, per-doc aliases and owner
  links; KEEPS `userName` and `ownerId` — same person, unlinked device) and
  starts a brand new empty profile doc. Deliberately writes NO tombstones:
  the other devices of the account keep everything.

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

- Onboarding: the user pastes the FULL BACKUP link or uploads/scans its saved
  QR image (`#/restore/<payload>`, payload v2 above). The extension does not
  join the profile doc, so it needs the handles in the payload: the app's
  on-screen DEVICE LINK QR is rejected with a message pointing at "Copy full
  backup link". The URL's origin doubles as the relay origin
  (`wss <origin>/sync`, `<origin>/api`). The `k` (AI key) field of a backup
  payload is deliberately dropped by the extension.
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
  `/sync` and `/signal` (websockets) and `/api/*` to the node service.
- `server` (node) runs Hocuspocus + blob API + WebRTC signaling on internal port 8787.
- Volumes: `server/data` (docs + blobs), caddy data (certs).

Anyone can run additional relays the same way (each is fully independent and
knows nothing about the others); see README "Self-hosting a relay".
