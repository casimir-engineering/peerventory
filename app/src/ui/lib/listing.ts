/**
 * "Sell / export listing" support: turns an Item into marketplace listing
 * copy (AI-written when a Claude key is on the device, template otherwise)
 * and serializes it to the connector payload consumed by the Peerventory
 * Chrome extension (connector/chrome-extension). The payload schema is v1
 * and is documented in connector/README.md — keep both sides in sync.
 *
 * The Anthropic key never leaves the device and the extension never sees it:
 * all AI copywriting happens here, in the app.
 */

import type { Item, MoneyValue } from '../../types';
import { getAiKey } from '../../services';
import { downloadBlob } from '../../export';
import { getPhotoBlob } from '../../store';
import { safeFilename } from './format';

/* ------------------------------------------------------------------ */
/* Payload schema v1 (contract with connector/chrome-extension)        */
/* ------------------------------------------------------------------ */

export interface ListingPayloadItem {
  title: string;
  description: string;
  /** Optional translations for Swiss classifieds (Anibis is FR/DE/IT). */
  descriptionTranslations?: { fr?: string; de?: string };
  priceAmount: number;
  /** ISO 4217 */
  priceCurrency: string;
  condition?: string;
  category?: string;
  brandModel?: string;
  weightGrams?: number;
  dimensionsMm?: { l: number; w: number; h: number };
  /** True when the item has a recorded serial number (the number itself is never exported). */
  serialIncluded: boolean;
}

export interface ListingPayload {
  v: 1;
  source: 'peerventory';
  item: ListingPayloadItem;
  /** Human hint about the photo workflow (photos travel as downloaded files, not in the payload). */
  photosNote: string;
}

/** Editable state behind the Sell modal; collapses into a ListingPayload. */
export interface ListingDraft {
  title: string;
  description: string;
  fr?: string;
  de?: string;
  priceAmount: number | null;
  priceCurrency: string;
  /** True when the copy came from the AI rather than the field template. */
  ai: boolean;
}

/* ------------------------------------------------------------------ */
/* Price suggestion                                                    */
/* ------------------------------------------------------------------ */

/** Classifieds prices look better rounded; keep cents only under 20. */
function roundPrice(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (amount < 20) return Math.round(amount);
  if (amount < 200) return Math.round(amount / 5) * 5;
  return Math.round(amount / 10) * 10;
}

/**
 * valueCurrent is the user's own estimate of what the item is worth now, so
 * it is the asking price. Without it, 60% of the new price is a common
 * second-hand rule of thumb.
 */
export function suggestPrice(item: Item, fallbackCurrency: string): MoneyValue | null {
  if (item.valueCurrent && Number.isFinite(item.valueCurrent.amount)) {
    return { amount: roundPrice(item.valueCurrent.amount), currency: item.valueCurrent.currency };
  }
  if (item.valueNew && Number.isFinite(item.valueNew.amount)) {
    return { amount: roundPrice(item.valueNew.amount * 0.6), currency: item.valueNew.currency };
  }
  void fallbackCurrency;
  return null;
}

/* ------------------------------------------------------------------ */
/* Template draft (no AI)                                              */
/* ------------------------------------------------------------------ */

function titleFrom(item: Item): string {
  const desc = (item.description ?? '').trim().split('\n')[0];
  const brand = (item.brandModel ?? '').trim();
  let title = brand && !desc.toLowerCase().includes(brand.toLowerCase()) ? `${brand} — ${desc}` : desc;
  if (!title) title = brand || 'Item for sale';
  return title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title;
}

