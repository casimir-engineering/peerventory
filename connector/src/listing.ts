/**
 * Template listing draft: ExtItem -> listing payload v1 (the contract the
 * content scripts consume — see connector/README.md). Port of the template
 * path of app/src/ui/lib/listing.ts; the AI-drafted path stays in the app
 * (the popup's "paste listing payload" box accepts app-drafted payloads,
 * which override this template).
 */

import type { ExtItem, ListingPayload, ListingPayloadItem, MoneyValue } from './types';

/** Classifieds prices look better rounded; keep cents only under 20. */
function roundPrice(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (amount < 20) return Math.round(amount);
  if (amount < 200) return Math.round(amount / 5) * 5;
  return Math.round(amount / 10) * 10;
}

/** valueCurrent = the user's own estimate = asking price; else 60% of new. */
export function suggestPrice(item: ExtItem): MoneyValue | null {
  if (item.valueCurrent && Number.isFinite(item.valueCurrent.amount)) {
    return { amount: roundPrice(item.valueCurrent.amount), currency: item.valueCurrent.currency };
  }
  if (item.valueNew && Number.isFinite(item.valueNew.amount)) {
    return { amount: roundPrice(item.valueNew.amount * 0.6), currency: item.valueNew.currency };
  }
  return null;
}

export function itemTitle(item: ExtItem): string {
  const desc = (item.description ?? '').trim().split('\n')[0];
  const brand = (item.brandModel ?? '').trim();
  let title =
    brand && !desc.toLowerCase().includes(brand.toLowerCase()) ? `${brand} — ${desc}` : desc;
  if (!title) title = brand || 'Item for sale';
  return title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title;
}

function templateDescription(item: ExtItem): string {
  const lines: string[] = [];
  const desc = (item.description ?? '').trim();
  if (desc) lines.push(desc);
  if (item.brandModel) lines.push(`Brand / model: ${item.brandModel}`);
  if (item.condition) lines.push(`Condition: ${item.condition}`);
  if (item.dimensionsMm) {
    const mm = item.dimensionsMm;
    lines.push(`Dimensions: ${mm.l} × ${mm.w} × ${mm.h} mm`);
  }
  if (item.weightGrams) {
    const g = item.weightGrams;
    lines.push(`Weight: ${g < 1000 ? `${g} g` : `${(g / 1000).toFixed(1)} kg`}`);
  }
  if (item.valueNew && Number.isFinite(item.valueNew.amount)) {
    lines.push(`Price when new: ${item.valueNew.amount} ${item.valueNew.currency}`);
  }
  if (item.serialIncluded) lines.push('Serial number on record (proof of ownership available).');
  if (item.notes) lines.push(item.notes.trim());
  lines.push('Sold as pictured. Pick-up or shipped, message me!');
  return lines.join('\n');
}

export function buildListingPayload(item: ExtItem): ListingPayload {
  const price = suggestPrice(item);
  const payloadItem: ListingPayloadItem = {
    title: itemTitle(item),
    description: templateDescription(item),
    priceAmount: price?.amount ?? 0,
    priceCurrency: (price?.currency ?? 'CHF').toUpperCase(),
    ...(item.condition ? { condition: item.condition } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.brandModel ? { brandModel: item.brandModel } : {}),
    ...(item.weightGrams ? { weightGrams: item.weightGrams } : {}),
    ...(item.dimensionsMm ? { dimensionsMm: item.dimensionsMm } : {}),
    serialIncluded: item.serialIncluded,
  };
  return {
    v: 1,
    source: 'peerventory',
    item: payloadItem,
    photosNote:
      item.photos.length > 0
        ? `${item.photos.length} photo(s) — use "Photos" on the item in the popup to download them, then drag the files into the form.`
        : 'No photos on this item.',
  };
}

/** Mirrors validPayload in content/fill-core.js (for the paste-payload box). */
export function isListingPayload(raw: unknown): raw is ListingPayload {
  const p = raw as ListingPayload | null;
  return Boolean(
    p &&
      p.v === 1 &&
      p.source === 'peerventory' &&
      p.item &&
      typeof p.item.title === 'string' &&
      p.item.title !== '',
  );
}

/* ---------- search ---------- */

/** Case-insensitive multi-word AND search over the fields the task cares about. */
export function matchesQuery(item: ExtItem, inventoryName: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    item.description,
    item.brandModel ?? '',
    item.category ?? '',
    item.notes ?? '',
    item.tags.join(' '),
    inventoryName,
  ]
    .join('\n')
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}
