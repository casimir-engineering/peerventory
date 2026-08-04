/**
 * React hooks implementing the store<->UI contract (contract.ts).
 * Reactivity: Y.Doc 'update' events + registry changes drive a version
 * counter consumed via useSyncExternalStore.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import type {
  Box,
  Id,
  InventoryHandle,
  InventoryMeta,
  InventorySnapshot,
  Item,
  LocationEntry,
  PhotoRef,
  PhotoRole,
  SavedList,
} from '../types';
import type {
  ItemDraft,
  ItemPatch,
  UseInventoriesResult,
  UseInventoryResult,
} from './contract';
import {
  closeDoc,
  getEntry,
  openDoc,
  readBoxes,
  readDevices,
  readItems,
  readLists,
  readMeta,
  resyncDoc,
  subscribeDoc,
  type DocEntry,
} from './docs';
import { generateContentKey, isValidContentKey } from './crypto';
import { newId, newToken } from './ids';
import { addPhoto as storeAddPhoto, clearUploadQueue, kickUploadLoop } from './photos';
import {
  getHandlesSnapshot,
  getRegistryVersion,
  getStoredHandle,
  removeHandle,
  subscribeRegistry,
  updateHandle,
  upsertHandle,
} from './registry';

/** Remove keys whose value is undefined (Y stores plain JSON values). */
function compact<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/* ---------------- useInventories ---------------- */

async function createInventory(
  name: string,
  opts?: { currency?: string; ownerTrackingEnabled?: boolean; preciseLocation?: boolean },
): Promise<InventoryHandle> {
  const docId = newId();
  const rwToken = newToken();
  const roToken = newToken();
  // Every inventory is end-to-end encrypted: the relay only ever sees
  // ciphertext. The key lives in the registry and share links only.
  const key = generateContentKey();

  // Handle must exist before openDoc so the sync provider can build its token
  // (including the first-connect create payload, see CONTRACTS.md).
  upsertHandle({ docId, rwToken, roToken, key, name, readonly: false, pendingCreate: true });

  const entry = openDoc(docId);
  const now = Date.now();
  entry.doc.transact(() => {
    const meta = entry.doc.getMap<unknown>('meta');
    meta.set('id', docId);
    meta.set('name', name);
    meta.set('createdAt', now);
    meta.set('ownerTrackingEnabled', opts?.ownerTrackingEnabled ?? true);
    meta.set('currency', opts?.currency ?? 'USD');
    meta.set('preciseLocation', opts?.preciseLocation ?? true);
  });

  return getStoredHandle(docId)!;
}

async function joinInventory(docId: Id, token: string, key?: string): Promise<InventoryHandle> {
  const contentKey = key && isValidContentKey(key) ? key : undefined;
  const existing = getStoredHandle(docId);
  if (existing) {
    // A new token may upgrade us; store it as rw until the server says
    // otherwise — but never clobber a server-confirmed rw token with a token
    // of unknown kind (an owner opening their own ro share link would
    // otherwise permanently downgrade the handle).
    const isNewToken = token !== existing.rwToken && token !== existing.roToken;
    const adopt =
      isNewToken && !(existing.rwConfirmed && existing.rwToken && !existing.readonly);
    if (adopt) {
      upsertHandle({ ...existing, rwToken: token, readonly: false, rwConfirmed: undefined });
    }
    if (contentKey && !existing.key) {
      // The link carried the content key this device was missing. Anything
      // synced without it is undecryptable log ciphertext, so wipe the local
      // copy and let the doc re-sync through the decrypt pipeline.
      updateHandle(docId, { key: contentKey });
      await closeDoc(docId, { clearData: true });
      openDoc(docId);
      return getStoredHandle(docId)!;
    }
    openDoc(docId);
    // Re-authenticate when the token changed (a live readonly connection would
    // otherwise keep dropping writes server-side), and give a doc stuck in
    // 'error' from a previously rejected token another chance.
    resyncDoc(docId, { tokenChanged: adopt });
    return getStoredHandle(docId)!;
  }
  // Token kind unknown until the server handshake; docs.ts moves it to roToken
  // and flips `readonly` if the server grants read-only scope.
  upsertHandle({ docId, rwToken: token, key: contentKey, readonly: false });
  openDoc(docId);
  return getStoredHandle(docId)!;
}

