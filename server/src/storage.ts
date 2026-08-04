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

export class MetadataStore {
  private readonly db: Database.Database;

  private readonly readMeta;
  private readonly insertMeta;
  private readonly readBlobReference;
  private readonly upsertBlobReference;
  private readonly createMetaTransaction;

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

  close(): void {
    this.db.close();
  }
}
