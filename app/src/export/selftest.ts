import { Workbook } from 'exceljs';
import { parse } from 'yaml';

import type { InventorySnapshot, Item } from '../types';
import { inventoryToXlsx, type XlsxPhoto } from './xlsx';
import { inventoryToYaml } from './yaml';
import { inventoryToZip } from './zip';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Export self-test failed: ${message}`);
}

/** 1×1 white JPEG, enough to exercise the image-embedding path. */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

function tinyJpeg(): XlsxPhoto {
  // atob is global in both browsers and node >= 16.
  const binary = atob(TINY_JPEG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { data: bytes.buffer, width: 96, height: 96 };
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

  const xlsx = await inventoryToXlsx(snap, undefined, async (photo) =>
    photo.hash === photoHash ? tinyJpeg() : null,
  );
  assert(xlsx.size > 0, 'XLSX Blob should not be empty');

  // Re-read the workbook to prove the structure survives a round-trip.
  const reread = new Workbook();
  await reread.xlsx.load(await xlsx.arrayBuffer());
  const manifest = reread.getWorksheet('Manifest');
  assert(manifest, 'Manifest sheet should exist after re-read');
  const headers = (manifest.getRow(1).values as Array<string | undefined>).slice(1);
  assert(headers[0] === 'Photo' && headers[1] === 'Item name' && headers[2] === 'Qty',
    'Manifest should lead with Photo / Item name / Qty');
  assert(headers.at(-1) === 'Item ID', 'Manifest should end with Item ID');
  assert(manifest.getImages().length === 1, 'exactly one photo should be embedded');
  const dataRows = Array.from({ length: items.length }, (_, i) => manifest.getRow(2 + i));
  const laptopRow = dataRows.find((row) => row.getCell(2).value === 'Laptop computer');
  assert(laptopRow, 'laptop item should round-trip by name');
  assert(laptopRow.height > 60, 'photo rows should be tall enough to show the image');
  const laptopQuantity = laptopRow.getCell(3).value;
  assert(laptopQuantity === 1, 'manifest rows should carry the quantity');
  assert(laptopRow.getCell(5).value === 850, 'manifest rows should stay per unit');
  const totalsRow = manifest.getRow(2 + items.length);
  assert(totalsRow.getCell(2).value === `TOTALS (${items.length} items, 6 units)`,
    'totals row should count both sheets and units');
  assert(totalsRow.getCell(3).value === 6, 'totals row should sum quantities');
  // 1 × 1500 g + 2 × 20 kg (gt20kg class minimum) + 3 × 125 g (50–200 g midpoint).
  assert(totalsRow.getCell(12).value === '~41.875 kg',
    'totals row weight should multiply each item by its quantity');
  assert(reread.getWorksheet('Full data'), 'Full data sheet should survive');

  const zip = await inventoryToZip(
    snap,
    async (hash) =>
      hash === photoHash ? new Blob(['self-test photo'], { type: 'image/jpeg' }) : null,
  );
  assert(zip.size > 0, 'ZIP Blob should not be empty');
}
