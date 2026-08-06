/**
 * Lease-based garbage collection. The relay is blind (ciphertext only), so
 * it cannot see tombstones or "this inventory was forgotten" — instead every
 * authenticated access (sync connect, blob GET/PUT/HEAD) renews a per-doc
 * lease (doc_meta.last_access_at, throttled writes), and a periodic sweep
 * deletes whatever no client has touched for the retention window: the doc's
 * Yjs state, its token record and its blobs. A doc any device still cares
 * about is re-touched long before the window expires; a doc every peer
 * forgot ages out on its own.
 *
 * Complemented by the explicit DELETE /api/docs/:docId endpoint (http.ts),
 * which uses the same deleteDocData below for immediate removal.
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import type { MetadataStore } from "./storage.js";

export interface DeleteDocResult {
  /** The doc had a token record before this call. */
  existed: boolean;
  /** Blob files removed (only those no other doc references). */
  blobsDeleted: number;
}

/**
 * Remove everything the relay holds for a doc: token record, persisted Yjs
 * state, blob references, and any blob file no other doc references (files
 * are content-addressed and globally deduped). Idempotent.
 */
export async function deleteDocData(
  metadata: MetadataStore,
  blobDir: string,
  docId: string,
): Promise<DeleteDocResult> {
  const hashes = metadata.getDocBlobHashes(docId);
  const existed = metadata.deleteDocRecords(docId);
  let blobsDeleted = 0;
  for (const hash of hashes) {
    if (metadata.blobReferenceCount(hash) > 0) continue;
    try {
      await unlink(join(blobDir, hash.slice(0, 2), hash));
      blobsDeleted++;
    } catch {
      // already gone (or never written) — deletion stays idempotent
    }
  }
  return { existed, blobsDeleted };
}

export interface SweepOptions {
  metadata: MetadataStore;
  blobDir: string;
  /** Docs untouched for longer than this are deleted. */
  retentionMs: number;
  now?: number;
  logger?: Pick<Console, "info" | "error">;
  /** Called before a doc's data is removed (used to close live connections). */
  onDocDeleted?: (docId: string) => void;
}

export interface SweepResult {
  /** Pre-lease-column docs stamped "now" instead of being considered stale. */
  stamped: number;
  docsDeleted: number;
  blobsDeleted: number;
  orphanRowsDeleted: number;
}

/**
 * One garbage-collection pass. Logs deletion COUNTS only — doc ids are the
 * only identifier the relay has and they stay out of the logs.
 */
export async function sweepStaleDocs(options: SweepOptions): Promise<SweepResult> {
  const { metadata, blobDir, retentionMs, onDocDeleted } = options;
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now();

  // Docs from before the lease column (or restored backups) start their
  // lease NOW: a fresh deploy must never mass-delete on its first sweep.
  const stamped = metadata.stampMissingLeases(now);

  const stale = metadata.listStaleDocIds(now - retentionMs);
  let docsDeleted = 0;
  let blobsDeleted = 0;
  for (const docId of stale) {
    try {
      onDocDeleted?.(docId);
      const result = await deleteDocData(metadata, blobDir, docId);
      if (result.existed) docsDeleted++;
      blobsDeleted += result.blobsDeleted;
    } catch (error) {
      logger.error("[gc] failed to delete a stale doc", error);
    }
  }
  const orphanRowsDeleted = metadata.deleteOrphanDocumentRows();

  logger.info(
    `[gc] sweep: stamped=${stamped} docsDeleted=${docsDeleted} ` +
      `blobsDeleted=${blobsDeleted} orphanRows=${orphanRowsDeleted}`,
  );
  return { stamped, docsDeleted, blobsDeleted, orphanRowsDeleted };
}
