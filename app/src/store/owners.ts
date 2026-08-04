/**
 * Per-doc owners directory: Y.Map 'owners' on the inner doc, mapping a stable
 * ownerId -> { name, updatedAt }. Owner history entries reference ownerIds,
 * so renaming a user updates their name on every synced copy; entries that
 * predate owner ids fall back to their stored display string.
 *
 * Imports from services/profile directly (not the services barrel) — profile
 * has no store imports, so this stays cycle-free (same pattern as device.ts).
 */
import * as Y from 'yjs';
import type { Id, OwnerDirectoryEntry, OwnerEntry } from '../types';
import {
  effectiveOwnerId,
  effectiveOwnerName,
  setLinkedOwnerId,
} from '../services/profile';
import { newId } from './ids';

export const OWNERS_KEY = 'owners';

function ownersMap(doc: Y.Doc): Y.Map<OwnerDirectoryEntry> {
  return doc.getMap<OwnerDirectoryEntry>(OWNERS_KEY);
}

function normName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** Plain-object copy of the owners directory (invalid entries dropped). */
export function readOwners(doc: Y.Doc): Record<Id, OwnerDirectoryEntry> {
  const out: Record<Id, OwnerDirectoryEntry> = {};
  ownersMap(doc).forEach((value, key) => {
    const e = value as { name?: unknown; updatedAt?: unknown };
    if (typeof e?.name === 'string' && e.name.trim()) {
      out[key] = {
        name: e.name,
        updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
      };
    }
  });
  return out;
}

export function findOwnerIdByName(doc: Y.Doc, name: string): Id | null {
  const target = normName(name);
  if (!target) return null;
  let found: Id | null = null;
  ownersMap(doc).forEach((value, key) => {
    if (found) return;
    const n = (value as { name?: unknown })?.name;
    if (typeof n === 'string' && normName(n) === target) found = key;
  });
  return found;
}

/** Write a directory entry; no-op when the stored name already matches. */
export function upsertOwner(doc: Y.Doc, ownerId: Id, name: string): void {
  const owners = ownersMap(doc);
  const prev = owners.get(ownerId) as { name?: unknown } | undefined;
  if (prev?.name === name) return;
  owners.set(ownerId, { name, updatedAt: Date.now() });
}

/**
 * Ensure this user's own directory entry carries their current effective
 * name. The FIRST time this user shows up in a doc, an existing entry with
 * the same display name is adopted (linked) instead of duplicated — that is
 * the "match my name to an existing owner" join flow. Caller must hold
 * write access; no-op without a profile name.
 */
export function ensureSelfOwner(doc: Y.Doc, docId: Id): void {
  const name = effectiveOwnerName(docId);
  if (!name) return;
  let myId = effectiveOwnerId(docId);
  if (!ownersMap(doc).has(myId)) {
    const existing = findOwnerIdByName(doc, name);
    if (existing && existing !== myId) {
      setLinkedOwnerId(docId, existing);
      myId = existing;
    }
  }
  upsertOwner(doc, myId, name);
}

/**
 * Owner id for a display name this user typed (item create / transfer flow):
 * the user's own name maps to their own id, a name already in the directory
 * maps to that entry's id, anything else mints a fresh id and registers it.
 */
export function resolveOwnerIdForName(doc: Y.Doc, docId: Id, name: string): Id {
  const trimmed = name.trim();
  const selfName = effectiveOwnerName(docId);
  if (selfName && normName(selfName) === normName(trimmed)) {
    ensureSelfOwner(doc, docId);
    return effectiveOwnerId(docId);
  }
  const existing = findOwnerIdByName(doc, trimmed);
  if (existing) return existing;
  const id = newId();
  upsertOwner(doc, id, trimmed);
  return id;
}

/** Display resolution: ownerId -> directory current name -> stored string. */
export function ownerDisplayName(
  owners: Record<Id, OwnerDirectoryEntry>,
  entry: OwnerEntry,
): string {
  if (entry.ownerId) {
    const dir = owners[entry.ownerId];
    if (dir?.name) return dir.name;
  }
  return entry.owner ?? '';
}
