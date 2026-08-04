/**
 * Template listing draft: ExtItem -> listing payload v1 (the contract the
 * content scripts consume — see connector/README.md). Port of the template
 * path of app/src/ui/lib/listing.ts, with the fixed boilerplate strings
 * localized per listing language (popup setting, default FR — Anibis is
 * Swiss). The AI path (src/ai.ts) overrides title + description when a key
 * is linked; the popup's "paste listing payload" box still accepts
 * app-drafted payloads, which override this template entirely.
 */

import type { ExtItem, ListingLang, ListingPayload, ListingPayloadItem, MoneyValue } from './types';

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

/** Fixed template boilerplate per listing language. The item data itself
 * (description, notes) stays in whatever language the user wrote it in —
 * only the AI path can translate that. */
const TEMPLATE_STRINGS: Record<
  ListingLang,
  {
    brand: string;
    condition: string;
    dimensions: string;
    weight: string;
    priceNew: string;
    serial: string;
    closing: string;
  }
> = {
  en: {
    brand: 'Brand / model',
    condition: 'Condition',
    dimensions: 'Dimensions',
    weight: 'Weight',
    priceNew: 'Price when new',
    serial: 'Serial number on record (proof of ownership available).',
    closing: 'Sold as pictured. Pick-up or shipped, message me!',
  },
  fr: {
    brand: 'Marque / modèle',
    condition: 'État',
    dimensions: 'Dimensions',
    weight: 'Poids',
    priceNew: 'Prix neuf',
    serial: 'Numéro de série enregistré (preuve de propriété disponible).',
    closing: 'Vendu comme sur les photos. Remise en main propre ou envoi — écrivez-moi !',
  },
  de: {
    brand: 'Marke / Modell',
    condition: 'Zustand',
    dimensions: 'Abmessungen',
    weight: 'Gewicht',
    priceNew: 'Neupreis',
    serial: 'Seriennummer registriert (Eigentumsnachweis vorhanden).',
    closing: 'Verkauf wie abgebildet. Abholung oder Versand — schreiben Sie mir!',
  },
  it: {
    brand: 'Marca / modello',
    condition: 'Stato',
    dimensions: 'Dimensioni',
    weight: 'Peso',
    priceNew: 'Prezzo da nuovo',
    serial: 'Numero di serie registrato (prova di proprietà disponibile).',
    closing: 'Venduto come in foto. Ritiro o spedizione — scrivetemi!',
  },
};

function templateDescription(item: ExtItem, lang: ListingLang): string {
  const t = TEMPLATE_STRINGS[lang];
  const lines: string[] = [];
  const desc = (item.description ?? '').trim();
  if (desc) lines.push(desc);
  if (item.brandModel) lines.push(`${t.brand}: ${item.brandModel}`);
  if (item.condition) lines.push(`${t.condition}: ${item.condition}`);
  if (item.dimensionsMm) {
    const mm = item.dimensionsMm;
    lines.push(`${t.dimensions}: ${mm.l} × ${mm.w} × ${mm.h} mm`);
  }
  if (item.weightGrams) {
    const g = item.weightGrams;
    lines.push(`${t.weight}: ${g < 1000 ? `${g} g` : `${(g / 1000).toFixed(1)} kg`}`);
  }
  if (item.valueNew && Number.isFinite(item.valueNew.amount)) {
    lines.push(`${t.priceNew}: ${item.valueNew.amount} ${item.valueNew.currency}`);
  }
  if (item.serialIncluded) lines.push(t.serial);
  if (item.notes) lines.push(item.notes.trim());
  lines.push(t.closing);
  return lines.join('\n');
}

export function buildListingPayload(item: ExtItem, lang: ListingLang = 'en'): ListingPayload {
  const price = suggestPrice(item);
  const payloadItem: ListingPayloadItem = {
    title: itemTitle(item),
    description: templateDescription(item, lang),
    language: lang,
    aiDrafted: false,
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
        ? `${item.photos.length} photo(s) — they attach automatically; if they don't appear, use "Photos" on the item in the popup and drag the files in.`
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
