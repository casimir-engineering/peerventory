/**
 * Currency conversion via open.er-api.com (USD base), cached 24h in localStorage.
 * Never throws; degrades to the stale cache (or nothing) offline.
 */

const FX_KEY = 'fx:v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FX_URL = 'https://open.er-api.com/v6/latest/USD';

const FALLBACK_CURRENCIES = [
  'USD', 'EUR', 'CNY', 'GBP', 'JPY', 'HKD', 'SGD', 'TWD', 'KRW', 'AUD', 'CAD', 'CHF',
];

interface FxCache {
  fetchedAt: number;
  rates: Record<string, number>;
}

function readCache(): FxCache | null {
  try {
    const raw = localStorage.getItem(FX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as FxCache).fetchedAt === 'number' &&
      typeof (parsed as FxCache).rates === 'object' && (parsed as FxCache).rates !== null
    ) {
      return parsed as FxCache;
    }
  } catch {
    // corrupt cache -> treat as missing
  }
  return null;
}

let inflight: Promise<void> | null = null;

/** Fetch rates if the cache is missing or older than 24h. Idempotent, never throws. */
export async function ensureRates(): Promise<void> {
  const cache = readCache();
  if (cache && Date.now() - cache.fetchedAt < MAX_AGE_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(FX_URL);
      if (!res.ok) return;
      const body = (await res.json()) as { result?: string; rates?: Record<string, unknown> };
      if (body.result !== 'success' || !body.rates) return;
      const rates: Record<string, number> = {};
      for (const [code, v] of Object.entries(body.rates)) {
        if (typeof v === 'number' && isFinite(v) && v > 0) rates[code.toUpperCase()] = v;
      }
      if (Object.keys(rates).length === 0) return;
      localStorage.setItem(FX_KEY, JSON.stringify({ fetchedAt: Date.now(), rates } satisfies FxCache));
    } catch {
      // offline / fetch failed: keep whatever cache we had
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Convert via USD-base rates. Same-currency passes through; unknown codes -> null. */
export function convert(amount: number, from: string, to: string): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  const rates = readCache()?.rates;
  if (!rates) return null;
  const rf = rates[f];
  const rt = rates[t];
  if (rf === undefined || rt === undefined || rf === 0) return null;
  return (amount / rf) * rt;
}

/** Codes from the cached table, or a small hardcoded list when no cache exists. */
export function knownCurrencies(): string[] {
  const rates = readCache()?.rates;
  if (rates && Object.keys(rates).length > 0) return Object.keys(rates).sort();
  return [...FALLBACK_CURRENCIES];
}

/** Age of the cached table in ms, or null if never fetched. */
export function ratesAgeMs(): number | null {
  const cache = readCache();
  return cache ? Date.now() - cache.fetchedAt : null;
}
