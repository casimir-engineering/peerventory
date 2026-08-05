/**
 * Device backup: identity + every inventory handle (including write tokens,
 * and the AI key if present) packed into one payload that travels as a link
 * or a QR code. Treat any backup like a password: whoever has it has full
 * access to everything on this device.
 *
 * Payload v2 = base64url(JSON): { v:2, n?:name, oi?:ownerId, a?:aliases,
 * c?:lastCurrency, k?:aiKey, p?:profileDoc, h:[{ d, rw?, ro?, ek?, nm? }] }
 * where `ek` is the per-inventory content encryption key of end-to-end
 * encrypted docs and `oi` is the stable owner id of this user (so a restored
 * device keeps the same owner identity). `p` = { d, rw?, ro?, ek } is the
 * handle of the SYNCED PROFILE DOC (see store/profileSync.ts): importing it
 * links the devices permanently — inventories created later flow through
 * profile sync instead of needing a fresh backup. v1 payloads (no keys) and
 * v2 payloads without `oi`/`p` are still accepted and import statically.
 *
 * TWO FLAVOURS of the same v2 payload:
 * - LINK TOKEN (encodeLinkToken): identity + `p` only, `h` empty. This is what
 *   the on-screen QR carries. Everything else reaches the other device
 *   through profile sync once it has joined, so there is no reason to push
 *   every token through a camera — and every reason not to: the full payload
 *   of a real profile needs QR version 29-37 (133-157 modules), which a phone
 *   camera cannot read off another phone's screen, and past ~11 inventories
 *   it does not fit in a QR code at all.
 * - FULL BACKUP (encodeBackup): every handle as well, for links, files and
 *   archives — paths with no density limit — and for restoring onto a device
 *   that will never reach the relay.
 * Both decode through decodeBackup; a link token is simply one with no
 * handles, which older builds already import correctly.
 */

import {
  adoptProfileHandle,
  getHandlesSnapshot,
  getStoredHandle,
  importHandles,
  profileRecordInventory,
  reopenEncryptedDoc,
  startProfileSync,
} from '../store';
import { getAiKey, setAiKey } from './aikey';
import {
  ensureProfileDocHandle,
  getLastCurrency,
  getProfileDocHandle,
  getOwnerAliases,
  getOwnerId,
  getStoredOwnerId,
  getUserName,
  ownerAliasFor,
  setLastCurrency,
  setOwnerAlias,
  setOwnerId,
  setUserName,
} from './profile';

export interface BackupHandle {
  docId: string;
  rwToken?: string;
  roToken?: string;
  /** Content encryption key of an end-to-end encrypted inventory. */
  key?: string;
  name?: string;
}

export interface DecodedBackup {
  name?: string;
  /** Stable owner id of the user this backup came from. */
  ownerId?: string;
  aliases?: Record<string, string>;
  lastCurrency?: string;
  aiKey?: string;
  /**
   * Handle of the exporting device's synced profile doc. Importing it links
   * this device into the same device group: the inventory list itself syncs
   * from then on. Absent in old backups (which import statically).
   */
  profile?: { docId: string; rwToken?: string; roToken?: string; key?: string };
  handles: BackupHandle[];
}