export function buildTemplateDraft(item: Item, mainCurrency: string): ListingDraft {
  const price = suggestPrice(item, mainCurrency);
  const lines: string[] = [];
  const desc = (item.description ?? '').trim();
  if (desc) lines.push(desc);
  if (item.brandModel) lines.push(`Brand / model: ${item.brandModel}`);
  if (item.condition) lines.push(`Condition: ${item.condition}`);
  const mm = item.dimensions?.exactMm;
  if (mm) lines.push(`Dimensions: ${mm.l} × ${mm.w} × ${mm.h} mm`);
  const grams = item.weight?.exactGrams;
  if (typeof grams === 'number' && grams > 0) {
    lines.push(`Weight: ${grams < 1000 ? `${grams} g` : `${(grams / 1000).toFixed(1)} kg`}`);
  }
  if (item.valueNew && Number.isFinite(item.valueNew.amount)) {
    lines.push(`Price when new: ${item.valueNew.amount} ${item.valueNew.currency}`);
  }
  if (item.serialNumber) lines.push('Serial number on record (proof of ownership available).');
  if (item.notes) lines.push(item.notes.trim());
  lines.push('Sold as pictured. Pick-up or shipped, message me!');
  return {
    title: titleFrom(item),
    description: lines.join('\n'),
    priceAmount: price?.amount ?? null,
    priceCurrency: price?.currency ?? mainCurrency,
    ai: false,
  };
}

/* ------------------------------------------------------------------ */
/* AI draft (same direct-Anthropic pattern as services/ai.ts)          */
/* ------------------------------------------------------------------ */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/** Keep in sync with services/ai.ts. */
const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 500;

/** Compact on purpose: the user pays for every prompt token. */
function buildSellPrompt(item: Item, price: MoneyValue | null, uiLang: string): string {
  const facts: string[] = [`Item: ${item.description || '(no description)'}`];
  if (item.brandModel) facts.push(`Brand/model: ${item.brandModel}`);
  if (item.category) facts.push(`Category: ${item.category}`);
  if (item.condition) facts.push(`Condition: ${item.condition}`);
  if (item.dimensions?.exactMm) {
    const m = item.dimensions.exactMm;
    facts.push(`Dimensions mm: ${m.l}x${m.w}x${m.h}`);
  }
  if (item.weight?.exactGrams) facts.push(`Weight g: ${item.weight.exactGrams}`);
  if (item.valueNew) facts.push(`New price: ${item.valueNew.amount} ${item.valueNew.currency}`);
  if (price) facts.push(`Asking price: ${price.amount} ${price.currency}`);
  if (item.notes) facts.push(`Notes: ${item.notes}`);
  return [
    'Write second-hand classifieds listing copy (Swiss market) for this item.',
    ...facts,
    `Reply with STRICT JSON only, no prose, no fences:`,
    `{"title": string (max 60 chars, language "${uiLang}"),`,
    ` "description": string (max 450 chars, language "${uiLang}", warm and factual selling copy, plain text, line breaks allowed, no emojis, no invented facts),`,
    ` "fr": string (the description in French),`,
    ` "de": string (the description in German)}`,
    uiLang.startsWith('fr') ? 'Omit "fr".' : uiLang.startsWith('de') ? 'Omit "de".' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

async function upstreamErrorMessage(res: Response): Promise<string> {
  let type = '';
  let message = '';
  try {
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    type = body.error?.type ?? '';
    message = body.error?.message ?? '';
  } catch {
    // non-JSON error body
  }
  if (res.status === 401) return 'Invalid Claude API key. Check it in your profile.';
  if (res.status === 403) return 'Anthropic does not serve this network region. Try a VPN.';
  if (res.status === 429) return 'AI rate limited, wait a minute.';
  if (type === 'invalid_request_error' && /credit/i.test(message)) {
    return 'Your Anthropic credits are exhausted.';
  }
  if (res.status === 529 || type === 'overloaded_error') return 'AI is overloaded, try again shortly.';
  return 'AI copywriting failed, try again.';
}

/**
 * Writes the listing copy with the device's own Claude key. Throws an Error
 * with a user-displayable message on any failure — the caller keeps the
 * template draft in that case.
 */
export async function buildAiDraft(
  item: Item,
  mainCurrency: string,
  uiLang: string = typeof navigator !== 'undefined' ? navigator.language : 'en',
): Promise<ListingDraft> {
  const apiKey = getAiKey();
  if (!apiKey) {
    throw new Error('No Claude API key on this device. Add yours in your profile.');
  }
  const price = suggestPrice(item, mainCurrency);

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: buildSellPrompt(item, price, uiLang) }],
      }),
    });
  } catch {
    throw new Error('AI needs a connection (Anthropic may be blocked on this network).');
  }
  if (!res.ok) throw new Error(await upstreamErrorMessage(res));

  let parsed: Record<string, unknown>;
  try {
    const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    parsed = JSON.parse(stripFence(text)) as Record<string, unknown>;
  } catch {
    throw new Error('AI copywriting failed, try again.');
  }

  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  const title = str(parsed.title);
  const description = str(parsed.description);
  if (!title || !description) throw new Error('AI copywriting failed, try again.');
  return {
    title: title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title,
    description,
    fr: str(parsed.fr),
    de: str(parsed.de),
    priceAmount: price?.amount ?? null,
    priceCurrency: price?.currency ?? mainCurrency,
    ai: true,
  };
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

