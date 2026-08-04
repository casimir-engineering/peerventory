import { useEffect, useRef, useState } from 'react';
import { matchOptions, resolveOption } from '../lib/combo';
import type { ComboOption } from '../lib/combo';
import './smartcombo.css';

/**
 * Text input with a ranked, filtered dropdown over a known set of values.
 * Typing "us dollar" offers USD; picking (tap, click, or Enter) writes the
 * canonical value. On blur, text that matches exactly one option is
 * auto-selected; otherwise a strict field reverts to its last value and a
 * non-strict field keeps the free text.
 */
export function SmartCombo({
  value,
  options,
  onCommit,
  onInput,
  onFocus,
  strict,
  id,
  className = 'input',
  placeholder,
  ariaLabel,
  maxVisible = 200,
}: {
  /** Committed value, shown while the field is not being edited. */
  value: string;
  options: ComboOption[];
  /** Fired with the canonical value on pick/resolve, or raw text on non-strict blur. */
  onCommit: (value: string) => void;
  /** Optional per-keystroke echo, for pages that keep the draft in state. */
  onInput?: (text: string) => void;
  onFocus?: () => void;
  /** Reject free text: blur without an unambiguous match reverts to `value`. */
  strict?: boolean;
  id?: string;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  maxVisible?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Distinguishes "just focused, still showing the old value" (browse all
  // options) from actual typing (filter). Comparing draft against `value`
  // cannot do this: with onInput the committed value follows every keystroke.
  const [typed, setTyped] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  // A pick must win over the blur that the same tap triggers on mobile.
  const pickedAt = useRef(0);

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  const query = draft.trim();
  const browsing = !typed || query === '';
  const visible = open ? matchOptions(options, browsing ? '' : query, maxVisible) : [];

  useEffect(() => {
    const active = menuRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const select = (option: ComboOption) => {
    pickedAt.current = Date.now();
    setDraft(option.value);
    setOpen(false);
    onInput?.(option.value);
    if (option.value !== value) onCommit(option.value);
  };

  /** Blur resolution: exact/unambiguous match wins, then strictness decides. */
  const finish = () => {
    setFocused(false);
    setOpen(false);
    const text = draft.trim();
    if (text === value.trim()) {
      setDraft(value);
      return;
    }
    const resolved = resolveOption(options, text);
    if (resolved) {
      setDraft(resolved.value);
      onInput?.(resolved.value);
      if (resolved.value !== value) onCommit(resolved.value);
      return;
    }
    if (strict) {
      setDraft(value);
      onInput?.(value);
      return;
    }
    onCommit(text);
  };

  return (
    <div className="combo">
      <input
        ref={inputRef}
        id={id}
        className={className}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        placeholder={placeholder}
        value={draft}
        onFocus={() => {
          setFocused(true);
          setOpen(true);
          setHighlight(0);
          setTyped(false);
          onFocus?.();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
          setHighlight(0);
          setTyped(true);
          onInput?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) {
              setOpen(true);
              setHighlight(0);
              return;
            }
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            setHighlight((h) => Math.min(Math.max(h + delta, 0), visible.length - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open && visible[highlight]) select(visible[highlight]);
            inputRef.current?.blur();
          } else if (e.key === 'Escape' && open) {
            // Only the dropdown closes; a surrounding modal keeps its own
            // Escape-to-close for the next press.
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onBlur={() => {
          // Late enough for a tap on an option to land first (see PlaceInput).
          window.setTimeout(() => {
            if (document.activeElement === inputRef.current) return;
            if (Date.now() - pickedAt.current < 400) {
              setFocused(false);
              setOpen(false);
              return;
            }
            finish();
          }, 150);
        }}
      />
      {open && visible.length > 0 ? (
        <ul className="combo-menu" role="listbox" ref={menuRef}>
          {visible.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlight}
                data-active={index === highlight}
                className={index === highlight ? 'combo-opt active' : 'combo-opt'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(option)}
              >
                <span className="combo-code">{option.value}</span>
                {option.label !== option.value ? (
                  <span className="combo-name">{option.label}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
