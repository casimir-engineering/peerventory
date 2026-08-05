/**
 * Local registry of inventories known to this device.
 * Persisted in localStorage under 'inv:registry:v1', reactive via subscribe().
 */
import type { Id, InventoryHandle } from '../types';

const KEY = 'inv:registry:v1';

/**
 * What we actually persist: the public InventoryHandle plus a flag for docs
 * created locally that the server hasn't accepted yet (drives the `create`
 * payload in the sync auth token, see CONTRACTS.md).
 */
export interface StoredHandle extends InventoryHandle {
  pendingCreate?: boolean;
  /** true once the server has granted read-write scope for the stored rwToken */
  rwConfirmed?: boolean;
}

let handles: StoredHandle[] = load();
let version = 0;
const listeners = new Set<() => void>();

function load(): StoredHandle[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredHandle[]) : [];
  } catch {
    return [];
  }
}

function persistAndNotify(next: StoredHandle[]): void {
  handles = next;
  version++;
  try {
    localStorage.setItem(KEY, JSON.stringify(handles));
  } catch (err) {
    console.warn('[store] failed to persist registry', err);
  }
  for (const cb of listeners) cb();
}

// Keep multiple tabs in sync.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    handles = load();
    version++;
    for (const cb of listeners) cb();
  });
}

export function subscribeRegistry(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Stable array reference until the registry changes (for useSyncExternalStore). */
export function getHandlesSnapshot(): StoredHandle[] {
  return handles;
}

export function getRegistryVersion(): number {
  return version;
}

export function getStoredHandle(docId: Id): StoredHandle | null {
  return handles.find((h) => h.docId === docId) ?? null;
}

export function upsertHandle(handle: StoredHandle): void {
  const idx = handles.findIndex((h) => h.docId === handle.docId);
  const next = handles.slice();
  if (idx >= 0) next[idx] = { ...next[idx], ...handle };
  else next.push(handle);
  persistAndNotify(next);
}

/** Patch a handle; keys explicitly set to undefined are removed on persist (JSON drops them). */
export function updateHandle(docId: Id, patch: Partial<StoredHandle>): void {
  const idx = handles.findIndex((h) => h.docId === docId);
  if (idx < 0) return;
  const next = handles.slice();
  next[idx] = { ...next[idx], ...patch };
  persistAndNotify(next);
}

/** Union of two relay lists; returns undefined when both are empty/absent. */
function unionRelays(a?: string[], b?: string[]): string[] | undefined {
  const merged = [...new Set([...(a ?? []), ...(b ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

function sameRelays(a?: string[], b?: string[]): boolean {
  return (a ?? []).join(' ') === (b ?? []).join(' ');
}

/**
 * Merge handles from a device backup or the synced profile doc. Never
 * downgrades: a server-confirmed read-write token is kept over an incoming
 * one, and read-only imports never clobber existing write access. Relay
 * lists union-merge (add-only). Returns what happened for the toast.
 */
export function importHandles(
  incoming: Array<
    Pick<InventoryHandle, 'docId' | 'rwToken' | 'roToken' | 'key' | 'name' | 'relays'>
  >,
): { added: number; upgraded: number; unchanged: number } {
  let added = 0;
  let upgraded = 0;
  let unchanged = 0;
  let filled = false;
  const next = [...handles];

  for (const inc of incoming) {
    if (!inc.docId || (!inc.rwToken && !inc.roToken)) continue;
    const idx = next.findIndex((h) => h.docId === inc.docId);
    if (idx === -1) {
      next.push({
        docId: inc.docId,
        rwToken: inc.rwToken,
        roToken: inc.roToken,
        key: inc.key,
        name: inc.name,
        relays: unionRelays(inc.relays),
        readonly: !inc.rwToken,
      });
      added++;
      continue;
    }
    const existing = next[idx];
    const relays = unionRelays(existing.relays, inc.relays);
    const canUpgrade =
      inc.rwToken &&
      inc.rwToken !== existing.rwToken &&
      !(existing.rwConfirmed && existing.rwToken && !existing.readonly);
    if (canUpgrade) {
      next[idx] = {
        ...existing,
        rwToken: inc.rwToken,
        roToken: existing.roToken ?? inc.roToken,
        key: existing.key ?? inc.key,
        name: existing.name ?? inc.name,
        relays,
        readonly: false,
        rwConfirmed: undefined,
      };
      upgraded++;
    } else {
      // Fill gaps only; never count as a change worth reporting. The content
      // key is fill-only too: a key already stored locally always wins.
      if (
        (!existing.roToken && inc.roToken) ||
        (!existing.name && inc.name) ||
        (!existing.key && inc.key) ||
        !sameRelays(existing.relays, relays)
      ) {
        next[idx] = {
          ...existing,
          roToken: existing.roToken ?? inc.roToken,
          key: existing.key ?? inc.key,
          name: existing.name ?? inc.name,
          relays,
        };
        filled = true;
      }
      unchanged++;
    }
  }

  if (added > 0 || upgraded > 0 || filled) persistAndNotify(next);
  return { added, upgraded, unchanged };
}

export function removeHandle(docId: Id): void {
  persistAndNotify(handles.filter((h) => h.docId !== docId));
}