export function buildPayload(item: Item, draft: ListingDraft): ListingPayload {
  const translations: { fr?: string; de?: string } = {};
  if (draft.fr) translations.fr = draft.fr;
  if (draft.de) translations.de = draft.de;
  const grams =
    typeof item.weight?.exactGrams === 'number' && item.weight.exactGrams > 0
      ? Math.round(item.weight.exactGrams)
      : undefined;
  const payloadItem: ListingPayloadItem = {
    title: draft.title.trim(),
    description: draft.description.trim(),
    ...(translations.fr || translations.de ? { descriptionTranslations: translations } : {}),
    priceAmount: draft.priceAmount ?? 0,
    priceCurrency: draft.priceCurrency.trim().toUpperCase(),
    ...(item.condition ? { condition: item.condition } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.brandModel ? { brandModel: item.brandModel } : {}),
    ...(grams ? { weightGrams: grams } : {}),
    ...(item.dimensions?.exactMm ? { dimensionsMm: item.dimensions.exactMm } : {}),
    serialIncluded: Boolean((item.serialNumber ?? '').trim()),
  };
  return {
    v: 1,
    source: 'peerventory',
    item: payloadItem,
    photosNote: `${(item.photos ?? []).length} photo(s) downloaded separately — drag them into the listing form.`,
  };
}

export function payloadJson(payload: ListingPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** Plain-text version for pasting into any listing form or a chat. */
export function payloadText(payload: ListingPayload): string {
  const it = payload.item;
  const lines: string[] = [it.title, ''];
  lines.push(it.description);
  const tr = it.descriptionTranslations;
  if (tr?.fr) lines.push('', '--- FR ---', tr.fr);
  if (tr?.de) lines.push('', '--- DE ---', tr.de);
  lines.push('');
  lines.push(`Price: ${it.priceAmount} ${it.priceCurrency}`);
  if (it.condition) lines.push(`Condition: ${it.condition}`);
  if (it.category) lines.push(`Category: ${it.category}`);
  if (it.brandModel) lines.push(`Brand / model: ${it.brandModel}`);
  if (it.weightGrams) lines.push(`Weight: ${it.weightGrams} g`);
  if (it.dimensionsMm) {
    lines.push(`Dimensions: ${it.dimensionsMm.l} × ${it.dimensionsMm.w} × ${it.dimensionsMm.h} mm`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Photo download                                                      */
/* ------------------------------------------------------------------ */

function extensionForMime(mime: string): string {
  const base = (mime ?? '').toLowerCase().split(';', 1)[0].trim();
  if (base === 'image/png') return 'png';
  if (base === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * Saves the item's decrypted photos as individual files (loose files drag
 * into listing forms directly, unlike a zip). Sequential with a small gap so
 * the browser's multiple-download prompt fires once instead of dropping
 * files. Returns how many photos were actually available on this device.
 */
export async function downloadListingPhotos(docId: string, item: Item): Promise<number> {
  const base = safeFilename(item.description || item.brandModel || 'item', 'item');
  let saved = 0;
  const photos = item.photos ?? [];
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const blob = await getPhotoBlob(docId, photo.hash);
    if (!blob) continue;
    saved++;
    downloadBlob(blob, `${base}-${saved}.${extensionForMime(photo.mime || blob.type)}`);
    if (i < photos.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
  return saved;
}
