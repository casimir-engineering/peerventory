/**
 * On-device AI photo analysis: the browser/WebView calls the Anthropic API
 * directly with this device's own key (see aikey.ts). Nothing AI-related
 * touches our sync server. Throws Error with a user-displayable message on
 * any failure (the UI shows err.message directly).
 */

import { getAiKey } from './aikey';

export interface AiSuggestions {
  description?: string;
  category?: string;
  tags?: string[];
  brandModel?: string;
  valueCurrent?: { amount: number; currency: string };
  valueNew?: { amount: number; currency: string };
  weightGrams?: number;
  dimensionsMm?: { l: number; w: number; h: number };
  lithiumBattery?: boolean;
  countryOfOrigin?: string;
  hsCode?: string;
  condition?: string;
  translations?: Record<string, string>;
}

const MAX_PHOTOS = 3;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

/**
 * Vision cost scales with pixel count (~w*h/750 input tokens per image), so
 * uploads are downscaled well below the stored 2048px originals. 1024px is
 * plenty for identifying an object and reading large labels.
 */
const AI_MAX_EDGE = 1024;
const AI_JPEG_QUALITY = 0.75;

async function shrinkForAi(blob: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob);
    try {
      const maxEdge = Math.max(bmp.width, bmp.height);
      if (maxEdge <= AI_MAX_EDGE && blob.type === 'image/jpeg') return blob;
      const scale = Math.min(1, AI_MAX_EDGE / maxEdge);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return blob;
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const out = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', AI_JPEG_QUALITY),
      );
      return out ?? blob;
    } finally {
      bmp.close();
    }
  } catch {
    return blob; // not decodable here; Anthropic will reject it if unusable
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Compact on purpose: the user pays for every prompt token. */
function buildPrompt(context: { description?: string; mainCurrency: string }): string {
  const lines = [
    'Identify the pictured item for a customs manifest (personal effects/electronics shipped internationally).',
  ];
  if (context.description) lines.push(`Existing description: ${context.description}`);
  lines.push(
    'Reply with STRICT JSON only, no prose, no fences. Optional keys only:',
    'description (short customs English), category, tags (string[]), brandModel,',
    `valueCurrent {amount,currency}, valueNew {amount,currency} (realistic used/new estimates in ${context.mainCurrency}),`,
    'weightGrams (int), dimensionsMm {l,w,h} (int), lithiumBattery (bool), countryOfOrigin,',
    'hsCode (6-digit string), condition (short), translations {zh: description in zh-CN}.',
    'Omit unknown fields. No other keys.',
  );
  return lines.join('\n');
}

function asMoney(v: unknown): { amount: number; currency: string } | undefined {
  const m = v as { amount?: unknown; currency?: unknown };
  if (typeof v === 'object' && v !== null && typeof m.amount === 'number' && typeof m.currency === 'string') {
    return { amount: m.amount, currency: m.currency };
  }
  return undefined;
}

function sanitizeSuggestions(raw: unknown): AiSuggestions {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: AiSuggestions = {};
  const str = (k: keyof AiSuggestions & string) => {
    if (typeof r[k] === 'string') (out as Record<string, unknown>)[k] = r[k];
  };
  str('description');
  str('category');
  str('brandModel');
  str('countryOfOrigin');
  str('hsCode');
  str('condition');
  if (Array.isArray(r.tags)) out.tags = r.tags.filter((t): t is string => typeof t === 'string');
  const vc = asMoney(r.valueCurrent);
  if (vc) out.valueCurrent = vc;
  const vn = asMoney(r.valueNew);
  if (vn) out.valueNew = vn;
  if (typeof r.weightGrams === 'number' && isFinite(r.weightGrams)) out.weightGrams = r.weightGrams;
  const d = r.dimensionsMm as { l?: unknown; w?: unknown; h?: unknown } | undefined;
  if (d && typeof d === 'object' && typeof d.l === 'number' && typeof d.w === 'number' && typeof d.h === 'number') {
    out.dimensionsMm = { l: d.l, w: d.w, h: d.h };
  }
  if (typeof r.lithiumBattery === 'boolean') out.lithiumBattery = r.lithiumBattery;
  if (typeof r.translations === 'object' && r.translations !== null && !Array.isArray(r.translations)) {
    const tr: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.translations)) if (typeof v === 'string') tr[k] = v;
    out.translations = tr;
  }
  return out;
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
  return 'AI analysis failed, try again.';
}

export async function analyzeItemPhotos(
  _docId: string,
  photos: Blob[],
  context: { description?: string; mainCurrency: string },
): Promise<AiSuggestions> {
  if (photos.length === 0) throw new Error('Add at least one photo first');
  if (photos.length > MAX_PHOTOS) throw new Error(`Select at most ${MAX_PHOTOS} photos`);
  const apiKey = getAiKey();
  if (!apiKey) {
    throw new Error('No Claude API key on this device. Add yours in your profile, or scan a key QR.');
  }

  const encoded = await Promise.all(
    photos.map(async (p) => {
      const small = await shrinkForAi(p);
      return {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: small.type || 'image/jpeg',
          data: await blobToBase64(small),
        },
      };
    }),
  );

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
        max_tokens: 1024,
        messages: [
          { role: 'user', content: [...encoded, { type: 'text', text: buildPrompt(context) }] },
        ],
      }),
    });
  } catch {
    throw new Error('AI needs a connection (Anthropic may be blocked on this network).');
  }

  if (!res.ok) throw new Error(await upstreamErrorMessage(res));

  try {
    const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    return sanitizeSuggestions(JSON.parse(stripFence(text)));
  } catch {
    throw new Error('AI analysis failed, try again.');
  }
}
