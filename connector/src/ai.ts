/**
 * "Link AI": optional Anthropic key stored in chrome.storage.local (see
 * storage.ts) that upgrades the fill from templates to AI-written listing
 * copy and AI category picks. Same direct-from-browser pattern as the app
 * (app/src/services/ai.ts): the key never leaves the device, calls go
 * straight to api.anthropic.com.
 *
 * Design constraints, deliberate:
 *  - The user pays per token and has little credit — prompts are tiny, the
 *    model is haiku-class, max_tokens are small.
 *  - AI must never block a fill: every call carries a hard timeout and every
 *    caller falls back to the template / synonyms path on any failure.
 *  - Pure request/response plumbing (everything below the storage helpers)
 *    takes an injectable fetch so the Node unit tests can mock it.
 *
 * Cursor's cloud API was evaluated as a second provider and skipped: the SDK
 * needs a local Node bridge process (impossible in an extension) and the
 * REST surface (/v1/agents) spins a repo-cloning cloud VM per request —
 * wrong tool and far beyond the 10s fallback budget for one-shot copy.
 */

import type { ExtItem, ListingLang, MoneyValue } from './types';

export const AI_KEY_QR_PREFIX = 'inv-ai:';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/** Haiku-class on purpose: listing copy does not need a frontier model. */
export const AI_MODEL = 'claude-haiku-4-5';
/** Hard cap per call — a fill must never hang on the AI. */
export const AI_TIMEOUT_MS = 10_000;

export const LANGS: ListingLang[] = ['fr', 'de', 'it', 'en'];
export const LANG_NAMES: Record<ListingLang, string> = {
  fr: 'French',
  de: 'German',
  it: 'Italian',
  en: 'English',
};

export function isListingLang(v: unknown): v is ListingLang {
  return typeof v === 'string' && (LANGS as string[]).includes(v);
}

/**
 * Accepts what a user may paste or scan: a bare Anthropic key, or the app's
 * `inv-ai:<key>` QR/link format (app/src/services/aikey.ts). Returns the key
 * or null when the text is clearly not one.
 */
export function parseAiKeyInput(text: string): string | null {
  let t = (text || '').trim();
  if (t.startsWith(AI_KEY_QR_PREFIX)) t = t.slice(AI_KEY_QR_PREFIX.length).trim();
  if (t.length < 20 || /\s/.test(t)) return null;
  return t;
}

/** "sk-ant-…A1gAA" for display; never show the middle. */
export function maskKey(key: string): string {
  if (key.length <= 14) return '•'.repeat(key.length);
  return `${key.slice(0, 7)}…${key.slice(-5)}`;
}

/* ------------------------------------------------------------------ */
/* Anthropic call (shared by drafting and category picking)            */
/* ------------------------------------------------------------------ */

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AiCallOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

/** One tiny messages call; returns the concatenated text blocks. Throws on
 * any failure (HTTP, network, timeout) — callers fall back to templates. */
export async function callAnthropic(
  key: string,
  prompt: string,
  maxTokens: number,
  opts: AiCallOptions = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as FetchLike);
  const res = await fetchFn(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? AI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (body.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

/* ------------------------------------------------------------------ */
/* Listing draft                                                       */
/* ------------------------------------------------------------------ */

export interface AiDraft {
  title: string;
  description: string;
}

/** Compact on purpose: the user pays for every prompt token. */
export function buildDraftPrompt(
  item: ExtItem,
  price: MoneyValue | null,
  lang: ListingLang,
): string {
  const facts = [`Item: ${item.description || item.brandModel || '(no description)'}`];
  if (item.brandModel) facts.push(`Brand/model: ${item.brandModel}`);
  if (item.category) facts.push(`Category: ${item.category}`);
  if (item.condition) facts.push(`Condition: ${item.condition}`);
  if (item.dimensionsMm) {
    const m = item.dimensionsMm;
    facts.push(`Dimensions mm: ${m.l}x${m.w}x${m.h}`);
  }
  if (item.weightGrams) facts.push(`Weight g: ${item.weightGrams}`);
  if (item.valueNew) facts.push(`New price: ${item.valueNew.amount} ${item.valueNew.currency}`);
  if (price) facts.push(`Asking price: ${price.amount} ${price.currency}`);
  if (item.serialIncluded) facts.push('Serial number on record (proof of ownership).');
  if (item.notes) facts.push(`Notes: ${item.notes}`);
  return [
    `Write second-hand classifieds listing copy (Swiss market) in ${LANG_NAMES[lang]}.`,
    ...facts,
    'Reply with STRICT JSON only, no prose, no fences:',
    `{"title": string (max 60 chars, punchy, ${LANG_NAMES[lang]}),`,
    ` "description": string (max 500 chars, ${LANG_NAMES[lang]}, warm factual selling copy,`,
    ' plain text with line breaks, keep all prices/units/measurements exactly as given,',
    ' no emojis, no invented facts)}',
  ].join('\n');
}

/**
 * AI-written title + description in the selected language. Throws on any
 * failure or timeout — the caller keeps the template draft in that case.
 */
export async function draftListing(
  item: ExtItem,
  price: MoneyValue | null,
  lang: ListingLang,
  key: string,
  opts: AiCallOptions = {},
): Promise<AiDraft> {
  const text = await callAnthropic(key, buildDraftPrompt(item, price, lang), 400, opts);
  const parsed = JSON.parse(stripFence(text)) as { title?: unknown; description?: unknown };
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  if (!title || !description) throw new Error('AI draft incomplete');
  return {
    title: title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title,
    description,
  };
}

/* ------------------------------------------------------------------ */
/* Category pick (one menu level of the Anibis cascading menu)         */
/* ------------------------------------------------------------------ */

export interface AiPickItem {
  title: string;
  category?: string;
  description?: string;
}

export function buildPickPrompt(options: string[], item: AiPickItem): string {
  const about = [item.title, item.category, item.description].filter(Boolean).join(' | ');
  return [
    `Classifieds category menu. Item for sale: ${about}`,
    'Options:',
    ...options.map((label, i) => `${i + 1}. ${label}`),
    'Reply with the number of the best option (a category the item belongs in),',
    'or 0 if none fits. Number only.',
  ].join('\n');
}

/**
 * Ask the AI which scraped menu option to click. Returns the 0-based index
 * into `options`, or null when the AI answers 0 / out of range. Throws on
 * call failure — callers fall back to the synonyms heuristic.
 */
export async function aiPickOption(
  options: string[],
  item: AiPickItem,
  key: string,
  opts: AiCallOptions = {},
): Promise<number | null> {
  if (options.length === 0) return null;
  const text = await callAnthropic(key, buildPickPrompt(options, item), 8, opts);
  const m = text.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 1 && n <= options.length ? n - 1 : null;
}
