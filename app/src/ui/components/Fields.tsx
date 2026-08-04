import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  convert,
  formatGrams,
  formatMm,
  knownCurrencies,
  searchPlaces,
  suggestInputs,
} from '../../services';
import type { AiSuggestions, PlaceHit } from '../../services';
import type { MoneyValue } from '../../types';
import type { ComboOption } from '../lib/combo';
import { currencyComboOption, resolveCurrencyText } from '../lib/currencyCombo';
import { formatAmount, formatMoney } from '../lib/format';
import { Modal } from './Modal';
import { SmartCombo } from './SmartCombo';

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="label">{label}</span>}
      {children}
      {hint ? <span className="tiny faint">{hint}</span> : null}
    </div>
  );
}

export function Stepper({
  value,
  onChange,
  min = 1,
  max = 9999,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="stepper">
      <button
        type="button"
        aria-label="Decrease quantity"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        aria-label="Quantity"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          onChange(Number.isFinite(parsed) ? clamp(Math.round(parsed)) : min);
        }}
      />
      <button
        type="button"
        aria-label="Increase quantity"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        +
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ money */

export interface ParsedAmount {
  /** The amount text with the currency code removed and the decimal normalized. */
  amount: string;
  /** null when the text is empty or not a usable non-negative number. */
  value: number | null;
  /** Set when the text carried an inline code, e.g. "150 cny". */
  currency?: string;
}

const CODE_RE = /^[A-Za-z]{3}$/;

/**
 * A 3-letter token next to an amount is taken as a code when the rates table
 * knows it; otherwise it gets one chance as a name ("yen" -> JPY) before the
 * old behavior (accept it verbatim, uppercased) applies.
 */
function resolveCurrencyToken(word: string): string {
  const up = word.toUpperCase();
  try {
    if (knownCurrencies().includes(up)) return up;
  } catch {
    return up;
  }
  return resolveCurrencyText(word) ?? up;
}

/**
 * Amount fields accept the currency inline ("150 cny", "cny 150") because it is
 * one field fewer to aim at on a phone. Comma decimals and thousands separators
 * are tolerated; anything left over is reported as unusable rather than guessed.
 */
