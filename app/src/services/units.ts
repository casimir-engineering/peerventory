/**
 * Weight/length parsing + formatting, and per-item weight/volume derivation.
 * Pure functions, no I/O.
 */

import type { Item } from '../types';
import { SIZE_CLASSES, WEIGHT_CLASSES } from '../types';

const G_PER_LB = 453.59237;
const G_PER_OZ = 28.349523125;

/** "1,5 kg" -> { value: 1.5, unit: 'kg' }. Whitespace/case tolerant. */
function parseNumberWithUnit(input: string): { value: number; unit: string } | null {
  const m = input.trim().toLowerCase().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!isFinite(value)) return null;
  return { value, unit: m[2] ?? '' };
}

/** Accepts "200", "200g", "0.2 kg", "1,5kg", "2 lb", "3.5oz". Bare number = grams. */
export function parseWeightToGrams(input: string): number | null {
  const parsed = parseNumberWithUnit(input);
  if (!parsed) return null;
  const { value, unit } = parsed;
  switch (unit) {
    case '':
    case 'g':
    case 'gr':
    case 'gram':
    case 'grams':
      return Math.round(value);
    case 'kg':
    case 'kgs':
      return Math.round(value * 1000);
    case 'lb':
    case 'lbs':
      return Math.round(value * G_PER_LB);
    case 'oz':
      return Math.round(value * G_PER_OZ);
    default:
      return null;
  }
}

/** Accepts "300", "30cm", "0.3 m", "12in". Bare number = mm. */
export function parseLengthToMm(input: string): number | null {
  const parsed = parseNumberWithUnit(input);
  if (!parsed) return null;
  const { value, unit } = parsed;
  switch (unit) {
    case '':
    case 'mm':
      return Math.round(value);
    case 'cm':
      return Math.round(value * 10);
    case 'm':
      return Math.round(value * 1000);
    case 'in':
    case 'inch':
    case 'inches':
      return Math.round(value * 25.4);
    default:
      return null;
  }
}

/** Format with up to `decimals` places, trailing zeros stripped ("1.50" -> "1.5", "12.00" -> "12"). */
function trimmed(n: number, decimals: number): string {
  return n.toFixed(decimals).replace(/\.?0+$/, '');
}

/** 850 -> "850 g", 1500 -> "1.5 kg", 12000 -> "12 kg". */
export function formatGrams(g: number): string {
  if (g < 1000) return `${Math.round(g)} g`;
  return `${trimmed(g / 1000, 2)} kg`;
}

/** 85 -> "85 mm", 320 -> "32 cm", 1250 -> "1.25 m". */
export function formatMm(mm: number): string {
  if (mm < 100) return `${Math.round(mm)} mm`;
  if (mm < 1000) return `${trimmed(mm / 10, 1)} cm`;
  return `${trimmed(mm / 1000, 2)} m`;
}

/** Per single unit: exactGrams, or the weight-class midpoint (gt20kg -> minG). */
export function weightGramsOfItem(item: Item): { grams: number; estimated: boolean } {
  const exact = item.weight.exactGrams;
  if (typeof exact === 'number' && isFinite(exact)) return { grams: exact, estimated: false };
  const cls = WEIGHT_CLASSES[item.weight.class];
  const grams = cls.maxG === null ? cls.minG : Math.round((cls.minG + cls.maxG) / 2);
  return { grams, estimated: true };
}

/** Per single unit: exact L*W*H, or the size-class approxLiters. */
export function volumeM3OfItem(item: Item): { m3: number; estimated: boolean } {
  const exact = item.dimensions.exactMm;
  if (exact) return { m3: (exact.l * exact.w * exact.h) / 1e9, estimated: false };
  return { m3: SIZE_CLASSES[item.dimensions.class].approxLiters / 1000, estimated: true };
}
