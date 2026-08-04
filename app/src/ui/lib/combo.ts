/**
 * Ranked matching for SmartCombo fields: options whose values come from a
 * known set (currency codes, country names) are found by typing any part of
 * the code, the human name, or a colloquial alias.
 */

export interface ComboOption {
  /** Canonical value written to the data model, e.g. "USD". */
  value: string;
  /** Human label shown next to the value, e.g. "US Dollar". */
  label: string;
  /** Extra search words (aliases) that are never displayed, e.g. "bucks". */
  keywords?: string[];
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Lower is better; null means no match. The tiers keep "us" ranking USD
 * (code prefix) above AUD ("aUStralian" substring), and an alias like
 * "quid" ranking GBP above the many currencies whose label contains "pound".
 */
function scoreOption(option: ComboOption, query: string): number | null {
  const q = query.toLowerCase();
  const value = option.value.toLowerCase();
  const label = option.label.toLowerCase();
  const keywords = (option.keywords ?? []).map((k) => k.toLowerCase());

  if (value === q) return 0;
  if (label === q || keywords.includes(q)) return 1;
  if (value.startsWith(q)) return 2;
  if (label.startsWith(q)) return 3;
  if (keywords.some((k) => k.startsWith(q))) return 4;

  const labelWords = wordsOf(option.label);
  if (labelWords.some((w) => w.startsWith(q))) return 5;

  // Multi-word queries: every token must be a prefix of some word
  // ("fra sw" still finds Swiss Franc).
  const tokens = wordsOf(q);
  const allWords = [value, ...labelWords, ...keywords.flatMap(wordsOf)];
  if (tokens.length > 1 && tokens.every((t) => allWords.some((w) => w.startsWith(t)))) return 6;

  if (value.includes(q) || label.includes(q) || keywords.some((k) => k.includes(q))) return 7;
  return null;
}

/** Options matching the query, best first; original order breaks ties. */
export function matchOptions(
  options: ComboOption[],
  query: string,
  limit = 200,
): ComboOption[] {
  const q = query.trim();
  if (q === '') return options.slice(0, limit);
  return options
    .map((option, index) => ({ option, index, score: scoreOption(option, q) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.option);
}

/**
 * The option free text stands for, if it is beyond doubt: an exact value,
 * label, or alias match, or a query that matches exactly one option
 * ("swiss" -> CHF). Ambiguous text ("dollar") resolves to nothing.
 */
export function resolveOption(options: ComboOption[], text: string): ComboOption | null {
  const t = text.trim();
  if (t === '') return null;
  const lower = t.toLowerCase();
  const exact = options.find(
    (o) =>
      o.value.toLowerCase() === lower ||
      o.label.toLowerCase() === lower ||
      (o.keywords ?? []).some((k) => k.toLowerCase() === lower),
  );
  if (exact) return exact;
  const matches = matchOptions(options, t, 2);
  return matches.length === 1 ? matches[0] : null;
}