export function parseAmountInput(raw: string): ParsedAmount {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { amount: '', value: null };

  let text = trimmed;
  let currency: string | undefined;
  const trailing = /^(.*?)\s*([A-Za-z]{3})$/.exec(trimmed);
  const leading = /^([A-Za-z]{3})\s*(.*)$/.exec(trimmed);
  // The letter guards keep a 3-letter regex from biting into a longer word:
  // "150 yuan" must not read as amount "150 y" with currency "UAN".
  if (trailing && /\d/.test(trailing[1]) && !/[A-Za-z]$/.test(trailing[1])) {
    text = trailing[1];
    currency = resolveCurrencyToken(trailing[2]);
  } else if (leading && /\d/.test(leading[2]) && !/^[A-Za-z]/.test(leading[2])) {
    text = leading[2];
    currency = resolveCurrencyToken(leading[1]);
  } else {
    // Currency by name: "150 yuan" -> CNY, "swiss franc 20" -> CHF. Only an
    // unambiguous name counts; anything else stays on the unusable-text path.
    const trailingWords = /^(.*\d\S*)\s+([A-Za-z][A-Za-z ]*)$/.exec(trimmed);
    const leadingWords = /^([A-Za-z][A-Za-z ]*[A-Za-z])\s+(\S*\d.*)$/.exec(trimmed);
    if (trailingWords) {
      const code = resolveCurrencyText(trailingWords[2]);
      if (code) {
        text = trailingWords[1];
        currency = code;
      }
    } else if (leadingWords) {
      const code = resolveCurrencyText(leadingWords[1]);
      if (code) {
        text = leadingWords[2];
        currency = code;
      }
    }
  }

  const cleaned = text.replace(/[\s\u00a0']/g, '');
  // A comma is the decimal point only when one or two digits follow it and end
  // the number ("1,5"); "1,500" is a thousands separator and means 1500.
  const normalized = /,\d{1,2}$/.test(cleaned)
    ? cleaned.replace(/,/g, '.')
    : cleaned.replace(/,/g, '');
  const value = Number(normalized);
  if (normalized === '' || !Number.isFinite(value) || value < 0) {
    return { amount: trimmed, value: null };
  }
  return { amount: normalized, value, currency };
}

/** Recent codes first, then the main currency, then everything the rates knew. */
export function useCurrencyOptions(mainCurrency?: string): string[] {
  return useMemo(() => {
    const out: string[] = [];
    const push = (code: string | undefined) => {
      const clean = (code ?? '').trim().toUpperCase();
      if (CODE_RE.test(clean) && !out.includes(clean)) out.push(clean);
    };
    try {
      for (const code of suggestInputs('currency')) push(code);
    } catch {
      /* history unavailable; the list is only a convenience */
    }
    push(mainCurrency);
    try {
      for (const code of knownCurrencies()) push(code);
    } catch {
      /* rates never loaded; typing the code still works */
    }
    return out;
  }, [mainCurrency]);
}

/** Combo options for the codes of useCurrencyOptions, with names and aliases. */
export function useCurrencyComboOptions(mainCurrency?: string): ComboOption[] {
  const codes = useCurrencyOptions(mainCurrency);
  return useMemo(() => codes.map(currencyComboOption), [codes]);
}

function CurrencyBox({
  value,
  options,
  onCommit,
  onFocus,
}: {
  value: string;
  options: ComboOption[];
  onCommit: (code: string) => void;
  onFocus?: () => void;
}) {
  return (
    <SmartCombo
      value={value}
      options={options}
      strict
      className="input cur"
      ariaLabel="Currency"
      onCommit={onCommit}
      onFocus={onFocus}
    />
  );
}

/** Small "what that is in the inventory currency" line. Silent when offline. */
function ConvertedHint({
  value,
  from,
  to,
}: {
  value: number | null;
  from: string;
  to?: string;
}) {
  const src = (from ?? '').trim().toUpperCase();
  const dst = (to ?? '').trim().toUpperCase();
  if (value === null || !CODE_RE.test(src) || !CODE_RE.test(dst) || src === dst) return null;
  let converted: number | null = null;
  try {
    converted = convert(value, src, dst);
  } catch {
    return null;
  }
  if (converted === null || !Number.isFinite(converted)) return null;
  return <span className="tiny faint">≈ {formatAmount(converted, dst)}</span>;
}

export function MoneyInput({
  label,
  amount,
  currency,
  onChange,
  placeholder,
  mainCurrency,
  hint,
}: {
  label: ReactNode;
  amount: string;
  currency: string;
  onChange: (amount: string, currency: string) => void;
  placeholder?: string;
  /** Inventory currency; enables the converted-value hint. */
  mainCurrency?: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const options = useCurrencyComboOptions(mainCurrency ?? currency);
  const parsed = parseAmountInput(amount);

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="money">
        <input
          id={id}
          className="input"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={placeholder ?? '0'}
          value={amount}
          onChange={(e) => onChange(e.target.value, currency)}
          onBlur={(e) => {
            // Unusable text stays on screen with its warning; nothing is guessed.
            const next = parseAmountInput(e.target.value);
            if (next.value === null) return;
            onChange(next.amount, next.currency ?? currency);
          }}
        />
        <CurrencyBox
          value={currency}
          options={options}
          onCommit={(code) => onChange(amount, code)}
        />
      </div>
      {amount.trim() !== '' && parsed.value === null ? (
        <span className="tiny warn-text">Not a number, so this value will not be saved.</span>
      ) : (
        <ConvertedHint value={parsed.value} from={currency} to={mainCurrency} />
      )}
    </Field>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span className="switch-text">
        <span>{label}</span>
        {description ? <span className="tiny muted">{description}</span> : null}
      </span>
    </label>
  );
}

/**
 * Local text buffer for a value that also arrives from sync: while the field
 * has focus, incoming updates are ignored so a remote echo cannot rewrite what
 * is being typed. The value is committed on blur.
 */
function useTextBuffer(value: string | undefined, onCommit: (value: string) => void) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(value ?? '');
  }, [value, focused]);

  return {
    value: draft,
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      const next = draft.trim();
      if (next !== (value ?? '').trim()) onCommit(next);
    },
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
  };
}

