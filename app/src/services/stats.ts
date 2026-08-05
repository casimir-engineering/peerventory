/**
 * Aggregation over items. Pure functions, no I/O.
 *
 * An item sheet describes ONE object: its value, weight and dimensions are all
 * per unit. `quantity` says how many identical units that sheet stands for, so
 * every total here multiplies the per-unit figure by the unit count. Keeping
 * that multiplication in one place is what stops a new total from forgetting it.
 */

import { convert } from './currency';
import { volumeM3OfItem, weightGramsOfItem } from './units';
import type { Item, MoneyValue } from '../types';

export type ValueField = 'valueCurrent' | 'valueNew';

/** How many physical units an item sheet stands for. Never below 1. */
export function unitCount(item: Pick<Item, 'quantity'>): number {
  const raw = item.quantity;
  return Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 1;
}

/** Weight of every unit of this item together. */
export function itemWeightGrams(item: Item): { grams: number; estimated: boolean } {
  const per = weightGramsOfItem(item);
  return {
    grams: Number.isFinite(per.grams) ? per.grams * unitCount(item) : 0,
    estimated: per.estimated,
  };
}

/** Volume of every unit of this item together. */
export function itemVolumeM3(item: Item): { m3: number; estimated: boolean } {
  const per = volumeM3OfItem(item);
  return {
    m3: Number.isFinite(per.m3) ? per.m3 * unitCount(item) : 0,
    estimated: per.estimated,
  };
}

/** The line total for an item: per-unit value × units. Null when unpriced. */
export function itemValueTotal(item: Item, field: ValueField = 'valueCurrent'): MoneyValue | null {
  const value = item[field];
  if (!value || !Number.isFinite(value.amount)) return null;
  return { amount: value.amount * unitCount(item), currency: value.currency };
}

export interface ValueSummary {
  /** Sum of the line totals that could be converted, in the main currency. */
  converted: number;
  convertedCount: number;
  /** Items carrying a usable amount, converted or not. */
  valuedCount: number;
  /** Line totals left in their own currency, one entry per currency. */
  unconverted: Array<{ currency: string; amount: number }>;
}

/** Sums line totals, converting to `mainCurrency` where a rate is known. */
export function summarizeValue(
  items: Item[],
  field: ValueField,
  mainCurrency: string,
): ValueSummary {
  let converted = 0;
  let convertedCount = 0;
  let valuedCount = 0;
  const unconverted = new Map<string, number>();

  for (const item of items) {
    const total = itemValueTotal(item, field);
    if (!total) continue;
    valuedCount += 1;
    const currency = total.currency?.trim().toUpperCase();
    const inMain = currency ? convertToCurrency(total.amount, currency, mainCurrency) : null;
    if (inMain === null) {
      const label = currency || 'No currency';
      unconverted.set(label, (unconverted.get(label) ?? 0) + total.amount);
    } else {
      converted += inMain;
      convertedCount += 1;
    }
  }

  return {
    converted,
    convertedCount,
    valuedCount,
    unconverted: [...unconverted.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

/** Same currency needs no rate; anything unknown stays unconverted. */
function convertToCurrency(amount: number, from: string, to: string): number | null {
  const target = (to ?? '').trim().toUpperCase();
  if (!from || !target) return null;
  if (from === target) return amount;
  const result = convert(amount, from, target);
  return result !== null && Number.isFinite(result) ? result : null;
}

export interface ItemsSummary {
  /** Item sheets. Distinct from units: one sheet can stand for many units. */
  itemCount: number;
  /** Physical units, i.e. the sum of the quantities. */
  unitCount: number;
  weightGrams: number;
  weightEstimated: boolean;
  volumeM3: number;
  volumeEstimated: boolean;
  currentValue: ValueSummary;
  newValue: ValueSummary;
}

export function summarizeItems(items: Item[], mainCurrency: string): ItemsSummary {
  let units = 0;
  let weightGrams = 0;
  let weightEstimated = false;
  let volumeM3 = 0;
  let volumeEstimated = false;

  for (const item of items) {
    units += unitCount(item);
    const weight = itemWeightGrams(item);
    weightGrams += weight.grams;
    weightEstimated ||= weight.estimated;
    const volume = itemVolumeM3(item);
    volumeM3 += volume.m3;
    volumeEstimated ||= volume.estimated;
  }

  return {
    itemCount: items.length,
    unitCount: units,
    weightGrams,
    weightEstimated,
    volumeM3,
    volumeEstimated,
    currentValue: summarizeValue(items, 'valueCurrent', mainCurrency),
    newValue: summarizeValue(items, 'valueNew', mainCurrency),
  };
}
