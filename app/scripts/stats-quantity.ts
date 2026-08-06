/**
 * Quantity check for every aggregate the app shows.
 *
 * An item sheet describes ONE object: its value, weight and dimensions are per
 * unit, and `quantity` says how many of that object the sheet stands for. Any
 * total that forgets to multiply is a wrong number on a customs manifest, so
 * this exercises the real aggregation paths — the shared summariser
 * (src/services/stats.ts), the list/manifest helpers (src/ui/lib/format.ts)
 * and the spreadsheet totals row (src/export/xlsx.ts).
 *
 *   npm run check:stats
 */

import { Workbook } from 'exceljs';

import { inventoryToXlsx } from '../src/export/xlsx';
import {
  itemValueTotal,
  itemVolumeM3,
  itemWeightGrams,
  summarizeItems,
  unitCount,
} from '../src/services/stats';
import {
  itemCountLabel,
  lineValueDisplay,
  lineWeightDisplay,
  totalWeightGrams,
  totalsByCurrency,
} from '../src/ui/lib/format';
import type { InventorySnapshot, Item } from '../src/types';

/** convert() reads its rate table from localStorage; node has none of its own. */
function installRates(rates: Record<string, number>): void {
  const store = new Map<string, string>();
  store.set('fx:v1', JSON.stringify({ fetchedAt: Date.now(), rates }));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

let checks = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  if (!Object.is(actual, expected)) {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Currency symbols and separators are locale-dependent; the digits are not. */
function has(name: string, actual: string | null | undefined, needle: string): void {
  checks += 1;
  if (!actual || !actual.includes(needle)) {
    failures.push(`${name}: expected ${JSON.stringify(actual)} to contain ${JSON.stringify(needle)}`);
  }
}

/** Floating point sums need a tolerance; anything looser would hide a ×n bug. */
function near(name: string, actual: number, expected: number, epsilon = 1e-9): void {
  checks += 1;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > epsilon) {
    failures.push(`${name}: expected ~${expected}, got ${actual}`);
  }
}

const baseTime = Date.UTC(2026, 0, 1, 12);

function item(fields: Partial<Item> & Pick<Item, 'id' | 'quantity'>): Item {
  return {
    createdAt: baseTime,
    updatedAt: baseTime,
    description: `Item ${fields.id}`,
    tags: [],
    photos: [],
    locationHistory: [],
    ownerHistory: [],
    weight: { class: 'kg1_2', exactGrams: 1_000 },
    dimensions: { class: 'shoebox', exactMm: { l: 100, w: 100, h: 100 } },
    ...fields,
  };
}

// 1 USD = 2 EUR keeps the converted arithmetic checkable by hand.
installRates({ USD: 1, EUR: 2 });

/* ------------------------------------------------------- unit normalisation */

eq('quantity 1', unitCount({ quantity: 1 }), 1);
eq('quantity 4', unitCount({ quantity: 4 }), 4);
eq('missing quantity counts as one unit', unitCount({} as Item), 1);
eq('zero quantity counts as one unit', unitCount({ quantity: 0 }), 1);
eq('negative quantity counts as one unit', unitCount({ quantity: -3 }), 1);
eq('NaN quantity counts as one unit', unitCount({ quantity: Number.NaN }), 1);
eq('fractional quantity rounds', unitCount({ quantity: 2.4 }), 2);

/* ------------------------------------------------------------- per-item ×n */

const threeLaptops = item({
  id: 'item000001',
  quantity: 3,
  valueCurrent: { amount: 850, currency: 'USD' },
  valueNew: { amount: 1_400, currency: 'USD' },
  weight: { class: 'kg1_2', exactGrams: 1_500 },
  dimensions: { class: 'carryon', exactMm: { l: 300, w: 200, h: 20 } },
});

eq('line total multiplies value', itemValueTotal(threeLaptops)?.amount, 2_550);
eq('line total keeps the currency', itemValueTotal(threeLaptops)?.currency, 'USD');
eq('line total for value when new', itemValueTotal(threeLaptops, 'valueNew')?.amount, 4_200);
eq('line weight multiplies', itemWeightGrams(threeLaptops).grams, 4_500);
eq('exact weight is not an estimate', itemWeightGrams(threeLaptops).estimated, false);
near('line volume multiplies', itemVolumeM3(threeLaptops).m3, 0.0036);
eq('unpriced item has no line total', itemValueTotal(item({ id: 'x', quantity: 5 })), null);

// Class-only figures are estimates, and estimates multiply too:
// gt20kg midpoint is its 20 kg minimum, oversize is 200 L.
const twoCrates = item({
  id: 'item000002',
  quantity: 2,
  weight: { class: 'gt20kg' },
  dimensions: { class: 'oversize' },
});
eq('estimated weight multiplies', itemWeightGrams(twoCrates).grams, 40_000);
eq('estimated weight stays flagged', itemWeightGrams(twoCrates).estimated, true);
near('estimated volume multiplies', itemVolumeM3(twoCrates).m3, 0.4);

/* ------------------------------------------------------------ whole totals */

const items: Item[] = [
  threeLaptops,
  twoCrates,
  item({
    id: 'item000003',
    quantity: 4,
    valueCurrent: { amount: 100, currency: 'EUR' },
    weight: { class: 'g500_1k', exactGrams: 250 },
    dimensions: { class: 'pocket', exactMm: { l: 50, w: 50, h: 40 } },
  }),
];

const totals = summarizeItems(items, 'USD');

eq('item count stays the number of sheets', totals.itemCount, 3);
eq('unit count sums the quantities', totals.unitCount, 9);
eq('total weight multiplies every item', totals.weightGrams, 45_500);
eq('a single class-only item makes the total an estimate', totals.weightEstimated, true);
// 3 × 0.0012 + 2 × 0.2 (oversize class) + 4 × 0.0001 m³.
near('total volume multiplies every item', totals.volumeM3, 0.404);
eq('volume is an estimate when a size class is used', totals.volumeEstimated, true);
// 3 × 850 USD + 4 × 100 EUR at 2 EUR per USD = 2550 + 200 USD.
near('converted total multiplies before converting', totals.currentValue.converted, 2_750);
eq('every priced item was counted', totals.currentValue.valuedCount, 2);
eq('nothing was left unconverted', totals.currentValue.unconverted.length, 0);
near('value when new multiplies too', totals.newValue.converted, 4_200);

const noRates = summarizeItems(items, 'CHF');
eq('unknown currencies stay in their own line', noRates.currentValue.unconverted.length, 2);
near(
  'unconverted lines are line totals, not unit prices',
  noRates.currentValue.unconverted.find((line) => line.currency === 'USD')?.amount ?? 0,
  2_550,
);

/* --------------------------------------------------- list / manifest helpers */

eq('list weight total multiplies', totalWeightGrams(items), 45_500);
const byCurrency = totalsByCurrency(items, 'valueCurrent');
near(
  'per-currency total multiplies (USD)',
  byCurrency.find((line) => line.currency === 'USD')?.amount ?? 0,
  2_550,
);
near(
  'per-currency total multiplies (EUR)',
  byCurrency.find((line) => line.currency === 'EUR')?.amount ?? 0,
  400,
);
eq('one unit per item reads as items only', itemCountLabel(3, 3), '3 items');
eq('more units than items reads as both', itemCountLabel(3, 9), '3 items (9 units)');
eq('a single item still reads naturally', itemCountLabel(1, 1), '1 item');

/* ------------------------------------------------------------- row displays */

// A card or list row is read as "what is this line worth", so it leads with the
// line total; the unit price trails it and the conversion follows the total.
const laptopValueRow = lineValueDisplay(threeLaptops, 'EUR');
has('row leads with the line total', laptopValueRow?.total, '2,550');
has('row keeps the unit price as a hint', laptopValueRow?.perUnit, '850');
has('the unit price hint says it is per unit', laptopValueRow?.perUnit, 'each');
has('the conversion converts the total, not the unit price', laptopValueRow?.conversion, '5,100');
eq('the row knows how many units it stands for', laptopValueRow?.units, 3);

const singleLaptop = item({
  id: 'item000004',
  quantity: 1,
  valueCurrent: { amount: 850, currency: 'USD' },
});
const singleRow = lineValueDisplay(singleLaptop, 'USD');
has('a one-unit row still shows its value', singleRow?.total, '850');
eq('a one-unit row has nothing to say per unit', singleRow?.perUnit, null);
eq('a one-unit row in the main currency needs no conversion', singleRow?.conversion, null);
eq('an unpriced row has no money to show', lineValueDisplay(item({ id: 'y', quantity: 3 }), 'USD'), null);

eq('row weight leads with the line total', lineWeightDisplay(threeLaptops).total, '4.50 kg');
eq('row weight keeps the unit weight', lineWeightDisplay(threeLaptops).perUnit, '1.50 kg each');
eq('an estimated line weight stays marked', lineWeightDisplay(twoCrates).total, '~40.0 kg');
eq('an estimated unit weight keeps its class', lineWeightDisplay(twoCrates).perUnit, '> 20 kg each');
eq('a one-unit row shows its own weight', lineWeightDisplay(singleLaptop).total, '1.00 kg');
eq('a one-unit row has nothing to say per unit (weight)',
  lineWeightDisplay(singleLaptop).perUnit, null);

/* ------------------------------------------------------- spreadsheet totals */

const snap: InventorySnapshot = {
  meta: {
    id: 'inventory1',
    name: 'Quantity check',
    createdAt: baseTime,
    ownerTrackingEnabled: true,
    currency: 'USD',
  },
  boxes: [],
  savedLists: [],
  items,
};

const workbook = new Workbook();
await workbook.xlsx.load(await (await inventoryToXlsx(snap)).arrayBuffer());
const manifest = workbook.getWorksheet('Manifest');
if (!manifest) throw new Error('stats quantity check failed: Manifest sheet is missing');

// Column keys do not survive a save/load round-trip, so address by position.
const NAME_COL = 2;
const QTY_COL = 3;
const VALUE_COL = 5;
const WEIGHT_COL = 12;

// Rows stay per unit — that is the customs-correct format, with Qty alongside.
const laptopRow = manifest.getRow(2);
eq('manifest row keeps the per-unit value', laptopRow.getCell(VALUE_COL).value, 850);
eq('manifest row carries the quantity', laptopRow.getCell(QTY_COL).value, 3);

const totalsRow = manifest.getRow(2 + items.length);
eq('totals row names items and units', totalsRow.getCell(NAME_COL).value,
  `TOTALS (${items.length} items, 9 units)`);
eq('totals row sums quantities', totalsRow.getCell(QTY_COL).value, 9);
near('totals row multiplies value', Number(totalsRow.getCell(VALUE_COL).value), 2_750);
eq('totals row multiplies weight', totalsRow.getCell(WEIGHT_COL).value, '~45.5 kg');

/* -------------------------------------------------------------------- done */

if (failures.length > 0) {
  console.error(`stats quantity check: ${failures.length} of ${checks} failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`stats quantity check: ${checks} checks passed`);