/**
 * Reopen a doc after its content key arrived outside the join flow (backup
 * restore). Anything synced without the key is undecryptable ciphertext, so
 * the local copy is wiped and re-synced through the decrypt pipeline.
 */
export async function reopenEncryptedDoc(docId: Id): Promise<void> {
  await closeDoc(docId, { clearData: true });
  openDoc(docId);
}

async function forgetInventory(docId: Id): Promise<void> {
  await closeDoc(docId, { clearData: true });
  await clearUploadQueue(docId);
  removeHandle(docId);
}

export function useInventories(): UseInventoriesResult {
  const handles = useSyncExternalStore(subscribeRegistry, getHandlesSnapshot);
  return { handles, createInventory, joinInventory, forgetInventory };
}

/* ---------------- useInventory ---------------- */

const EMPTY_DATA: {
  meta: InventoryMeta | null;
  items: Item[];
  boxes: Box[];
  savedLists: SavedList[];
} = { meta: null, items: [], boxes: [], savedLists: [] };

function guardWrite(entry: DocEntry | null, docId: Id | null): DocEntry | null {
  if (!entry || !docId) {
    console.warn('[store] mutation ignored: no inventory open');
    return null;
  }
  if (getStoredHandle(docId)?.readonly) {
    console.warn(`[store] mutation ignored: inventory ${docId} is read-only`);
    return null;
  }
  return entry;
}

function getItemMap(entry: DocEntry, itemId: Id): Y.Map<unknown> | null {
  const item = entry.doc.getMap<Y.Map<unknown>>('items').get(itemId);
  if (!item) console.warn(`[store] item ${itemId} not found`);
  return item ?? null;
}

/**
 * Append to a JSON array stored as a single value on the item map.
 * Known tradeoff (by design, see contract.ts): the whole array is one Yjs
 * value, so two devices appending concurrently while offline resolve
 * last-writer-wins on the entire array and one side's entry is lost after
 * sync. What we CAN guarantee is that within this client the read and write
 * happen atomically against fresh state: callers must invoke this inside a
 * doc.transact() and never pass in an array read earlier.
 */
function appendToArray(item: Y.Map<unknown>, key: string, value: unknown): void {
  const current = item.get(key);
  const arr = Array.isArray(current) ? [...(current as unknown[])] : [];
  arr.push(value);
  item.set(key, arr);
}

/**
 * Enforced at the store boundary so no UI path can leak coordinates into a
 * doc whose meta says labels only (meta.preciseLocation === false).
 */
function sanitizeLocation(entry: DocEntry, loc: LocationEntry): LocationEntry {
  if (readMeta(entry.doc)?.preciseLocation !== false) return loc;
  return { time: loc.time, ...(loc.label ? { label: loc.label } : {}) };
}

