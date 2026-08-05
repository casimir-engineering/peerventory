/**
 * Full-account backup: one ZIP holding the account itself (identity, profile
 * doc handle, every inventory token and content key — the same payload the
 * "full backup" link carries) AND the full contents of every inventory
 * (YAML manifest + photo blobs, same layout as the per-inventory export).
 *
 * The point of the file over the link/QR: a link only carries ACCESS, so
 * restoring from it needs a reachable relay to pull the data back. This
 * archive carries the data too, so a restore works with no network at all
 * and sync simply catches up later.
 *
 *   account.json                              manifest (see AccountManifest)
 *   README.txt
 *   inventories/<docId>/inventory.yaml
 *   inventories/<docId>/photos/<hash>.<ext>
 *   inventories/<docId>/photo-index.yaml
 */

import JSZip from 'jszip';

import type { InventorySnapshot } from '../types';
import { addInventoryToZip, generateZip } from './zip';

export const ACCOUNT_MANIFEST_NAME = 'account.json';
export const ACCOUNT_SCHEMA = 'peerventory-account';
export const ACCOUNT_SCHEMA_VERSION = 1;

export interface AccountManifestInventory {
  docId: string;
  name: string;
  /** Folder inside the archive holding this inventory's files. */
  folder: string;
  items: number;
  photos: number;
}

export interface AccountManifest {
  schema: typeof ACCOUNT_SCHEMA;
  version: number;
  exportedAt: number;
  name?: string;
  ownerId?: string;
  /**
   * base64url backup payload (services/backup.ts): identity, profile-doc
   * handle and every inventory handle with its tokens and content key. The
   * restore path decodes it with decodeBackup and merges it with importBackup,
   * exactly like a device-link QR or backup link.
   */
  backup: string;
  /** Relay origins this device syncs through, as a hint for the restore. */
  relays: string[];
  inventories: AccountManifestInventory[];
}

export interface AccountExportInventory {
  docId: string;
  name: string;
  snapshot: InventorySnapshot;
  getPhotoBlob: (hash: string) => Promise<Blob | null>;
}

export interface AccountExportInput {
  backup: string;
  name?: string;
  ownerId?: string;
  relays: string[];
  inventories: AccountExportInventory[];
  exportedAt?: number;
  /** Called after each inventory is written, for a progress line in the UI. */
  onProgress?: (done: number, total: number) => void;
}

function readme(manifest: AccountManifest): string {
  return [
    'Peerventory full account backup',
    '',
    `Exported: ${new Date(manifest.exportedAt).toISOString()}`,
    manifest.name ? `Account: ${manifest.name}` : 'Account: (no name set)',
    `Inventories: ${manifest.inventories.length}`,
    '',
    'Restore it by opening Peerventory and dropping this .zip on the',
    'inventories list, or with "Restore / import from file" under Account &',
    'sync. The app rejoins the account and restores every inventory,',
    'including photos, without needing a network connection.',
    '',
    'account.json carries the access tokens and encryption keys for this',
    'account. Anyone holding this archive has full access to everything in',
    'it — treat it like a password.',
    '',
    'Each inventories/<id>/inventory.yaml is a normal Peerventory inventory',
    'export and can also be imported on its own.',
  ].join('\n');
}

export async function accountToZip(input: AccountExportInput): Promise<Blob> {
  const zip = new JSZip();
  const exportedAt = input.exportedAt ?? Date.now();
  const inventories: AccountManifestInventory[] = [];

  let done = 0;
  for (const inv of input.inventories) {
    const folder = `inventories/${inv.docId}`;
    const { photos } = await addInventoryToZip(zip, folder, inv.snapshot, inv.getPhotoBlob);
    inventories.push({
      docId: inv.docId,
      name: inv.name || inv.snapshot.meta.name || inv.docId,
      folder,
      items: inv.snapshot.items.length,
      photos,
    });
    done += 1;
    input.onProgress?.(done, input.inventories.length);
  }

  const manifest: AccountManifest = {
    schema: ACCOUNT_SCHEMA,
    version: ACCOUNT_SCHEMA_VERSION,
    exportedAt,
    ...(input.name ? { name: input.name } : {}),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    backup: input.backup,
    relays: input.relays,
    inventories,
  };

  zip.file(ACCOUNT_MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  zip.file('README.txt', readme(manifest));
  return generateZip(zip);
}

/** Shape check for a decoded account.json (used by the import path). */
export function isAccountManifest(value: unknown): value is AccountManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<AccountManifest>;
  return (
    m.schema === ACCOUNT_SCHEMA &&
    typeof m.backup === 'string' &&
    m.backup.length > 0 &&
    Array.isArray(m.inventories)
  );
}