interface WirePayload {
  v: 1 | 2;
  n?: string;
  oi?: string;
  a?: Record<string, string>;
  c?: string;
  k?: string;
  p?: { d: string; rw?: string; ro?: string; ek?: string };
  h: Array<{ d: string; rw?: string; ro?: string; ek?: string; nm?: string }>;
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(payload: string): string | null {
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The profile-doc handle in wire form, when this device has a usable one. */
function profileWire(): WirePayload['p'] | undefined {
  const prof = ensureProfileDocHandle();
  if (!prof.key || (!prof.rwToken && !prof.roToken)) return undefined;
  return {
    d: prof.docId,
    ...(prof.rwToken ? { rw: prof.rwToken } : {}),
    ...(prof.roToken ? { ro: prof.roToken } : {}),
    ek: prof.key,
  };
}

/**
 * "Join my account" token: identity + the profile-doc handle, nothing else.
 * Small enough (~230 bytes, QR version 12) to be read off a phone screen by
 * another phone's camera, and complete enough that the joining device
 * receives every inventory through profile sync moments later.
 */
export function encodeLinkToken(): string {
  // `h: []` rather than a new payload version on purpose: builds that predate
  // the link token still decode this and still join the profile.
  const wire: WirePayload = { v: 2, h: [] };
  const name = getUserName();
  if (name) wire.n = name;
  wire.oi = getOwnerId();
  const p = profileWire();
  if (p) wire.p = p;
  return toBase64Url(JSON.stringify(wire));
}

/** Everything this device knows, as an opaque payload string. */
export function encodeBackup(): string {
  const wire: WirePayload = {
    v: 2,
    h: getHandlesSnapshot().map((h) => ({
      d: h.docId,
      ...(h.rwToken ? { rw: h.rwToken } : {}),
      ...(h.roToken ? { ro: h.roToken } : {}),
      ...(h.key ? { ek: h.key } : {}),
      ...(h.name ? { nm: h.name } : {}),
    })),
  };
  const name = getUserName();
  if (name) wire.n = name;
  wire.oi = getOwnerId();
  // The profile-doc handle makes this backup a permanent device link: the
  // importing device joins the synced inventory list instead of copying it.
  const prof = profileWire();
  if (prof) wire.p = prof;
  const aliases = getOwnerAliases();
  if (Object.keys(aliases).length > 0) wire.a = aliases;
  const currency = getLastCurrency();
  if (currency) wire.c = currency;
  const aiKey = getAiKey();
  if (aiKey) wire.k = aiKey;
  return toBase64Url(JSON.stringify(wire));
}

/** Extracts the payload from a restore URL, bare fragment, or raw payload. */
const RESTORE_RE = /\/restore\/([A-Za-z0-9_-]{8,})/;

export function parseBackupText(text: string): string | null {
  const match = RESTORE_RE.exec(text.trim());
  return match ? match[1] : null;
}

export function decodeBackup(payload: string): DecodedBackup | null {
  const json = fromBase64Url(payload);
  if (!json) return null;
  try {
    const wire = JSON.parse(json) as WirePayload;
    if (wire.v !== 1 && wire.v !== 2) return null;
    const handles = Array.isArray(wire.h) ? wire.h : [];
    // A payload with neither handles nor a profile handle carries nothing.
    if (handles.length === 0 && !wire.p) return null;
    return {
      name: typeof wire.n === 'string' ? wire.n : undefined,
      ownerId: typeof wire.oi === 'string' && wire.oi ? wire.oi : undefined,
      aliases: wire.a && typeof wire.a === 'object' ? wire.a : undefined,
      lastCurrency: typeof wire.c === 'string' ? wire.c : undefined,
      aiKey: typeof wire.k === 'string' ? wire.k : undefined,
      profile:
        wire.p && typeof wire.p === 'object' && typeof wire.p.d === 'string' && wire.p.d
          ? {
              docId: wire.p.d,
              rwToken: typeof wire.p.rw === 'string' ? wire.p.rw : undefined,
              roToken: typeof wire.p.ro === 'string' ? wire.p.ro : undefined,
              key: typeof wire.p.ek === 'string' ? wire.p.ek : undefined,
            }
          : undefined,
      handles: handles
        .filter((h) => typeof h?.d === 'string' && h.d)
        .map((h) => ({
          docId: h.d,
          rwToken: typeof h.rw === 'string' ? h.rw : undefined,
          roToken: typeof h.ro === 'string' ? h.ro : undefined,
          key: typeof h.ek === 'string' ? h.ek : undefined,
          name: typeof h.nm === 'string' ? h.nm : undefined,
        })),
    };
  } catch {
    return null;
  }
}

export interface ImportBackupResult {
  added: number;
  upgraded: number;
  unchanged: number;
  nameApplied: boolean;
  aiKeyApplied: boolean;
  /** This device joined (or switched to) the backup's synced profile. */
  profileLinked: boolean;
}

/**
 * How a payload relates to the account this device is already on. Drives the
 * restore screen: joining is a no-op, a top-up, or an account switch that
 * must be confirmed — never a silent surprise.
 */
export type BackupRelation =
  | 'same-account'
  | 'other-account'
  | 'no-account'
  | 'static';

export function backupRelation(backup: DecodedBackup): BackupRelation {
  if (!backup.profile) return 'static';
  const local = getProfileDocHandle();
  if (!local) return 'no-account';
  return local.docId === backup.profile.docId ? 'same-account' : 'other-account';
}

/** A "link a device" QR: identity + account handle, no inventory tokens. */
export function isLinkToken(backup: DecodedBackup): boolean {
  return backup.handles.length === 0 && Boolean(backup.profile);
}

/**
 * Merge a backup into this device. Existing local state wins: the local
 * name, aliases, currency and AI key are only filled when absent, and
 * handle merging never downgrades access (see importHandles).
 */
export function importBackup(backup: DecodedBackup): ImportBackupResult {
  // Identity first: docs (re)opened during the handle import below record
  // the user in the owners directory, which needs ownerId/name in place.
  if (backup.ownerId && !getStoredOwnerId()) setOwnerId(backup.ownerId);
  let nameApplied = false;
  if (backup.name && !getUserName()) {
    setUserName(backup.name);
    nameApplied = true;
  }
  if (backup.aliases) {
    for (const [docId, owner] of Object.entries(backup.aliases)) {
      if (typeof owner === 'string' && owner && !ownerAliasFor(docId)) {
        setOwnerAlias(docId, owner);
      }
    }
  }

  // Docs already known here WITHOUT a key that gain one from this backup must
  // be wiped and re-synced: whatever they stored locally is ciphertext.
  const gainedKey = backup.handles
    .filter((h) => {
      const existing = getStoredHandle(h.docId);
      return Boolean(h.key) && existing !== null && !existing.key;
    })
    .map((h) => h.docId);

  const counts = importHandles(backup.handles);

  for (const docId of gainedKey) {
    void reopenEncryptedDoc(docId);
  }

  // Join the exporter's synced profile (device group) when the payload
  // carries one; otherwise the static import above is merged into THIS
  // device's own profile doc by the sync engine. Explicitly recording each
  // imported handle also revives profile-doc tombstones: importing a backup
  // deliberately brings its inventories back.
  let profileLinked = false;
  if (backup.profile) profileLinked = adoptProfileHandle(backup.profile);
  startProfileSync();
  for (const h of backup.handles) profileRecordInventory(h.docId);

  if (backup.lastCurrency && !getLastCurrency()) setLastCurrency(backup.lastCurrency);

  let aiKeyApplied = false;
  if (backup.aiKey && !getAiKey()) {
    setAiKey(backup.aiKey);
    aiKeyApplied = true;
  }

  return { ...counts, nameApplied, aiKeyApplied, profileLinked };
}
