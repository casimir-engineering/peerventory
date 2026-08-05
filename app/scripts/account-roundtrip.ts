/**
 * Round-trip check for the full-account backup archive (src/export/account.ts):
 * build a ZIP from fixtures, read it back, and assert the manifest and every
 * inventory folder survive.
 *
 *   npm run check:account
 */

import JSZip from 'jszip';
import { parse } from 'yaml';

import { ACCOUNT_MANIFEST_NAME, accountToZip, isAccountManifest } from '../src/export/account';
import type { InventorySnapshot } from '../src/types';

/**
 * JSZip reads Blob inputs through FileReader, which node does not provide.
 * The app runs in a browser where this exists; here a two-line stand-in is
 * enough to exercise the same code path.
 */
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null;
    onerror: ((event: { target: { error: unknown } }) => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((result) => this.onload?.({ target: { result } }))
        .catch((error: unknown) => this.onerror?.({ target: { error } }));
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`account round-trip failed: ${message}`);
}

function snapshot(id: string, name: string, itemCount: number): InventorySnapshot {
  const createdAt = Date.UTC(2026, 0, 1, 12);
  return {
    meta: { id, name, createdAt, ownerTrackingEnabled: true, currency: 'CHF' },
    boxes: [{ id: 'box0000001', label: 'Box A' }],
    savedLists: [],
    items: Array.from({ length: itemCount }, (_, i) => ({
      id: `item${id}${i}`,
      createdAt,
      updatedAt: createdAt,
      description: `Item ${i}`,
      tags: [],
      quantity: 1,
      photos:
        i === 0
          ? [{ hash: 'p'.repeat(64), mime: 'image/jpeg', role: 'photo' as const, addedAt: createdAt }]
          : [],
      locationHistory: [],
      ownerHistory: [],
      weight: { class: 'g50_200' as const },
      dimensions: { class: 'pocket' as const },
    })),
  };
}

async function main(): Promise<void> {
  const photo = new Blob(['photo bytes'], { type: 'image/jpeg' });
  const blob = await accountToZip({
    backup: 'BACKUP_PAYLOAD_BASE64URL',
    name: 'Raph',
    ownerId: 'owner0001',
    relays: ['https://inventory.example.com'],
    inventories: [
      {
        docId: 'docA',
        name: 'Shipment A',
        snapshot: snapshot('docA', 'Shipment A', 3),
        getPhotoBlob: async () => photo,
      },
      {
        docId: 'docB',
        name: 'Shipment B',
        snapshot: snapshot('docB', 'Shipment B', 1),
        getPhotoBlob: async () => null,
      },
    ],
  });
  assert(blob.size > 0, 'archive should not be empty');

  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const manifestEntry = zip.file(ACCOUNT_MANIFEST_NAME);
  assert(manifestEntry, 'account.json should exist');
  const manifest: unknown = JSON.parse(await manifestEntry.async('string'));
  assert(isAccountManifest(manifest), 'account.json should be a valid manifest');
  assert(manifest.backup === 'BACKUP_PAYLOAD_BASE64URL', 'backup payload should round-trip');
  assert(manifest.name === 'Raph', 'account name should round-trip');
  assert(manifest.relays.length === 1, 'relay list should round-trip');
  assert(manifest.inventories.length === 2, 'both inventories should be listed');
  assert(manifest.inventories[0].items === 3, 'item count should be recorded');
  assert(manifest.inventories[0].photos === 1, 'available photos should be counted');
  assert(manifest.inventories[1].photos === 0, 'missing photos should not be counted');

  for (const inv of manifest.inventories) {
    const yamlEntry = zip.file(`${inv.folder}/inventory.yaml`);
    assert(yamlEntry, `${inv.folder}/inventory.yaml should exist`);
    const doc = parse(await yamlEntry.async('string')) as {
      schemaVersion?: number;
      meta?: { id?: string };
      items?: unknown[];
    };
    assert(doc.schemaVersion === 1, 'inventory YAML should carry the schema version');
    assert(doc.meta?.id === inv.docId, 'inventory YAML should keep its docId');
    assert(doc.items?.length === inv.items, 'every item should round-trip');
    assert(zip.file(`${inv.folder}/photo-index.yaml`), 'photo index should exist');
  }

  assert(zip.file(`inventories/docA/photos/${'p'.repeat(64)}.jpg`), 'photo blob should be stored');
  assert(zip.file('README.txt'), 'README should explain the archive');

  console.log(`account round-trip OK (${(blob.size / 1024).toFixed(1)} kB archive)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
