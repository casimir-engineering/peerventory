/**
 * SmartCombo options for currencies: codes come from the cached FX rates
 * table (services/currency.ts), human names from Intl.DisplayNames, plus a
 * small alias map for colloquial names DisplayNames does not carry.
 */

import { knownCurrencies } from '../../services';
import type { ComboOption } from './combo';
import { resolveOption } from './combo';

/** Minimal on purpose: names like "euro" or "franc" already come from DisplayNames. */
const CURRENCY_ALIASES: Record<string, string[]> = {
  CNY: ['yuan', 'renminbi', 'rmb'],
  GBP: ['quid', 'sterling', 'pound'],
  USD: ['bucks'],
};

let displayNames: Intl.DisplayNames | null | undefined;

/** "USD" -> "US Dollar"; falls back to the bare code when DisplayNames cannot. */
export function currencyDisplayName(code: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'currency' });
    } catch {
      displayNames = null;
    }
  }
  try {
    const name = displayNames?.of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

export function currencyComboOption(code: string): ComboOption {
  const clean = code.trim().toUpperCase();
  return {
    value: clean,
    label: currencyDisplayName(clean),
    keywords: CURRENCY_ALIASES[clean],
  };
}

let cacheKey = '';
let cacheVal: ComboOption[] = [];

/** Every currency the rates table knows, as combo options (cached). */
export function allCurrencyOptions(): ComboOption[] {
  let codes: string[];
  try {
    codes = knownCurrencies();
  } catch {
    return cacheVal;
  }
  const key = codes.join(',');
  if (key !== cacheKey) {
    cacheKey = key;
    cacheVal = codes.map(currencyComboOption);
  }
  return cacheVal;
}

/**
 * The code that free text stands for, if unambiguous: "yuan" -> "CNY",
 * "swiss" -> "CHF", "usd" -> "USD". "dollar" (many) -> null.
 */
export function resolveCurrencyText(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  return resolveOption(allCurrencyOptions(), t)?.value ?? null;
}
