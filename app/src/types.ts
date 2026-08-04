/**
 * Shared data model for the whole app.
 * This file is the contract between the store layer, the UI, and the export engine.
 * IDs are 10-char base58 nanoids (see store/ids.ts).
 */

export type Id = string;

/** Mandatory quick-input weight classes. Stored as a class; refinable to exact grams. */
export type WeightClass =
  | 'lt50g'      // < 50 g
  | 'g50_200'    // 50–200 g
  | 'g200_500'   // 200–500 g
  | 'g500_1k'    // 500 g – 1 kg
  | 'kg1_2'      // 1–2 kg
  | 'kg2_5'      // 2–5 kg
  | 'kg5_10'     // 5–10 kg
  | 'kg10_20'    // 10–20 kg
  | 'gt20kg';    // > 20 kg

export const WEIGHT_CLASSES: Record<WeightClass, { label: string; minG: number; maxG: number | null }> = {
  lt50g:    { label: '< 50 g',       minG: 0,     maxG: 50 },
  g50_200:  { label: '50–200 g',     minG: 50,    maxG: 200 },
  g200_500: { label: '200–500 g',    minG: 200,   maxG: 500 },
  g500_1k:  { label: '500 g – 1 kg', minG: 500,   maxG: 1000 },
  kg1_2:    { label: '1–2 kg',       minG: 1000,  maxG: 2000 },
  kg2_5:    { label: '2–5 kg',       minG: 2000,  maxG: 5000 },
  kg5_10:   { label: '5–10 kg',      minG: 5000,  maxG: 10000 },
  kg10_20:  { label: '10–20 kg',     minG: 10000, maxG: 20000 },
  gt20kg:   { label: '> 20 kg',      minG: 20000, maxG: null },
};

/** Mandatory quick-input size classes. Refinable to exact L×W×H mm. */
export type SizeClass =
  | 'pocket'       // fits in a pocket
  | 'shoebox'      // fits in a shoebox
  | 'carryon'      // fits in carry-on luggage
  | 'half_carton'  // half a standard 60x40x40 carton
  | 'full_carton'  // one full carton
  | 'oversize';    // bigger than a carton

/** approxLiters: representative volume used for inventory totals when no exact dims. */
export const SIZE_CLASSES: Record<SizeClass, { label: string; approxLiters: number }> = {
  pocket:      { label: 'Pocket',      approxLiters: 0.5 },
  shoebox:     { label: 'Shoebox',     approxLiters: 10 },
  carryon:     { label: 'Carry-on',    approxLiters: 40 },
  half_carton: { label: 'Half carton', approxLiters: 48 },
  full_carton: { label: 'Full carton', approxLiters: 96 },
  oversize:    { label: 'Oversize',    approxLiters: 200 },
};

export interface Weight {
  class: WeightClass;
  /** Exact measured weight in grams, if refined. */
  exactGrams?: number;
}

export interface Dimensions {
  class: SizeClass;
  /** Exact measured dimensions in mm, if refined. */
  exactMm?: { l: number; w: number; h: number };
}

export interface MoneyValue {
  amount: number;
  /** ISO 4217, e.g. 'USD', 'EUR', 'CNY' */
  currency: string;
}

export interface LocationEntry {
  /** epoch ms */
  time: number;
  lat?: number;
  lon?: number;
  /** Human-readable place name, free text */
  label?: string;
}

export interface OwnerEntry {
  /** epoch ms */
  time: number;
  owner: string;
}

export type PhotoRole = 'photo' | 'serial_label' | 'receipt';

export interface PhotoRef {
  /** sha256 hex of the (already resized) image bytes; key into the blob store */
  hash: string;
  mime: string;
  role: PhotoRole;
  addedAt: number;
}

export type AcquisitionMethod = 'new' | 'used' | 'gift';

export interface Item {
  id: Id;
  createdAt: number;
  updatedAt: number;

  // Core fields
  description: string;
  category?: string;
  tags: string[];
  quantity: number;
  valueCurrent?: MoneyValue;
  valueNew?: MoneyValue;
  photos: PhotoRef[];
  /** Append-only. Current location = last entry. */
  locationHistory: LocationEntry[];
  /** Append-only. Current owner = last entry. Empty if owner tracking disabled. */
  ownerHistory: OwnerEntry[];
  /** Per-item opt-out of owner tracking (inventory-level tracking is on by default). */
  ownerDisabled?: boolean;

  // Mandatory logistics fields
  weight: Weight;
  dimensions: Dimensions;

  // Optional customs fields (never block item creation)
  serialNumber?: string;
  purchase?: { date?: string; price?: MoneyValue; vendor?: string };
  boxId?: Id;
  condition?: string;
  lithiumBattery?: boolean;
  countryOfOrigin?: string;
  acquisition?: AcquisitionMethod;
  notes?: string;

  // AI-fillable-later fields
  hsCode?: string;
  brandModel?: string;
  /** lang code -> translated description, e.g. { zh: '...' } */
  translations?: Record<string, string>;
}

export interface Box {
  id: Id;
  label: string;
  notes?: string;
}

export interface SavedList {
  id: Id;
  name: string;
  itemIds: Id[];
  createdAt: number;
}

/** Inventory-level metadata stored inside the Y.Doc under 'meta'. */
export interface InventoryMeta {
  id: Id;
  name: string;
  description?: string;
  createdAt: number;
  ownerTrackingEnabled: boolean;
  /** Default currency for new values */
  currency: string;
  /**
   * false = GPS coordinates never enter the synced doc; only place labels are
   * stored, so people the inventory is shared with cannot see precise
   * locations. Absent/true = coordinates are stored.
   */
  preciseLocation?: boolean;
}

/**
 * Local registry entry for an inventory known to this device
 * (own or joined via share link). Persisted in localStorage.
 */
export interface InventoryHandle {
  docId: Id;
  /** Read-write token, if we have write access */
  rwToken?: string;
  /** Read-only token (always present; used to build read-only share links) */
  roToken?: string;
  /**
   * Content encryption key (base64url, 32 bytes). Every inventory is
   * end-to-end encrypted; the key never reaches the server and travels only
   * in share-link fragments, QR codes and backups. Absent = this device
   * holds tokens but cannot decrypt ("Encryption key missing" in the UI).
   */
  key?: string;
  /** Cached display name for the list screen */
  name?: string;
  readonly: boolean;
  /** Epoch ms of the last completed sync with the relay on this device. */
  lastSyncedAt?: number;
}

/** A device that wrote to this inventory, recorded in the doc's `devices` map. */
export interface DevicePresence {
  id: string;
  /** e.g. "Alex · Android" */
  label: string;
  /** Epoch ms the device last recorded itself (throttled). */
  at: number;
}

/** Plain-object snapshot of a whole inventory, used by exports. */
export interface InventorySnapshot {
  meta: InventoryMeta;
  items: Item[];
  boxes: Box[];
  savedLists: SavedList[];
  devices?: DevicePresence[];
}
