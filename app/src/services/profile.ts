/**
 * Local user profile + generic recent-input history. Plain localStorage JSON,
 * versioned keys; every read tolerates missing/corrupt data.
 */

import type { Id } from '../types';
import { newId, newToken } from '../store/ids';
import { generateContentKey } from '../store/crypto';

const PROFILE_KEY = 'profile:v1';
const INPUTS_KEY = 'inputs:v1';
const INPUTS_CAP = 20;

/**
 * Identity of the synced profile doc (the "device group" doc, see
 * store/profileSync.ts and CONTRACTS.md "Synced profile"). Same shape of
 * secrets as an inventory handle: relay tokens + E2E content key.
 */
export interface ProfileDocHandle {
  docId: string;
  rwToken?: string;
  roToken?: string;
  /** E2E content key (base64url, 32 bytes); never reaches the server. */
  key?: string;
  /** True until the relay accepts the create handshake for this doc. */
  pendingCreate?: boolean;
}

interface Profile {
  userName?: string;
  /**
   * Stable owner identity of this user, generated once and shared by all of
   * their devices via backup restore. Keys the per-doc owners directory.
   */
  ownerId?: string;
  ownerAliases?: Record<string, string>;
  /**
   * docId -> ownerId adopted in that doc instead of the profile ownerId
   * ("match my name to an existing owner": joining a doc that already tracks
   * you under another id links to it rather than duplicating the owner).
   */
  ownerIdLinks?: Record<string, string>;
  lastCurrency?: string;
  /** Handle of this user's synced profile doc (lazily created / adopted). */
  profileDoc?: ProfileDocHandle;
}

/**
 * Fired when this user's effective owner name or identity may have changed
 * (setUserName, setOwnerAlias, setLinkedOwnerId). docId is set for doc-scoped
 * changes, undefined for global ones. The store subscribes to push the new
 * name into the owners directory of every writable open doc.
 */
type OwnerNameListener = (docId?: Id) => void;
const ownerNameListeners = new Set<OwnerNameListener>();

export function subscribeOwnerName(cb: OwnerNameListener): () => void {
  ownerNameListeners.add(cb);
  return () => ownerNameListeners.delete(cb);
}

function notifyOwnerName(docId?: Id): void {
  for (const cb of ownerNameListeners) cb(docId);
}

function readProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Profile;
  } catch {
    // corrupt -> start fresh
  }
  return {};
}

function writeProfile(patch: Partial<Profile>): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...readProfile(), ...patch }));
  } catch {
    // storage unavailable: profile is best-effort
  }
}

export function getUserName(): string | null {
  const name = readProfile().userName;
  return typeof name === 'string' && name.trim() ? name : null;
}

export function setUserName(name: string): void {
  writeProfile({ userName: name.trim() });
  notifyOwnerName();
}

/** Stored owner id without generating one (backup code needs to probe). */
export function getStoredOwnerId(): string | null {
  const id = readProfile().ownerId;
  return typeof id === 'string' && id ? id : null;
}

/** Stable owner id of this user; generated once, then permanent. */
export function getOwnerId(): string {
  const existing = getStoredOwnerId();
  if (existing) return existing;
  const id = newId();
  writeProfile({ ownerId: id });
  return id;
}

/** Adopt an owner id (backup restore on a fresh device). Never overwrites. */
export function setOwnerId(id: string): void {
  if (!getStoredOwnerId() && id) writeProfile({ ownerId: id });
}

/** Stored profile-doc handle, or null when none was created/adopted yet. */
export function getProfileDocHandle(): ProfileDocHandle | null {
  const h = readProfile().profileDoc;
  if (h && typeof h === 'object' && typeof h.docId === 'string' && h.docId) return h;
  return null;
}

/** Get-or-create the profile-doc identity (docId + tokens + content key). */
export function ensureProfileDocHandle(): ProfileDocHandle {
  const existing = getProfileDocHandle();
  if (existing) return existing;
  const handle: ProfileDocHandle = {
    docId: newId(),
    rwToken: newToken(),
    roToken: newToken(),
    key: generateContentKey(),
    pendingCreate: true,
  };
  writeProfile({ profileDoc: handle });
  return handle;
}

