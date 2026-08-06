import Database from "better-sqlite3";

import {
  authenticateDoc,
  type AccessLevel,
  type DocMeta,
} from "./auth.js";

export interface BlobReference {
  hash: string;
  mime: string;
}

interface DocMetaRow {
  rw_hash: string;
  ro_hash: string;
}

interface BlobReferenceRow {
  hash: string;
  mime: string;
}

/**
 * Lease writes are throttled: a doc's last_access_at is only bumped when the
 * stored stamp is older than this. Retention windows are measured in months,
 * so day-granularity is plenty and keeps the hot path to one cheap
 * conditional UPDATE per access.
 */
export const LEASE_THROTTLE_MS = 24 * 60 * 60 * 1000;

export class MetadataStore {
  private readonly db: Database.Database;

  private readonly readMeta;
  private readonly insertMeta;
  private readonly readBlobReference;
  private readonly upsertBlobReference;
  private readonly createMetaTransaction;
  private readonly touchLease;
  private readonly stampNullLeases;
  private readonly readLease;
  private readonly writeLease;
  private readonly selectStaleDocs;
  private readonly selectDocBlobHashes;
  private readonly countBlobRefs;
  private readonly deleteMeta;
  private readonly deleteDocumentRow;
  private readonly deleteOrphanRows;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_meta (
        doc_id TEXT PRIMARY KEY,
        rw_hash TEXT NOT NULL,
        ro_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blob_refs (
        doc_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        mime TEXT NOT NULL,
        PRIMARY KEY (doc_id, hash),
        FOREIGN KEY (doc_id) REFERENCES doc_meta(doc_id) ON DELETE CASCADE
      );
    `);
    // Lease column for garbage collection (see gc.ts). Added with ALTER so
    // existing deployments migrate in place; NULL means "never stamped",
    // which the first sweep converts to "now" (no surprise mass deletion).
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('doc_meta')")
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "last_access_at")) {
      this.db.exec("ALTER TABLE doc_meta ADD COLUMN last_access_at INTEGER");
    }
    // The Hocuspocus SQLite extension owns this table (same database file);
    // created defensively with the identical schema so the delete statements
    // below work even before the extension has connected.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "documents" (
        "name" varchar(255) NOT NULL,
        "data" blob NOT NULL,
        UNIQUE(name)
      )
    `);