export function useInventory(docId: Id | null): UseInventoryResult {
  // Deliberately not memoized on docId alone: after forgetInventory +
  // re-join in the same session a memoized entry would keep pointing at the
  // destroyed Y.Doc and silently swallow writes. openDoc is a cheap map
  // lookup for already-open docs.
  const entry = docId ? openDoc(docId) : null;

  const subscribe = useCallback(
    (cb: () => void) => {
      const unsubDoc = docId ? subscribeDoc(docId, cb) : () => {};
      const unsubReg = subscribeRegistry(cb);
      return () => {
        unsubDoc();
        unsubReg();
      };
    },
    [docId],
  );
  const getSnapshot = useCallback(() => {
    const e = docId ? getEntry(docId) : null;
    return `${e ? e.version : -1}:${getRegistryVersion()}`;
  }, [docId]);
  const version = useSyncExternalStore(subscribe, getSnapshot);

  const data = useMemo(() => {
    if (!entry) return EMPTY_DATA;
    void version; // recompute when the doc or registry changes
    return {
      meta: readMeta(entry.doc),
      items: readItems(entry.doc),
      boxes: readBoxes(entry.doc),
      savedLists: readLists(entry.doc),
    };
  }, [entry, version]);

  const handle = docId ? getStoredHandle(docId) : null;
  const readonly = handle?.readonly ?? false;

  // Opportunistically resume pending photo uploads for this doc.
  useEffect(() => {
    if (docId && !readonly) kickUploadLoop(docId);
  }, [docId, readonly]);

  return {
    loaded: entry?.loaded ?? false,
    readonly,
    keyMissing: entry?.keyMissing ?? false,
    meta: data.meta,
    items: data.items,
    boxes: data.boxes,
    savedLists: data.savedLists,
    syncStatus: entry?.status ?? 'offline',

    updateMeta(patch) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      e.doc.transact(() => {
        const meta = e.doc.getMap<unknown>('meta');
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) meta.delete(k);
          else meta.set(k, v);
        }
      });
    },

    createItem(draft: ItemDraft): Id {
      if (!draft.weight || !draft.dimensions) {
        throw new Error('createItem: weight and dimensions are mandatory');
      }
      const id = newId();
      const e = guardWrite(entry, docId);
      if (!e) return id;
      const now = Date.now();
      const initialLocation = draft.initialLocation
        ? sanitizeLocation(e, draft.initialLocation)
        : undefined;
      const item: Item = {
        id,
        createdAt: now,
        updatedAt: now,
        description: draft.description,
        category: draft.category,
        tags: draft.tags ?? [],
        quantity: draft.quantity ?? 1,
        valueCurrent: draft.valueCurrent,
        valueNew: draft.valueNew,
        photos: [],
        locationHistory: initialLocation ? [initialLocation] : [],
        ownerHistory: draft.initialOwner ? [{ time: now, owner: draft.initialOwner }] : [],
        ownerDisabled: draft.ownerDisabled,
        weight: draft.weight,
        dimensions: draft.dimensions,
        serialNumber: draft.serialNumber,
        purchase: draft.purchase,
        boxId: draft.boxId,
        condition: draft.condition,
        lithiumBattery: draft.lithiumBattery,
        countryOfOrigin: draft.countryOfOrigin,
        acquisition: draft.acquisition,
        notes: draft.notes,
        brandModel: draft.brandModel,
        hsCode: draft.hsCode,
        translations: draft.translations,
      };
      e.doc.transact(() => {
        e.doc
          .getMap<Y.Map<unknown>>('items')
          .set(id, new Y.Map(Object.entries(compact(item))));
      });
      return id;
    },

    updateItem(itemId: Id, patch: ItemPatch) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      e.doc.transact(() => {
        const item = getItemMap(e, itemId);
        if (!item) return;
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) item.delete(k);
          else item.set(k, v);
        }
        item.set('updatedAt', Date.now());
      });
    },

    deleteItem(itemId: Id) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      e.doc.getMap<Y.Map<unknown>>('items').delete(itemId);
    },

    addLocation(itemId: Id, locationEntry: LocationEntry) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      e.doc.transact(() => {
        const item = getItemMap(e, itemId);
        if (!item) return;
        appendToArray(item, 'locationHistory', sanitizeLocation(e, locationEntry));
        item.set('updatedAt', Date.now());
      });
    },

    stripLocationCoords(): number {
      const e = guardWrite(entry, docId);
      if (!e) return 0;
      let scrubbed = 0;
      e.doc.transact(() => {
        e.doc.getMap<Y.Map<unknown>>('items').forEach((item) => {
          const history = item.get('locationHistory');
          if (!Array.isArray(history)) return;
          let touched = false;
          const next = (history as LocationEntry[]).map((loc) => {
            if (loc.lat === undefined && loc.lon === undefined) return loc;
            touched = true;
            scrubbed += 1;
            return { time: loc.time, ...(loc.label ? { label: loc.label } : {}) };
          });
          if (touched) {
            item.set('locationHistory', next);
            item.set('updatedAt', Date.now());
          }
        });
      });
      return scrubbed;
    },

    setOwner(itemId: Id, owner: string) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      e.doc.transact(() => {
        const item = getItemMap(e, itemId);
        if (!item) return;
        appendToArray(item, 'ownerHistory', { time: Date.now(), owner });
        item.set('updatedAt', Date.now());
      });
    },

    async addPhoto(itemId: Id, blob: Blob, role: PhotoRole = 'photo'): Promise<PhotoRef> {
      const e = guardWrite(entry, docId);
      if (!e || !docId) throw new Error('addPhoto: inventory is read-only or not open');
      return storeAddPhoto(docId, itemId, blob, role);
    },

    removePhoto(itemId: Id, hash: string) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      e.doc.transact(() => {
        const item = getItemMap(e, itemId);
        if (!item) return;
        const current = item.get('photos');
        const photos = Array.isArray(current) ? (current as PhotoRef[]) : [];
        item.set('photos', photos.filter((p) => p.hash !== hash));
        item.set('updatedAt', Date.now());
      });
    },

    createBox(label: string, notes?: string): Id {
      const id = newId();
      const e = guardWrite(entry, docId);
      if (!e) return id;
      e.doc.getMap<Box>('boxes').set(id, compact({ id, label, notes }) as Box);
      return id;
    },

    updateBox(boxId: Id, patch) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      const boxes = e.doc.getMap<Box>('boxes');
      const box = boxes.get(boxId);
      if (!box) {
        console.warn(`[store] box ${boxId} not found`);
        return;
      }
      boxes.set(boxId, compact({ ...box, ...patch }) as Box);
    },

    deleteBox(boxId: Id) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      e.doc.getMap<Box>('boxes').delete(boxId);
    },

    createSavedList(name: string, itemIds: Id[]): Id {
      const id = newId();
      const e = guardWrite(entry, docId);
      if (!e) return id;
      e.doc
        .getMap<SavedList>('lists')
        .set(id, { id, name, itemIds: [...itemIds], createdAt: Date.now() });
      return id;
    },

    updateSavedList(listId: Id, patch) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      const lists = e.doc.getMap<SavedList>('lists');
      const list = lists.get(listId);
      if (!list) {
        console.warn(`[store] saved list ${listId} not found`);
        return;
      }
      lists.set(listId, compact({ ...list, ...patch }) as SavedList);
    },

    deleteSavedList(listId: Id) {
      const e = guardWrite(entry, docId);
      if (!e) return;
      e.doc.getMap<SavedList>('lists').delete(listId);
    },
  };
}