/** Replace the profile-doc handle (adopting a profile from a backup). */
export function setProfileDocHandle(handle: ProfileDocHandle): void {
  writeProfile({ profileDoc: handle });
}

export function updateProfileDocHandle(patch: Partial<ProfileDocHandle>): void {
  const current = getProfileDocHandle();
  if (!current) return;
  writeProfile({ profileDoc: { ...current, ...patch } });
}

/**
 * Forget the profile-doc identity (unlink flow). The next
 * ensureProfileDocHandle() mints a brand new, empty account. The user's name
 * and ownerId are deliberately untouched: they are still the same person.
 * Per-doc aliases and owner links go, because their docs go with them.
 */
export function resetProfileIdentity(): void {
  const { userName, ownerId, lastCurrency } = readProfile();
  try {
    localStorage.setItem(
      PROFILE_KEY,
      JSON.stringify({
        ...(userName ? { userName } : {}),
        ...(ownerId ? { ownerId } : {}),
        ...(lastCurrency ? { lastCurrency } : {}),
      } satisfies Profile),
    );
  } catch {
    // storage unavailable: profile is best-effort
  }
  notifyOwnerName();
}

export function linkedOwnerIdFor(docId: Id): string | null {
  const links = readProfile().ownerIdLinks;
  const id = links && typeof links === 'object' ? links[docId] : undefined;
  return typeof id === 'string' && id ? id : null;
}

/** Link this user to an existing owner id inside one doc (null unlinks). */
export function setLinkedOwnerId(docId: Id, ownerId: string | null): void {
  const links = { ...(readProfile().ownerIdLinks ?? {}) };
  if (ownerId) links[docId] = ownerId;
  else delete links[docId];
  writeProfile({ ownerIdLinks: links });
  notifyOwnerName(docId);
}

/** Owner id this user goes by inside one doc: linked id if any, else global. */
export function effectiveOwnerId(docId: Id): string {
  return linkedOwnerIdFor(docId) ?? getOwnerId();
}

export function getOwnerAliases(): Record<string, string> {
  const aliases = readProfile().ownerAliases;
  return aliases && typeof aliases === 'object' ? { ...aliases } : {};
}

export function ownerAliasFor(docId: Id): string | null {
  const aliases = readProfile().ownerAliases;
  const alias = aliases && typeof aliases === 'object' ? aliases[docId] : undefined;
  return typeof alias === 'string' && alias.trim() ? alias : null;
}

export function setOwnerAlias(docId: Id, name: string): void {
  const aliases = { ...(readProfile().ownerAliases ?? {}) };
  const trimmed = name.trim();
  if (trimmed) aliases[docId] = trimmed;
  else delete aliases[docId];
  writeProfile({ ownerAliases: aliases });
  notifyOwnerName(docId);
}

/** Per-doc alias if set, else the global user name. */
export function effectiveOwnerName(docId: Id): string | null {
  return ownerAliasFor(docId) ?? getUserName();
}

function readInputs(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(INPUTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.filter((s): s is string => typeof s === 'string');
      }
      return out;
    }
  } catch {
    // corrupt -> start fresh
  }
  return {};
}

/** Push a value to a key's history (most recent first, deduped, cap 20). */
export function rememberInput(key: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  const inputs = readInputs();
  inputs[key] = [v, ...(inputs[key] ?? []).filter((s) => s !== v)].slice(0, INPUTS_CAP);
  try {
    localStorage.setItem(INPUTS_KEY, JSON.stringify(inputs));
  } catch {
    // best-effort
  }
}

export function suggestInputs(key: string): string[] {
  return readInputs()[key] ?? [];
}

export function getLastCurrency(): string | null {
  const code = readProfile().lastCurrency;
  return typeof code === 'string' && code ? code : null;
}

export function setLastCurrency(code: string): void {
  writeProfile({ lastCurrency: code.toUpperCase() });
}
