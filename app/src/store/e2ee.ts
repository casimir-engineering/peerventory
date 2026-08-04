/**
 * End-to-end encrypted sync wrapper. See CONTRACTS.md ("End-to-end encryption").
 *
 * The relay never sees inventory content: the Hocuspocus provider syncs an
 * OUTER Y.Doc whose only content is `enc:log`, a Y.Array of AES-GCM-encrypted
 * Yjs update chunks of the INNER doc (the real inventory doc, persisted
 * locally in y-indexeddb). This class bridges the two:
 *
 * - local inner-doc edits -> encrypt -> append to the log
 * - new log entries (from the server or outer idb) -> decrypt -> apply to inner
 * - a SHADOW doc mirrors exactly the state representable from the log, so a
 *   state-vector diff (inner vs shadow) pushes anything the log is missing
 *   (e.g. edits made before the wrapper started, or a lost outer idb)
 * - compaction: when the log grows past thresholds, the writer that appended
 *   the last entry replaces all entries it has decrypted with one encrypted
 *   full-state snapshot. Concurrent compactions are safe: Y.Array keeps every
 *   concurrently-inserted entry, and applying two full snapshots is a no-op
 *   merge. Entries this client could not decrypt are never deleted.
 */
import * as Y from 'yjs';
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import type { Id } from '../types';
import { getDeviceId } from './device';
import {
  decryptUpdate,
  encryptUpdate,
  importContentKey,
  type DocKey,
} from './crypto';

export const ENC_LOG_NAME = 'enc:log';
const COMPACT_MAX_ENTRIES = 40;
const COMPACT_MAX_BYTES = 400_000;

/** Origin used when applying decrypted remote updates to the inner doc. */
export const E2EE_REMOTE_ORIGIN = Symbol('e2ee-remote');
/** Origin of this client's own writes to the outer log. */
const LOG_ORIGIN = Symbol('e2ee-log');

interface LogEntry {
  v: 1;
  dev: string;
  seq: number;
  /** Entry is a full-state snapshot written by compaction. */
  snap?: boolean;
  iv: Uint8Array;
  ct: Uint8Array;
}

export function outerDocName(docId: Id): string {
  return 'enc:' + docId;
}

/** An empty Yjs update encodes to exactly [0, 0] (no structs, no deletes). */
function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length <= 2;
}

export class E2eSync {
  readonly outer: Y.Doc;
  readonly outerIdb: IndexeddbPersistence;

  private readonly shadow: Y.Doc;
  private key: DocKey | null = null;
  /** Entries already processed this session (decrypted, ours, or given up on). */
  private readonly applied = new Set<string>();
  /** Entries whose plaintext is represented in the shadow doc; only these may be compacted away. */
  private readonly deletable = new Set<string>();
  private readonly dev = getDeviceId();
  private seq = Date.now();
  /** Serializes all async crypto/log work so scans and appends never interleave. */
  private chain: Promise<void> = Promise.resolve();
  private destroyed = false;
  private started = false;

  private readonly innerUpdateHandler = (update: Uint8Array, origin: unknown): void => {
    // Skip updates we applied ourselves and the inner idb's load replay; both
    // are already represented in the log (or reconciled by the state diff).
    if (origin === E2EE_REMOTE_ORIGIN || origin === this.innerIdb) return;
    const copy = new Uint8Array(update);
    this.enqueue(() => this.appendUpdate(copy, false));
  };

  private readonly logObserver = (): void => {
    this.enqueue(() => this.scanLog());
  };

  constructor(
    private readonly docId: Id,
    private readonly inner: Y.Doc,
    private readonly innerIdb: IndexeddbPersistence,
    private readonly keyB64: string,
    private readonly opts: {
      canWrite: () => boolean;
      onChange?: () => void;
      onError?: (err: unknown) => void;
    },
  ) {
    this.outer = new Y.Doc({ guid: outerDocName(docId) });
    this.outerIdb = new IndexeddbPersistence(outerDocName(docId), this.outer);
    this.shadow = new Y.Doc();
  }

