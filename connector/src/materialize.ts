/**
 * Turns a synced OUTER doc (the opaque `enc:log` the relay stores, see
 * CONTRACTS.md "End-to-end encryption") into plain items.
 *
 * This is the read-only half of the app's E2eSync (app/src/store/e2ee.ts):
 * decrypt every log entry, apply to a fresh inner Y.Doc (Yjs updates are
 * idempotent and commutative, so order and duplicates are harmless), then
 * project the inner doc's `items` map onto ExtItem. No shadow doc, no
 * reconcile, no compaction — the connector never writes.
 */

import * as Y from 'yjs';
import { decryptUpdate, importContentKey } from './crypto';
import type { ExtItem, ExtPhotoRef, MoneyValue } from './types';

export const ENC_LOG_NAME = 'enc:log';

interface LogEntry {
  v?: number;
  dev?: string;
  seq?: number;
  snap?: boolean;
  iv?: Uint8Array;
  ct?: Uint8Array;
}

/**
 * Decrypts the outer doc's log into a fresh inner doc. Entries that fail to
 * decrypt (wrong key, corruption) are skipped — the rest still applies.
 * Returns the inner doc plus how many entries were skipped.
 */
export async function decryptOuterDoc(
  outer: Y.Doc,
  docId: string,
  keyB64: string,
): Promise<{ inner: Y.Doc; entries: number; skipped: number }> {
  const key = await importContentKey(keyB64);
  const inner = new Y.Doc();
  const log = outer.getArray<LogEntry>(ENC_LOG_NAME);
  let skipped = 0;
  for (const entry of log.toArray()) {
    if (!(entry?.iv instanceof Uint8Array) || !(entry.ct instanceof Uint8Array)) {
      skipped++;
      continue;
    }
    try {
      const update = await decryptUpdate(key, docId, { iv: entry.iv, ct: entry.ct });
      Y.applyUpdate(inner, update);
    } catch {
      skipped++;
    }
  }
  return { inner, entries: log.length, skipped };
}

/* ---------- inner doc -> plain items ---------- */

function asMoney(value: unknown): MoneyValue | undefined {
  const v = value as { amount?: unknown; currency?: unknown } | undefined;
  return v && typeof v.amount === 'number' && typeof v.currency === 'string'
    ? { amount: v.amount, currency: v.currency }
    : undefined;
}

function asDims(value: unknown): { l: number; w: number; h: number } | undefined {
  const v = value as { exactMm?: { l?: unknown; w?: unknown; h?: unknown } } | undefined;
  const mm = v?.exactMm;
  return mm && typeof mm.l === 'number' && typeof mm.w === 'number' && typeof mm.h === 'number'
    ? { l: mm.l, w: mm.w, h: mm.h }
    : undefined;
}

function asPhotos(value: unknown): ExtPhotoRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p): p is { hash: string; mime?: string } => typeof p?.hash === 'string')
    .map((p) => ({ hash: p.hash, mime: typeof p.mime === 'string' ? p.mime : 'image/jpeg' }));
}

/** Projects one raw item (Y.Map.toJSON()) onto the trimmed extension model. */
export function toExtItem(raw: Record<string, unknown>, docId: string): ExtItem | null {
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const weight = raw.weight as { exactGrams?: unknown } | undefined;
  const grams =
    typeof weight?.exactGrams === 'number' && weight.exactGrams > 0
      ? Math.round(weight.exactGrams)
      : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined;
  return {
    id: raw.id,
    docId,
    description: str(raw.description) ?? '',
    category: str(raw.category),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    quantity: typeof raw.quantity === 'number' ? raw.quantity : 1,
    condition: str(raw.condition),
    brandModel: str(raw.brandModel),
    notes: str(raw.notes),
    valueCurrent: asMoney(raw.valueCurrent),
    valueNew: asMoney(raw.valueNew),
    weightGrams: grams,
    dimensionsMm: asDims(raw.dimensions),
    // Only the FACT that a serial exists; the number never enters the extension.
    serialIncluded: Boolean(str(raw.serialNumber)),
    photos: asPhotos(raw.photos),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

export function readInventory(
  inner: Y.Doc,
  docId: string,
): { name: string | null; items: ExtItem[] } {
  const meta = inner.getMap<unknown>('meta');
  const name = typeof meta.get('name') === 'string' ? (meta.get('name') as string) : null;
  const items: ExtItem[] = [];
  inner.getMap<Y.Map<unknown>>('items').forEach((ymap) => {
    const item = toExtItem(ymap.toJSON() as Record<string, unknown>, docId);
    if (item) items.push(item);
  });
  items.sort((a, b) => b.createdAt - a.createdAt);
  return { name, items };
}
