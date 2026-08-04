/**
 * Extension-side data model. `ExtItem` is a trimmed, plain-JSON projection of
 * the app's `Item` (app/src/types.ts) — only what search and listing
 * generation need. The serial NUMBER itself is deliberately never stored in
 * the extension, only whether one exists (mirrors the listing payload
 * contract).
 */

export interface MoneyValue {
  amount: number;
  /** ISO 4217 */
  currency: string;
}

export interface ProfileHandle {
  docId: string;
  /** Present when the profile link carried write access; used only as a fallback token. */
  rwToken?: string;
  /** Preferred: read access is all the connector needs. */
  roToken?: string;
  /** base64url AES-256-GCM content key of the end-to-end encrypted doc. */
  key?: string;
  name?: string;
}

/** What the pasted profile share link is turned into (chrome.storage.local `pv:profile`). */
export interface Profile {
  /** App/relay origin, e.g. https://inv.example.com (wss `<origin>/sync`, blobs `<origin>/api`). */
  origin: string;
  userName?: string;
  handles: ProfileHandle[];
  importedAt: number;
}

export interface ExtPhotoRef {
  /** sha256 hex of the encrypted blob; key into the blob API and the local photo cache. */
  hash: string;
  mime: string;
}

export interface ExtItem {
  id: string;
  docId: string;
  description: string;
  category?: string;
  tags: string[];
  quantity: number;
  condition?: string;
  brandModel?: string;
  notes?: string;
  valueCurrent?: MoneyValue;
  valueNew?: MoneyValue;
  weightGrams?: number;
  dimensionsMm?: { l: number; w: number; h: number };
  serialIncluded: boolean;
  photos: ExtPhotoRef[];
  createdAt: number;
  updatedAt: number;
}

/** Per-inventory synced snapshot (chrome.storage.local `pv:cache`). */
export interface CachedInventory {
  docId: string;
  name: string;
  /** Epoch ms of the last successful sync; 0 = never synced. */
  syncedAt: number;
  /** Human-readable reason the last sync failed (cached items stay usable). */
  error?: string;
  items: ExtItem[];
}

export type CacheMap = Record<string, CachedInventory>;

/* ----- listing payload v1 (contract with content scripts / the app) ----- */

export interface ListingPayloadItem {
  title: string;
  description: string;
  descriptionTranslations?: { fr?: string; de?: string };
  priceAmount: number;
  priceCurrency: string;
  condition?: string;
  category?: string;
  brandModel?: string;
  weightGrams?: number;
  dimensionsMm?: { l: number; w: number; h: number };
  serialIncluded: boolean;
}

export interface ListingPayload {
  v: 1;
  source: 'peerventory';
  item: ListingPayloadItem;
  photosNote: string;
}

/* ----- staged photos (popup -> content scripts, `pv:photos`) ----- */

/** One decrypted photo, base64-encoded so it survives chrome.storage.local
 * (Blobs cannot cross that boundary; the popup may be closed by the time the
 * content script attaches, so messaging is not an option either). */
export interface StagedPhoto {
  name: string;
  type: string;
  /** base64 of the decrypted image bytes (no data-URL prefix). */
  b64: string;
}

export interface StagedPhotos {
  /** Epoch ms when staged; content scripts ignore stale stagings. */
  at: number;
  photos: StagedPhoto[];
}