  private log(): Y.Array<LogEntry> {
    return this.outer.getArray<LogEntry>(ENC_LOG_NAME);
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.destroyed ? undefined : task()))
      .catch((err) => {
        console.warn('[e2ee] pipeline error', err);
        this.opts.onError?.(err);
      });
  }

  /** Import the key, replay the persisted log, then start live bridging. */
  async start(): Promise<void> {
    this.key = await importContentKey(this.keyB64);
    await this.outerIdb.whenSynced;
    await this.innerIdb.whenSynced;
    if (this.destroyed) return;
    this.log().observe(this.logObserver);
    this.inner.on('update', this.innerUpdateHandler);
    this.started = true;
    this.enqueue(async () => {
      await this.scanLog();
      await this.reconcile();
    });
    await this.chain;
  }

  /** Called when the provider reports the outer doc synced with the server. */
  onServerSynced(): void {
    if (!this.started) return;
    this.enqueue(async () => {
      await this.scanLog();
      await this.reconcile();
    });
  }

  private entryId(e: LogEntry): string {
    return `${e.dev}:${e.seq}`;
  }

  /** Decrypt and apply every log entry not seen yet (idempotent). */
  private async scanLog(): Promise<void> {
    const key = this.key;
    if (!key) return;
    const entries = this.log().toArray();
    let appliedAny = false;
    for (const entry of entries) {
      if (!entry || typeof entry.dev !== 'string' || typeof entry.seq !== 'number') continue;
      const id = this.entryId(entry);
      if (this.applied.has(id)) continue;
      try {
        const update = await decryptUpdate(key, this.docId, { iv: entry.iv, ct: entry.ct });
        Y.applyUpdate(this.shadow, update);
        Y.applyUpdate(this.inner, update, E2EE_REMOTE_ORIGIN);
        this.applied.add(id);
        this.deletable.add(id);
        appliedAny = true;
      } catch (err) {
        // Wrong key or corrupt entry: leave it (and never delete it in
        // compaction); the rest of the log still applies.
        console.warn(`[e2ee] cannot decrypt log entry ${id} of ${this.docId}`, err);
        this.applied.add(id); // do not retry forever; a re-open retries
      }
    }
    if (appliedAny) this.opts.onChange?.();
  }

  /** Push any inner-doc state the log does not represent yet. */
  private async reconcile(): Promise<void> {
    const diff = Y.encodeStateAsUpdate(this.inner, Y.encodeStateVector(this.shadow));
    if (isEmptyUpdate(diff)) return;
    await this.appendUpdate(diff, false);
  }

  private async appendUpdate(update: Uint8Array, isSnapshot: boolean): Promise<void> {
    const key = this.key;
    if (!key || isEmptyUpdate(update)) return;
    if (!this.opts.canWrite()) {
      // Read-only holders can decrypt but must not append; the server drops
      // their writes anyway. Their local (impossible in the UI) edits stay local.
      return;
    }
    const { iv, ct } = await encryptUpdate(key, this.docId, update);
    const entry: LogEntry = {
      v: 1,
      dev: this.dev,
      seq: ++this.seq,
      ...(isSnapshot ? { snap: true } : {}),
      iv,
      ct,
    };
    this.applied.add(this.entryId(entry));
    this.deletable.add(this.entryId(entry));
    Y.applyUpdate(this.shadow, update);
    this.outer.transact(() => {
      this.log().push([entry]);
    }, LOG_ORIGIN);
    if (!isSnapshot) await this.compactIfNeeded();
  }

  /**
   * Replace all decrypted entries with one full-state snapshot when the log
   * gets big. Only the author of the last entry compacts, which avoids most
   * concurrent double-compactions (a residual race is harmless, see header).
   */
  private async compactIfNeeded(): Promise<void> {
    const key = this.key;
    if (!key || !this.opts.canWrite()) return;
    const log = this.log();
    const entries = log.toArray();
    if (entries.length === 0) return;
    const last = entries[entries.length - 1];
    if (!last || last.dev !== this.dev) return;
    let bytes = 0;
    for (const e of entries) bytes += e?.ct?.byteLength ?? 0;
    if (entries.length <= COMPACT_MAX_ENTRIES && bytes <= COMPACT_MAX_BYTES) return;

    const snapshot = Y.encodeStateAsUpdate(this.shadow);
    const { iv, ct } = await encryptUpdate(key, this.docId, snapshot);
    const entry: LogEntry = { v: 1, dev: this.dev, seq: ++this.seq, snap: true, iv, ct };
    this.applied.add(this.entryId(entry));
    this.deletable.add(this.entryId(entry));
    this.outer.transact(() => {
      // Delete from the end so indices stay valid; keep undecryptable entries.
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log.get(i);
        if (e && this.deletable.has(this.entryId(e))) log.delete(i, 1);
      }
      log.push([entry]);
    }, LOG_ORIGIN);
  }

  async destroy(opts?: { clearData?: boolean }): Promise<void> {
    this.destroyed = true;
    if (this.started) {
      try {
        this.log().unobserve(this.logObserver);
      } catch { /* outer doc may already be gone */ }
      this.inner.off('update', this.innerUpdateHandler);
    }
    if (opts?.clearData) await this.outerIdb.clearData().catch(() => {});
    else await this.outerIdb.destroy().catch(() => {});
    this.outer.destroy();
    this.shadow.destroy();
  }
}

/** Wipe the locally persisted outer doc of an inventory (forget flow). */
export async function clearOuterDoc(docId: Id): Promise<void> {
  await clearDocument(outerDocName(docId)).catch(() => {});
}