/** Bare edit-in-place input, for rows that supply their own label and layout. */
export function BufferedInput({
  value,
  onCommit,
  className = 'input',
  placeholder,
  ariaLabel,
}: {
  value: string | undefined;
  onCommit: (value: string) => void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const buffered = useTextBuffer(value, onCommit);
  return (
    <input
      className={className}
      aria-label={ariaLabel}
      placeholder={placeholder}
      {...buffered}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/**
 * Edit-in-place text field: keeps a local buffer while typing and commits on
 * blur (or Enter for single-line), so remote sync updates never fight the caret.
 */
export function InlineText({
  label,
  value,
  onCommit,
  multiline,
  placeholder,
  type = 'text',
  readonly,
  listId,
  hint,
}: {
  label: ReactNode;
  value: string | undefined;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  type?: 'text' | 'number' | 'date';
  readonly?: boolean;
  listId?: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const buffered = useTextBuffer(value, onCommit);

  if (readonly) {
    return (
      <Field label={label} hint={hint}>
        <p className={value ? '' : 'muted'} style={{ whiteSpace: 'pre-wrap' }}>
          {value || '—'}
        </p>
      </Field>
    );
  }

  const shared = { id, placeholder, ...buffered };

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      {multiline ? (
        <textarea className="textarea" {...shared} />
      ) : (
        <input
          className="input"
          type={type}
          inputMode={type === 'number' ? 'decimal' : undefined}
          list={listId}
          {...shared}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </Field>
  );
}

export function InlineSelect({
  label,
  value,
  options,
  onCommit,
  readonly,
  placeholder = 'Not set',
}: {
  label: ReactNode;
  value: string | undefined;
  options: Array<{ value: string; label: string }>;
  onCommit: (value: string) => void;
  readonly?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  if (readonly) {
    const match = options.find((o) => o.value === value);
    return (
      <Field label={label}>
        <p className={match ? '' : 'muted'}>{match?.label ?? '—'}</p>
      </Field>
    );
  }
  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        className="select"
        value={value ?? ''}
        onChange={(e) => onCommit(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Money editor for the item sheet: commits a whole MoneyValue on blur. */
export function InlineMoney({
  label,
  value,
  defaultCurrency,
  mainCurrency,
  onCommit,
  readonly,
}: {
  label: ReactNode;
  value: MoneyValue | undefined;
  defaultCurrency: string;
  /** Inventory currency; enables the converted-value hint. */
  mainCurrency?: string;
  onCommit: (value: MoneyValue | undefined) => void;
  readonly?: boolean;
}) {
  const id = useId();
  const options = useCurrencyComboOptions(mainCurrency ?? defaultCurrency);
  const [amount, setAmount] = useState(value ? String(value.amount) : '');
  const [currency, setCurrency] = useState(value?.currency ?? defaultCurrency);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (focused) return;
    setAmount(value ? String(value.amount) : '');
    setCurrency(value?.currency ?? defaultCurrency);
  }, [value, defaultCurrency, focused]);

  if (readonly) {
    return (
      <Field label={label}>
        <p className={value ? '' : 'muted'}>{formatMoney(value)}</p>
        <ConvertedHint
          value={value && Number.isFinite(value.amount) ? value.amount : null}
          from={value?.currency ?? ''}
          to={mainCurrency}
        />
      </Field>
    );
  }

  // The currency combo commits during its own blur, before React re-renders
  // this component, so the picked code arrives as an override.
  const commit = (codeOverride?: string) => {
    setFocused(false);
    const parsed = parseAmountInput(amount);
    const code = (parsed.currency ?? codeOverride ?? currency ?? defaultCurrency).toUpperCase();
    if (amount.trim() === '') {
      setCurrency(code);
      if (value) onCommit(undefined);
      return;
    }
    // Unusable text (a stray letter, a negative) drops the edit; the field
    // re-syncs to what is stored so nothing looks accepted that was not.
    if (parsed.value === null) {
      setAmount(value ? String(value.amount) : '');
      setCurrency(value?.currency ?? defaultCurrency);
      return;
    }
    setAmount(parsed.amount);
    setCurrency(code);
    if (parsed.value !== value?.amount || code !== value?.currency) {
      onCommit({ amount: parsed.value, currency: code });
    }
  };

  const preview = parseAmountInput(amount);

  return (
    <Field label={label}>
      <div className="money">
        <input
          id={id}
          className="input"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={typeof label === 'string' ? label : 'Amount'}
          value={amount}
          onFocus={() => setFocused(true)}
          onBlur={() => commit()}
          onChange={(e) => setAmount(e.target.value)}
        />
        <CurrencyBox
          value={currency}
          options={options}
          onFocus={() => setFocused(true)}
          onCommit={(code) => {
            setCurrency(code);
            commit(code);
          }}
        />
      </div>
      <ConvertedHint value={preview.value} from={currency} to={mainCurrency} />
    </Field>
  );
}

/* ------------------------------------------------------------- places */

/**
 * Location label with geocoded suggestions. Typing is always allowed to stand
 * on its own: offline, or when nothing matches, the free text is the answer.
 */
export function PlaceInput({
  label,
  hint,
  value,
  onChange,
  onPick,
  placeholder,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (text: string) => void;
  onPick: (hit: PlaceHit) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  // The text a suggestion just wrote must not immediately search for itself.
  const justPicked = useRef<string | null>(null);

  useEffect(() => {
    const query = value.trim();
    if (disabled || query.length < 3 || justPicked.current === query) {
      // Deleting back below the threshold must not leave the old list open.
      setSearching(false);
      setHits([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      void searchPlaces(query)
        .then((results) => {
          if (cancelled) return;
          setHits(results);
          setOpen(results.length > 0);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, disabled]);

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="place-input">
        <input
          id={id}
          className="input"
          type="text"
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            justPicked.current = null;
            onChange(e.target.value);
          }}
          onFocus={() => setOpen(hits.length > 0)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter') {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          onBlur={() => {
            // Late enough for a tap on a suggestion to land first.
            setTimeout(() => setOpen(false), 150);
          }}
        />
        {open && hits.length > 0 ? (
          <ul className="place-suggest">
            {hits.map((hit) => (
              <li key={`${hit.label}-${hit.lat}-${hit.lon}`}>
                <button
                  type="button"
                  className="place-hit"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    justPicked.current = hit.label.trim();
                    setHits([]);
                    setOpen(false);
                    onPick(hit);
                  }}
                >
                  {hit.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {searching ? <span className="tiny faint">Looking up places</span> : null}
    </Field>
  );
}

/* ---------------------------------------------------------------- ai review */

export type AiFieldKey =
  | 'description'
  | 'category'
  | 'tags'
  | 'brandModel'
  | 'valueCurrent'
  | 'valueNew'
  | 'weightGrams'
  | 'dimensionsMm'
  | 'lithiumBattery'
  | 'countryOfOrigin'
  | 'hsCode'
  | 'condition'
  | 'translations';

const AI_FIELD_LABEL: Record<AiFieldKey, string> = {
  description: 'Description',
  category: 'Category',
  tags: 'Tags',
  brandModel: 'Brand and model',
  valueCurrent: 'Value now',
  valueNew: 'Value when new',
  weightGrams: 'Exact weight',
  dimensionsMm: 'Exact size',
  lithiumBattery: 'Lithium battery',
  countryOfOrigin: 'Country of origin',
  hsCode: 'HS code',
  condition: 'Condition',
  translations: 'Translations',
};

interface AiRow {
  key: AiFieldKey;
  text: string;
}

/** One row per suggestion the model actually returned, already display-ready. */
function aiRows(suggestions: AiSuggestions): AiRow[] {
  const rows: AiRow[] = [];
  const push = (key: AiFieldKey, text: string | undefined) => {
    const clean = (text ?? '').trim();
    if (clean !== '') rows.push({ key, text: clean });
  };

  push('description', suggestions.description);
  push('category', suggestions.category);
  push('tags', (suggestions.tags ?? []).join(', '));
  push('brandModel', suggestions.brandModel);
  if (suggestions.valueCurrent) {
    push('valueCurrent', formatAmount(suggestions.valueCurrent.amount, suggestions.valueCurrent.currency));
  }
  if (suggestions.valueNew) {
    push('valueNew', formatAmount(suggestions.valueNew.amount, suggestions.valueNew.currency));
  }
  if (typeof suggestions.weightGrams === 'number' && suggestions.weightGrams > 0) {
    push('weightGrams', formatGrams(suggestions.weightGrams));
  }
  const dims = suggestions.dimensionsMm;
  if (dims && dims.l > 0 && dims.w > 0 && dims.h > 0) {
    push('dimensionsMm', `${formatMm(dims.l)} × ${formatMm(dims.w)} × ${formatMm(dims.h)}`);
  }
  if (typeof suggestions.lithiumBattery === 'boolean') {
    push('lithiumBattery', suggestions.lithiumBattery ? 'Yes' : 'No');
  }
  push('countryOfOrigin', suggestions.countryOfOrigin);
  push('hsCode', suggestions.hsCode);
  push('condition', suggestions.condition);
  const translations = Object.entries(suggestions.translations ?? {});
  if (translations.length > 0) {
    push('translations', translations.map(([lang, text]) => `${lang}: ${text}`).join(' · '));
  }
  return rows;
}

/**
 * Review panel for photo autofill. A field the user already filled starts
 * unchecked: the model may only add to the sheet unless it is told otherwise.
 */
export function AiReviewModal({
  suggestions,
  isFilled,
  onApply,
  onClose,
}: {
  suggestions: AiSuggestions;
  isFilled: (key: AiFieldKey) => boolean;
  onApply: (keys: Set<AiFieldKey>) => void;
  onClose: () => void;
}) {
  const rows = useMemo(() => aiRows(suggestions), [suggestions]);
  const [checked, setChecked] = useState<Set<AiFieldKey>>(
    () => new Set(rows.filter((row) => !isFilled(row.key)).map((row) => row.key)),
  );

  const toggle = (key: AiFieldKey) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (rows.length === 0) {
    return (
      <Modal
        title="Autofill from photos"
        onClose={onClose}
        footer={
          <button type="button" className="btn grow" onClick={onClose}>
            Close
          </button>
        }
      >
        <p className="small muted">The photos did not produce anything usable.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Autofill from photos"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={checked.size === 0}
            onClick={() => onApply(checked)}
          >
            Apply {checked.size}
          </button>
        </>
      }
    >
      <p className="small muted">
        Suggestions from the photos. Fields you already filled start unchecked.
      </p>
      <ul className="ai-list">
        {rows.map((row) => {
          const filled = isFilled(row.key);
          return (
            <li key={row.key}>
              <label className="ai-row">
                <input
                  type="checkbox"
                  checked={checked.has(row.key)}
                  onChange={() => toggle(row.key)}
                />
                <span className="ai-text">
                  <span className="tiny faint">
                    {AI_FIELD_LABEL[row.key]}
                    {filled ? ' · replaces what you entered' : ''}
                  </span>
                  <span className="ai-value">{row.text}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
