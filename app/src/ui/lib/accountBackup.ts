/**
 * Full-account backup and restore (see export/account.ts for the archive
 * layout).
 *
 * Backup = the account payload (identity, profile-doc handle, every
 * inventory token and content key) PLUS the contents of every inventory.
 * Restore = the exact same account merge the device-link QR performs
 * (services/backup.importBackup), followed by putting the contents back into
 * the docs they came from — which is what makes a restore work with no relay
 * in reach.
 */

import { accountToZip, ACCOUNT_SCHEMA } from '../../export';
import { encodeBackup, getOwnerId, getUserName, importBackup } from '../../services';
import type { ImportBackupResult } from '../../services';
import {
  addRelay,
  getHandle,
  getHandlesSnapshot,
  getPhotoBlob,
  getRelaysSnapshot,
  importSnapshot,
  restoreSnapshotInto,
  snapshotInventory,
} from '../../store';
import { safeFilename } from './format';
import type { ParsedAccount } from './importFile';

export { ACCOUNT_SCHEMA };

export interface AccountBackupFile {
  blob: Blob;
  filename: string;
  inventories: number;
}

export async function buildAccountBackup(
  onProgress?: (done: number, total: number) => void,
): Promise<AccountBackupFile> {
  const handles = getHandlesSnapshot();
  const inventories = await Promise.all(
    handles.map(async (handle) => ({
      docId: handle.docId,
      name: handle.name ?? '',
      snapshot: await snapshotInventory(handle.docId),
      getPhotoBlob: (hash: string) => getPhotoBlob(handle.docId, hash),
    })),
  );

  const name = getUserName() ?? undefined;
  const blob = await accountToZip({
    backup: encodeBackup(),
    name,
    ownerId: getOwnerId(),
    relays: getRelaysSnapshot()
      .filter((relay) => relay.enabled)
      .map((relay) => relay.url),
    inventories,
    onProgress,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const who = name ? `${safeFilename(name)}-` : '';
  return {
    blob,
    filename: `peerventory-account-${who}${stamp}.zip`,
    inventories: inventories.length,
  };
}

export interface AccountRestoreResult {
  account: ImportBackupResult;
  relaysAdded: number;
  /** Contents written back into the inventory they were exported from. */
  restored: number;
  /** Already had contents on this device (or view-only here): left alone. */
  skipped: number;
  /** Not part of the account payload, so imported as a fresh inventory. */
  importedAsNew: number;
  failed: number;
}

export async function restoreAccount(
  account: ParsedAccount,
  onProgress?: (done: number, total: number) => void,
): Promise<AccountRestoreResult> {
  // Same merge as a device-link QR or a backup link: never downgrades this
  // device, and joins the archive's profile when it carries one.
  const accountResult = importBackup(account.backup);
  // Docs that just gained a content key are wiped and reopened; writing their
  // contents back before that finishes would lose the write.
  await accountResult.reopened;

  let relaysAdded = 0;
  for (const relay of account.manifest.relays ?? []) {
    if (addRelay(relay).ok) relaysAdded += 1;
  }

  let restored = 0;
  let skipped = 0;
  let importedAsNew = 0;
  let failed = 0;
  let done = 0;

  for (const inv of account.inventories) {
    try {
      if (getHandle(inv.docId)) {
        const outcome = await restoreSnapshotInto(inv.docId, inv.parsed.snapshot, inv.parsed.photoBlobs);
        if (outcome === 'restored') restored += 1;
        else skipped += 1;
      } else {
        await importSnapshot(inv.parsed.snapshot, inv.parsed.photoBlobs);
        importedAsNew += 1;
      }
    } catch (err) {
      console.warn(`[restore] inventory ${inv.docId} failed`, err);
      failed += 1;
    }
    done += 1;
    onProgress?.(done, account.inventories.length);
  }

  return { account: accountResult, relaysAdded, restored, skipped, importedAsNew, failed };
}

export function summarizeRestore(result: AccountRestoreResult): string {
  const parts: string[] = [];
  if (result.restored > 0) parts.push(`${result.restored} restored with contents`);
  if (result.importedAsNew > 0) parts.push(`${result.importedAsNew} imported as new`);
  if (result.skipped > 0) parts.push(`${result.skipped} already here`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  const inventories = parts.length > 0 ? `Inventories: ${parts.join(', ')}` : 'Nothing to restore';
  return result.account.profileLinked ? `Account linked · ${inventories}` : inventories;
}