    this.readMeta = this.db.prepare(
      "SELECT rw_hash, ro_hash FROM doc_meta WHERE doc_id = ?",
    );
    this.insertMeta = this.db.prepare(`
      INSERT INTO doc_meta (doc_id, rw_hash, ro_hash)
      VALUES (?, ?, ?)
      ON CONFLICT(doc_id) DO NOTHING
    `);
    this.readBlobReference = this.db.prepare(
      "SELECT hash, mime FROM blob_refs WHERE doc_id = ? AND hash = ?",
    );
    this.upsertBlobReference = this.db.prepare(`
      INSERT INTO blob_refs (doc_id, hash, mime)
      VALUES (?, ?, ?)
      ON CONFLICT(doc_id, hash) DO UPDATE SET mime = excluded.mime
    `);
    this.createMetaTransaction = this.db.transaction(
      (docId: string, meta: DocMeta): DocMeta => {
        this.insertMeta.run(docId, meta.rwHash, meta.roHash);
        const stored = this.getDocMeta(docId);
        if (!stored) {
          throw new Error("Failed to persist document metadata");
        }
        return stored;
      },
    );
    this.touchLease = this.db.prepare(`
      UPDATE doc_meta SET last_access_at = @now
      WHERE doc_id = @docId
        AND (last_access_at IS NULL OR last_access_at <= @cutoff)
    `);
    this.stampNullLeases = this.db.prepare(
      "UPDATE doc_meta SET last_access_at = ? WHERE last_access_at IS NULL",
    );
    this.readLease = this.db.prepare(
      "SELECT last_access_at FROM doc_meta WHERE doc_id = ?",
    );
    this.writeLease = this.db.prepare(
      "UPDATE doc_meta SET last_access_at = ? WHERE doc_id = ?",
    );
    this.selectStaleDocs = this.db.prepare(`
      SELECT doc_id FROM doc_meta
      WHERE last_access_at IS NOT NULL AND last_access_at < ?
    `);
    this.selectDocBlobHashes = this.db.prepare(
      "SELECT hash FROM blob_refs WHERE doc_id = ?",
    );
    this.countBlobRefs = this.db.prepare(
      "SELECT COUNT(*) AS n FROM blob_refs WHERE hash = ?",
    );
    this.deleteMeta = this.db.prepare("DELETE FROM doc_meta WHERE doc_id = ?");
    this.deleteDocumentRow = this.db.prepare(
      'DELETE FROM "documents" WHERE name = ?',
    );
    this.deleteOrphanRows = this.db.prepare(`
      DELETE FROM "documents"
      WHERE name NOT IN (SELECT doc_id FROM doc_meta)
    `);
  }

  getDocMeta(docId: string): DocMeta | null {
    const row = this.readMeta.get(docId) as DocMetaRow | undefined;
    return row ? { rwHash: row.rw_hash, roHash: row.ro_hash } : null;
  }

  authenticateAndStore(docId: string, tokenJson: string): AccessLevel | null {
    const existing = this.getDocMeta(docId);
    const initialDecision = authenticateDoc(existing, tokenJson);
    if (!initialDecision) {
      return null;
    }
    if (existing || !initialDecision.createMeta) {
      return initialDecision.level;
    }

    // INSERT OR IGNORE plus a re-check makes simultaneous first connects safe:
    // only the token matching the metadata that won the race is accepted.
    const stored = this.createMetaTransaction(docId, initialDecision.createMeta);
    return authenticateDoc(stored, tokenJson)?.level ?? null;
  }

  getBlobReference(docId: string, hash: string): BlobReference | null {
    const row = this.readBlobReference.get(docId, hash) as
      | BlobReferenceRow
      | undefined;
    return row ? { hash: row.hash, mime: row.mime } : null;
  }

  recordBlobReference(docId: string, hash: string, mime: string): void {
    this.upsertBlobReference.run(docId, hash, mime);
  }

  /* ---------- leases + deletion (see gc.ts for the sweep) ---------- */

  /** Renew a doc's lease. Throttled: no-op while the stamp is fresh. */
  touchDoc(docId: string, now = Date.now()): void {
    this.touchLease.run({ docId, now, cutoff: now - LEASE_THROTTLE_MS });
  }

  /**
   * Stamp every doc that has no lease yet (rows predating the lease column).
   * Returns how many were stamped. Running this at the start of every sweep
   * guarantees a fresh deploy never mass-deletes existing docs.
   */
  stampMissingLeases(now = Date.now()): number {
    return this.stampNullLeases.run(now).changes;
  }

  getLease(docId: string): number | null {
    const row = this.readLease.get(docId) as
      | { last_access_at: number | null }
      | undefined;
    return row?.last_access_at ?? null;
  }

  /** Direct lease write, for tests and operator tooling only. */
  setLease(docId: string, at: number): void {
    this.writeLease.run(at, docId);
  }

  /** Docs whose lease is older than the cutoff (never-stamped rows excluded). */
  listStaleDocIds(cutoff: number): string[] {
    const rows = this.selectStaleDocs.all(cutoff) as Array<{ doc_id: string }>;
    return rows.map((r) => r.doc_id);
  }

  getDocBlobHashes(docId: string): string[] {
    const rows = this.selectDocBlobHashes.all(docId) as Array<{ hash: string }>;
    return rows.map((r) => r.hash);
  }

  /** How many docs reference a blob hash (files are globally deduped). */
  blobReferenceCount(hash: string): number {
    return (this.countBlobRefs.get(hash) as { n: number }).n;
  }

  /**
   * Delete a doc's token record (cascades its blob refs) and its persisted
   * Yjs state. Returns whether the doc was known. Idempotent.
   */
  deleteDocRecords(docId: string): boolean {
    const existed = this.deleteMeta.run(docId).changes > 0;
    this.deleteDocumentRow.run(docId);
    return existed;
  }

  /**
   * Drop persisted Yjs state that has no token record — the debounced store
   * of a doc deleted while clients were still connected can re-insert its
   * row after deleteDocRecords ran. Such rows are inert (nobody can
   * authenticate against a doc without meta), this is disk hygiene.
   */
  deleteOrphanDocumentRows(): number {
    return this.deleteOrphanRows.run().changes;
  }

  close(): void {
    this.db.close();
  }
}
