import { parse } from 'yaml';

import type { InventorySnapshot, Item } from '../types';
import { inventoryToXlsx } from './xlsx';
import { inventoryToYaml } from './yaml';
import { inventoryToZip } from './zip';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Export self-test failed: ${message}`);
}

export async function runExportSelftest(): Promise<void> {
  const baseTime = Date.UTC(2026, 0, 1, 12);
  const photoHash = 'a'.repeat(64);
  const items: Item[] = [
    {
      id: 'item000001',
      createdAt: baseTime,
      updatedAt: baseTime + 1_000,
      description: 'Laptop computer',
      category: 'Electronics',
      tags: ['computer', 'work'],
      quantity: 1,
      valueCurrent: { amount: 850, currency: 'USD' },
      valueNew: { amount: 1_400, currency: 'USD' },
      photos: [
        {
          hash: photoHash,
          mime: 'image/jpeg',
          role: 'serial_label',
          addedAt: baseTime,
        },
      ],
      locationHistory: [
        { time: baseTime, lat: 51.9244, lon: 4.4777, label: 'Rotterdam' },
      ],
      ownerHistory: [{ time: baseTime, owner: 'Alex' }],
      weight: { class: 'kg1_2', exactGrams: 1_500 },
      dimensions: { class: 'carryon', exactMm: { l: 310, w: 220, h: 18 } },
      serialNumber: 'TEST-SERIAL',
      boxId: 'box0000001',
      lithiumBattery: true,
      countryOfOrigin: 'CN',
      condition: 'Used',
      brandModel: 'ExampleBook 14',
    },
    {
      id: 'item000002',
      createdAt: baseTime + 2_000,
      updatedAt: baseTime + 2_000,
      description: 'Floor speaker pair',
      tags: ['audio'],
      quantity: 2,
      valueCurrent: { amount: 125.5, currency: 'EUR' },
      photos: [],
      locationHistory: [],
      ownerHistory: [],
      weight: { class: 'gt20kg' },
      dimensions: { class: 'oversize' },
      notes: 'Class-only weight exercises estimated totals.',
    },
    {
      id: 'item000003',
      createdAt: baseTime + 4_000,
      updatedAt: baseTime + 4_000,
      description: 'Unvalued cable',
      tags: [],
      quantity: 3,
      photos: [],
      locationHistory: [],
      ownerHistory: [],
      weight: { class: 'g50_200' },
      dimensions: { class: 'pocket' },
    },
  ];
  const snap: InventorySnapshot = {
    meta: {
      id: 'inventory1',
      name: 'Export self-test',
      createdAt: baseTime,
      ownerTrackingEnabled: true,
      currency: 'USD',
    },
    boxes: [{ id: 'box0000001', label: 'Box A' }],
    savedLists: [
      {
        id: 'saved00001',
        name: 'Electronics',
        itemIds: ['item000001'],
        createdAt: baseTime,
      },
    ],
    items,
  };

  const yaml = inventoryToYaml(snap);
  const parsed = parse(yaml) as {
    schemaVersion?: unknown;
    items?: Array<{ id?: unknown }>;
  };
  assert(yaml.length > 0, 'YAML should not be empty');
  assert(parsed.schemaVersion === 1, 'YAML schema version should round-trip');
  assert(parsed.items?.length === 3, 'all items should round-trip through YAML.parse');
  assert(parsed.items[0]?.id === 'item000001', 'YAML items should retain creation order');

  const xlsx = await inventoryToXlsx(snap);
  assert(xlsx.size > 0, 'XLSX Blob should not be empty');

  const zip = await inventoryToZip(
    snap,
    async (hash) =>
      hash === photoHash ? new Blob(['self-test photo'], { type: 'image/jpeg' }) : null,
  );
  assert(zip.size > 0, 'ZIP Blob should not be empty');
}
