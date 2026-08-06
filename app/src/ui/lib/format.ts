/** Formatting and aggregation helpers shared by the item, list and export views. */

import { SIZE_CLASSES, WEIGHT_CLASSES } from '../../types';
import type { Dimensions, Item, MoneyValue, Weight } from '../../types';
import * as services from '../../services';

/** Every unit of every item together: per-unit weight × quantity. */
export function totalWeightGrams(items: Item[]): number {
  return items.reduce((sum, item) => sum + services.itemWeightGrams(item).grams, 0);
}

/** True when the weight comes from the class midpoint rather than a measurement. */
export function isWeightEstimated(weight: Weight | undefined): boolean {
  return !(typeof weight?.exactGrams === 'number' && weight.exactGrams > 0);
}

/** A total is only exact when every item in it was actually weighed. */
export function anyWeightEstimated(items: Item[]): boolean {
  return items.some((item) => isWeightEstimated(item.weight));
}

export function formatGrams(grams: number): string {
  if (!Number.isFinite(grams) || grams <= 0) return '0 g';
  if (grams < 1000) return `${Math.round(grams)} g`;
  const kg = grams / 1000;
  return `${kg.toFixed(kg < 10 ? 2 : 1)} kg`;
}

export function weightLabel(weight: Weight | undefined): string {
  if (!weight) return '—';
  if (typeof weight.exactGrams === 'number' && weight.exactGrams > 0) {
    return formatGrams(weight.exactGrams);
  }
  return WEIGHT_CLASSES[weight.class]?.label ?? '—';
}

export function sizeLabel(dimensions: Dimensions | undefined): string {
  if (!dimensions) return '—';
  const exact = dimensions.exactMm;
  if (exact) return `${exact.l}×${exact.w}×${exact.h} mm`;
  return SIZE_CLASSES[dimensions.class]?.label ?? '—';
}

export function formatMoney(value: MoneyValue | undefined): string {
  if (!value || !Number.isFinite(value.amount)) return '—';
  return formatAmount(value.amount, value.currency);
}

export function formatAmount(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '—';
  const code = (currency ?? '').trim().toUpperCase();
  // Intl only accepts a well-formed ISO code; anything else falls back to
  // "<amount> <code>" rather than rendering a broken currency symbol.
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
      }).format(amount);
    } catch {
      /* unknown code for this runtime; fall through */
    }
  }
  return code ? `${amount.toLocaleString()} ${code}` : amount.toLocaleString();
}

export function convertedAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
): number | null {
  if (!Number.isFinite(amount)) return null;
  const from = (fromCurrency ?? '').trim().toUpperCase();
  const to = (toCurrency ?? '').trim().toUpperCase();
  if (!from || !to) return null;
  if (from === to) return amount;
  const converted = services.convert(amount, from, to);
  return converted !== null && Number.isFinite(converted) ? converted : null;
}

/** A secondary main-currency label for a value denominated in another currency. */
export function convertedMoneyHint(
  value: MoneyValue | undefined,
  mainCurrency: string | undefined,
): string | null {
  if (!value || !mainCurrency) return null;
  if (value.currency.trim().toUpperCase() === mainCurrency.trim().toUpperCase()) return null;
  const amount = convertedAmount(value.amount, value.currency, mainCurrency);
  return amount === null ? null : `≈ ${formatAmount(amount, mainCurrency)}`;
}

export interface LineValueDisplay {
  /** What the whole line is worth: per-unit value × units. */
  total: string;
  /** Main-currency equivalent of that total, e.g. "≈ CHF 40.45". */
  conversion: string | null;
  /** "$10 each", only when the sheet stands for more than one unit. */
  perUnit: string | null;
  units: number;
}

/**
 * How a row shows an item's money. A row in a list is read as "what is this
 * line worth", so the line total leads and the unit price follows as a hint.
 * The item sheet is the exception: it describes one object and stays per unit.
 */
export function lineValueDisplay(
  item: Item,
  mainCurrency: string | undefined,
  field: 'valueCurrent' | 'valueNew' = 'valueCurrent',
): LineValueDisplay | null {
  const total = services.itemValueTotal(item, field);
  if (!total) return null;
  const units = services.unitCount(item);
  return {
    units,
    total: formatMoney(total),
    // The conversion follows the figure it sits under, so it converts the total.
    conversion: convertedMoneyHint(total, mainCurrency),
    perUnit: units > 1 ? `${formatMoney(item[field])} each` : null,
  };
}

/** The weight counterpart of {@link lineValueDisplay}: whole line, then per unit. */
export function lineWeightDisplay(item: Item): { total: string; perUnit: string | null } {
  const perUnitLabel = weightLabel(item.weight);
  const total = services.itemWeightGrams(item);
  if (services.unitCount(item) < 2 || total.grams <= 0) {
    return { total: perUnitLabel, perUnit: null };
  }
  return {
    total: `${total.estimated ? '~' : ''}${formatGrams(total.grams)}`,
    perUnit: `${perUnitLabel} each`,
  };
}

/** Values may mix currencies; totals are kept per currency rather than converted. */
export function totalsByCurrency(
  items: Item[],
  field: 'valueCurrent' | 'valueNew',
): Array<{ currency: string; amount: number }> {
  const byCurrency = new Map<string, number>();
  for (const item of items) {
    const lineTotal = services.itemValueTotal(item, field);
    if (!lineTotal) continue;
    byCurrency.set(
      lineTotal.currency,
      (byCurrency.get(lineTotal.currency) ?? 0) + lineTotal.amount,
    );
  }
  return [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount }));
}

/**
 * "3 items", plus the unit count when the two differ. Item sheets and units
 * are deliberately kept apart: a sheet describes one object, its quantity says
 * how many of that object there are, and only the second one drives totals.
 */
export function itemCountLabel(itemCount: number, unitCount: number): string {
  const items = `${itemCount} item${itemCount === 1 ? '' : 's'}`;
  return unitCount === itemCount ? items : `${items} (${unitCount} units)`;
}

export function formatTotals(totals: Array<{ currency: string; amount: number }>): string {
  if (totals.length === 0) return '—';
  return totals.map((t) => formatAmount(t.amount, t.currency)).join(' + ');
}

/** Returns null unless every currency line can be represented in the target currency. */
export function convertTotalsToCurrency(
  totals: Array<{ currency: string; amount: number }>,
  targetCurrency: string,
): number | null {
  if (totals.length === 0) return null;
  let total = 0;
  for (const line of totals) {
    const converted = convertedAmount(line.amount, line.currency, targetCurrency);
    if (converted === null) return null;
    total += converted;
  }
  return Number.isFinite(total) ? total : null;
}

export function formatDateTime(epochMs: number | undefined): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatCoords(lat?: number, lon?: number): string | null {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** Search matches description, tags, serial number, category and box-free text. */
export function itemMatchesQuery(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.description,
    item.category,
    item.serialNumber,
    item.brandModel,
    item.notes,
    ...(item.tags ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

export function safeFilename(name: string, fallback = 'inventory'): string {
  const cleaned = (name || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}

export function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function locationText(entry: { lat?: number; lon?: number; label?: string } | undefined): string {
  if (!entry) return 'Not recorded';
  const coords = formatCoords(entry.lat, entry.lon);
  if (entry.label && coords) return `${entry.label} (${coords})`;
  if (entry.label) return entry.label;
  return coords ?? 'Not recorded';
}
