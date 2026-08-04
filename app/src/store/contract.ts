/**
 * CONTRACT between the store layer (store/) and the UI (ui/).
 * The store agent IMPLEMENTS these interfaces; the UI agent CONSUMES them.
 *
 * Implementation notes (for the store):
 * - One Y.Doc per inventory. Top-level shared types:
 *     doc.getMap('meta')   -> InventoryMeta fields
 *     doc.getMap('items')  -> itemId -> Y.Map (item fields; arrays/objects stored as plain JSON values)
 *     doc.getMap('boxes')  -> boxId -> plain Box object
 *     doc.getMap('lists')  -> listId -> plain SavedList object
 * - Persistence: y-indexeddb (key = docId).
 * - Sync: @hocuspocus/provider against getServerConfig().wsUrl, document name = docId,
 *   token = JSON.stringify({ t: <rwToken|roToken>, ro: <roTokenHash-on-create> }) — see CONTRACTS.md.
 * - End-to-end encryption (every doc): the doc above stays local-only; the
 *   provider syncs an opaque OUTER doc holding an append-log of
 *   AES-GCM-encrypted updates (store/e2ee.ts, CONTRACTS.md "End-to-end
 *   encryption"). A handle without a content key can only relay ciphertext;
 *   the UI shows "Encryption key missing" for it.
 * - Photos: content-addressed blobs in idb-keyval ('blob:<hash>'), background
 *   upload/download queue against the blob HTTP API (see CONTRACTS.md). The
 *   hash addresses the CIPHERTEXT; the local cache stays plaintext.
 *
 * The store must export from 'store/index.ts':
 *   - all hooks below
 *   - ids.ts helpers: newId(), newToken()
 *   - snapshotInventory(docId): Promise<InventorySnapshot>   (used by exports/UI)
 */

import type {
  Id, Item, Box, SavedList, InventoryMeta, InventoryHandle, InventorySnapshot,
  PhotoRole, LocationEntry, Weight, Dimensions, MoneyValue, AcquisitionMethod, PhotoRef,
} from '../types';

/** Fields required to create an item. Weight and dimensions are MANDATORY. */
export interface ItemDraft {
  description: string;
  weight: Weight;
  dimensions: Dimensions;
  quantity?: number;              // default 1
  category?: string;
  tags?: string[];
  valueCurrent?: MoneyValue;
  valueNew?: MoneyValue;
  initialLocation?: LocationEntry; // UI passes GPS fix here; store appends as first history entry
  initialOwner?: string;
  ownerDisabled?: boolean;
  serialNumber?: string;
  purchase?: { date?: string; price?: MoneyValue; vendor?: string };
  boxId?: Id;
  condition?: string;
  lithiumBattery?: boolean;
  countryOfOrigin?: string;
  acquisition?: AcquisitionMethod;
  notes?: string;
  brandModel?: string;
  hsCode?: string;
  translations?: Record<string, string>;
}

export type ItemPatch = Partial<Omit<Item, 'id' | 'createdAt' | 'photos' | 'locationHistory' | 'ownerHistory'>>;

export type SyncStatus = 'offline' | 'connecting' | 'synced' | 'error';

/** Registry of inventories known to this device. */
export interface UseInventoriesResult {
  handles: InventoryHandle[];
  /** Creates doc + tokens + content key locally (always E2E), registers with server when online. Returns handle. */
  createInventory(name: string, opts?: { currency?: string; ownerTrackingEnabled?: boolean; preciseLocation?: boolean }): Promise<InventoryHandle>;
  /** Join from a share link (docId + token + optional content key). Determines ro/rw from server handshake. */
  joinInventory(docId: Id, token: string, key?: string): Promise<InventoryHandle>;
  /** Remove from this device only (doc data deleted locally). */
  forgetInventory(docId: Id): Promise<void>;
}

export interface UseInventoryResult {
  loaded: boolean;
  readonly: boolean;
  /** This device has NO content key: the synced doc is unreadable ciphertext. */
  keyMissing: boolean;
  meta: InventoryMeta | null;
  items: Item[];                 // reactive, sorted by createdAt desc
  boxes: Box[];
  savedLists: SavedList[];
  syncStatus: SyncStatus;

  updateMeta(patch: Partial<Omit<InventoryMeta, 'id' | 'createdAt'>>): void;

  createItem(draft: ItemDraft): Id;
  updateItem(itemId: Id, patch: ItemPatch): void;
  deleteItem(itemId: Id): void;

  /** Append to location history (current location = last entry). */
  addLocation(itemId: Id, entry: LocationEntry): void;
  /**
   * Remove lat/lon/accuracy from every location history entry in the doc.
   * Used when precise locations get turned off. Returns entries scrubbed.
   */
  stripLocationCoords(): number;
  /** Append to owner history. */
  setOwner(itemId: Id, owner: string): void;

  addPhoto(itemId: Id, blob: Blob, role?: PhotoRole): Promise<PhotoRef>;
  removePhoto(itemId: Id, hash: string): void;

  createBox(label: string, notes?: string): Id;
  updateBox(boxId: Id, patch: Partial<Omit<Box, 'id'>>): void;
  deleteBox(boxId: Id): void;

  createSavedList(name: string, itemIds: Id[]): Id;
  updateSavedList(listId: Id, patch: Partial<Omit<SavedList, 'id' | 'createdAt'>>): void;
  deleteSavedList(listId: Id): void;
}

export interface PhotoStore {
  /** Object URL for a locally-cached blob, or null if not (yet) available.
   *  Triggers background download from the blob server when missing. */
  usePhotoUrl(docId: Id, hash: string): string | null;
}

/* Implemented in store/index.ts:

export function useInventories(): UseInventoriesResult;
export function useInventory(docId: Id | null): UseInventoryResult;
export function usePhotoUrl(docId: Id, hash: string | null): string | null;
export function snapshotInventory(docId: Id): Promise<InventorySnapshot>;
export function getHandle(docId: Id): InventoryHandle | null;
export function newId(): Id;      // 10-char base58 nanoid
export function newToken(): string; // 16-char base58 nanoid
// Wipe + reopen a doc whose content key arrived via backup restore.
export function reopenEncryptedDoc(docId: Id): Promise<void>;
*/