/* ---------------- non-hook API ---------------- */

/** Plain-object deep snapshot; opens the doc and waits for local persistence. */
export async function snapshotInventory(docId: Id): Promise<InventorySnapshot> {
  const entry = openDoc(docId);
  await entry.idb.whenSynced;
  const meta = readMeta(entry.doc);
  if (!meta) {
    // Joined doc that never synced: snapshot whatever we have with stub meta.
    console.warn(`[store] snapshotInventory: no meta for ${docId} yet`);
  }
  return structuredClone({
    meta:
      meta ??
      ({
        id: docId,
        name: getStoredHandle(docId)?.name ?? docId,
        createdAt: 0,
        ownerTrackingEnabled: false,
        currency: 'USD',
      } satisfies InventoryMeta),
    items: readItems(entry.doc),
    boxes: readBoxes(entry.doc),
    savedLists: readLists(entry.doc),
    devices: readDevices(entry.doc),
  });
}

export function getHandle(docId: Id): InventoryHandle | null {
  return getStoredHandle(docId);
}

/**
 * Rebuild an exported inventory (YAML/ZIP import) as a NEW local inventory
 * with fresh docId and tokens. Item/box/list ids are preserved so saved lists
 * keep pointing at their items; photos are re-attached from the provided
 * blobs (rehashed, queued for upload). Returns the new docId.
 */
export async function importSnapshot(
  snap: InventorySnapshot,
  photoBlobs: Map<string, Blob>,
): Promise<Id> {
  const handle = await createInventory(snap.meta.name || 'Imported inventory', {
    currency: snap.meta.currency || 'USD',
    ownerTrackingEnabled: snap.meta.ownerTrackingEnabled ?? true,
    preciseLocation: snap.meta.preciseLocation,
  });
  const docId = handle.docId;
  const entry = openDoc(docId);

  entry.doc.transact(() => {
    if (snap.meta.description) {
      entry.doc.getMap<unknown>('meta').set('description', snap.meta.description);
    }
    const boxes = entry.doc.getMap<Box>('boxes');
    for (const box of snap.boxes) boxes.set(box.id, box);
    const lists = entry.doc.getMap<SavedList>('lists');
    for (const list of snap.savedLists) lists.set(list.id, list);
    const items = entry.doc.getMap<Y.Map<unknown>>('items');
    for (const item of snap.items) {
      // Photos are attached below through the blob pipeline (new hashes).
      const plain = compact({ ...item, photos: [] as PhotoRef[] });
      items.set(item.id, new Y.Map(Object.entries(plain)));
    }
  });

  for (const item of snap.items) {
    for (const ref of item.photos ?? []) {
      const blob = photoBlobs.get(ref.hash);
      if (!blob) continue;
      try {
        await storeAddPhoto(docId, item.id, blob, ref.role);
      } catch (err) {
        console.warn(`[store] import: photo ${ref.hash} failed`, err);
      }
    }
  }

  return docId;
}

