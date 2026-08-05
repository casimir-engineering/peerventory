/**
 * Tiny manual self-test for the pure parts of the services layer.
 * Run from the browser console: `runServicesSelftest()`.
 * The places test uses localStorage but snapshots/restores `places:v1`.
 */

import { formatGrams, formatMm, parseLengthToMm, parseWeightToGrams } from './units';
import { nearestPlaceLabel, rememberPlace } from './geocode';
import { summarizeItems, unitCount } from './stats';
import type { Item } from '../types';

export function runServicesSelftest(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;
  const eq = (name: string, actual: unknown, expected: unknown) => {
    if (Object.is(actual, expected)) passed++;
    else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  // weight parsing
  eq('bare grams', parseWeightToGrams('850'), 850);
  eq('unit g', parseWeightToGrams('200 g'), 200);
  eq('uppercase kg', parseWeightToGrams('0.2KG'), 200);
  eq('comma decimal kg', parseWeightToGrams('1,5 kg'), 1500);
  eq('no-space kg', parseWeightToGrams('1.5kg'), 1500);
  eq('pounds', parseWeightToGrams('2lb'), 907);
  eq('ounces', parseWeightToGrams('3.5oz'), 99);
  eq('padded input', parseWeightToGrams('  2 LB '), 907);
  eq('garbage', parseWeightToGrams('heavy'), null);
  eq('unknown unit', parseWeightToGrams('3 stone'), null);
  eq('empty', parseWeightToGrams(''), null);

  // length parsing
  eq('bare mm', parseLengthToMm('300'), 300);
  eq('cm', parseLengthToMm('30cm'), 300);
  eq('m with space', parseLengthToMm('0.3 m'), 300);
  eq('inches', parseLengthToMm('12in'), 305);
  eq('comma decimal m', parseLengthToMm('1,25m'), 1250);
  eq('length garbage', parseLengthToMm('long'), null);

  // formatting
  eq('format 850g', formatGrams(850), '850 g');
  eq('format 1500g', formatGrams(1500), '1.5 kg');
  eq('format 12000g', formatGrams(12000), '12 kg');
  eq('format 999g', formatGrams(999), '999 g');
  eq('format 1000g', formatGrams(1000), '1 kg');
  eq('format 85mm', formatMm(85), '85 mm');
  eq('format 320mm', formatMm(320), '32 cm');
  eq('format 1250mm', formatMm(1250), '1.25 m');
  eq('format 99mm', formatMm(99), '99 mm');
  eq('format 100mm', formatMm(100), '10 cm');
  eq('format 1000mm', formatMm(1000), '1 m');

  // quantity-aware totals: an item sheet is one object, quantity says how many
  const sheet = (quantity: number, amount: number, grams: number): Item => ({
    id: `item${quantity}`,
    createdAt: 0,
    updatedAt: 0,
    description: 'Self-test item',
    tags: [],
    quantity,
    valueCurrent: { amount, currency: 'USD' },
    photos: [],
    locationHistory: [],
    ownerHistory: [],
    weight: { class: 'kg1_2', exactGrams: grams },
    dimensions: { class: 'shoebox', exactMm: { l: 100, w: 100, h: 100 } },
  });
  eq('unit count of a plain item', unitCount(sheet(1, 10, 100)), 1);
  eq('unit count never drops below one', unitCount(sheet(0, 10, 100)), 1);
  const totals = summarizeItems([sheet(1, 10, 100), sheet(4, 25, 250)], 'USD');
  eq('item count counts sheets', totals.itemCount, 2);
  eq('unit count sums quantities', totals.unitCount, 5);
  eq('value total multiplies by quantity', totals.currentValue.converted, 110);
  eq('weight total multiplies by quantity', totals.weightGrams, 1100);
  eq('volume total multiplies by quantity', Number(totals.volumeM3.toFixed(6)), 0.005);

  // nearestPlaceLabel haversine math (isolated from real saved places)
  const saved = localStorage.getItem('places:v1');
  try {
    localStorage.removeItem('places:v1');
    rememberPlace('Office', 52.52, 13.405);
    rememberPlace('Warehouse', 52.6, 13.5);
    // ~111 m north of Office (0.001 deg latitude)
    eq('nearest within 250m', nearestPlaceLabel(52.521, 13.405), 'Office');
    // ~111 m is outside a 50 m threshold
    eq('nearest outside 50m', nearestPlaceLabel(52.521, 13.405, 50), null);
    eq('nearest exact point', nearestPlaceLabel(52.6, 13.5), 'Warehouse');
    // ~1.1 km away from anything
    eq('nearest nothing close', nearestPlaceLabel(52.53, 13.405), null);
  } finally {
    if (saved === null) localStorage.removeItem('places:v1');
    else localStorage.setItem('places:v1', saved);
  }

  const result = { passed, failed: failures.length, failures };
  console.log(`services selftest: ${passed} passed, ${failures.length} failed`, failures);
  return result;
}
