/**
 * Device backup: identity + every inventory handle (including write tokens,
 * and the AI key if present) packed into one payload that travels as a link
 * or a QR code. Treat any backup like a password: whoever has it has full
 * access to everything on this device.
 *
 * Payload v2 = base64url(JSON): { v:2, n?:name, a?:aliases, c?:lastCurrency,
 * k?:aiKey, h:[{ d, rw?, ro?, ek?, nm? }] } where `ek` is the per-inventory
 * content encryption key of end-to-end encrypted docs. v1 payloads (no keys)
 * are still accepted.
 */

import { getHandlesSnapshot, getStoredHandle, importHandles, reopenEncryptedDoc } from '../store';
import { getAiKey, setAiKey } from './aikey';
import {
  getLastCurrency,
  getOwnerAliases,
  getUserName,
  ownerAliasFor,
  setLastCurrency,
  setOwnerAlias,
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
  aliases?: Record<string, string>;
  lastCurrency?: string;
  aiKey?: string;
  handles: BackupHandle[];
}

interface WirePayload {
  v: 1 | 2;
  n?: string;
  a?: Record<string, string>;
  c?: string;
  k?: string;
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
    if ((wire.v !== 1 && wire.v !== 2) || !Array.isArray(wire.h)) return null;
    return {
      name: typeof wire.n === 'string' ? wire.n : undefined,
      aliases: wire.a && typeof wire.a === 'object' ? wire.a : undefined,
      lastCurrency: typeof wire.c === 'string' ? wire.c : undefined,
      aiKey: typeof wire.k === 'string' ? wire.k : undefined,
      handles: wire.h
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
}

/**
 * Merge a backup into this device. Existing local state wins: the local
 * name, aliases, currency and AI key are only filled when absent, and
 * handle merging never downgrades access (see importHandles).
 */
export function importBackup(backup: DecodedBackup): ImportBackupResult {
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
  if (backup.lastCurrency && !getLastCurrency()) setLastCurrency(backup.lastCurrency);

  let aiKeyApplied = false;
  if (backup.aiKey && !getAiKey()) {
    setAiKey(backup.aiKey);
    aiKeyApplied = true;
  }

  return { ...counts, nameApplied, aiKeyApplied };
}
