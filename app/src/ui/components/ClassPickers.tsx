import { useEffect, useId, useRef, useState } from 'react';
import { formatGrams, formatMm, parseLengthToMm, parseWeightToGrams } from '../../services';
import { SIZE_CLASSES, WEIGHT_CLASSES } from '../../types';
import type { Dimensions, SizeClass, Weight, WeightClass } from '../../types';

const WEIGHT_ORDER = Object.keys(WEIGHT_CLASSES) as WeightClass[];
const SIZE_ORDER = Object.keys(SIZE_CLASSES) as SizeClass[];

const ZERO_MM = { l: 0, w: 0, h: 0 };

type Mm = { l: number; w: number; h: number };

/** The class whose range holds this measurement; the open top class catches the rest. */
export function weightClassForGrams(grams: number): WeightClass {
  for (const key of WEIGHT_ORDER) {
    const max = WEIGHT_CLASSES[key].maxG;
    if (max === null || grams <= max) return key;
  }
  return 'gt20kg';
}

/** Smallest class whose representative volume still swallows the measured box. */
export function sizeClassForMm(mm: Mm): SizeClass {
  const liters = (mm.l * mm.w * mm.h) / 1_000_000;
  for (const key of SIZE_ORDER) {
    if (liters <= SIZE_CLASSES[key].approxLiters) return key;
  }
  return 'oversize';
}

/**
 * Weight and size are mandatory but must never slow entry down: one tap picks a
 * class, and a measurement typed in any unit ("0.2kg", "3 oz") picks the class
 * by itself. An explicit tap always wins over the derived class.
 */
export function WeightPicker({
  value,
  onChange,
  readonly,
}: {
  value: Weight | null;
  onChange: (weight: Weight | null) => void;
  readonly?: boolean;
}) {
  const classPicked = useRef(false);

  if (readonly) {
    return (
      <p>
        {value ? WEIGHT_CLASSES[value.class]?.label : '—'}
        {value?.exactGrams ? (
          <span className="muted"> · {formatGrams(value.exactGrams)} exact</span>
        ) : null}
      </p>
    );
  }

  const pickClass = (key: WeightClass) => {
    if (value?.class === key) {
      classPicked.current = false;
      onChange(null);
      return;
    }
    classPicked.current = true;
    onChange({ class: key, exactGrams: value?.exactGrams });
  };

  const commitGrams = (grams: number | undefined) => {
    if (grams === undefined) {
      onChange(value ? { class: value.class } : null);
      return;
    }
    const derived = weightClassForGrams(grams);
    onChange({ class: value && classPicked.current ? value.class : derived, exactGrams: grams });
  };

  const exactGrams = value?.exactGrams;
  const derived = typeof exactGrams === 'number' && exactGrams > 0 ? weightClassForGrams(exactGrams) : null;
  const mismatch = derived && value && derived !== value.class ? derived : null;

  return (
    <div className="stack tight">
      <div className="class-grid" role="group" aria-label="Weight class">
        {WEIGHT_ORDER.map((key) => (
          <button
            type="button"
            key={key}
            className="class-btn"
            aria-pressed={value?.class === key}
            onClick={() => pickClass(key)}
          >
            {WEIGHT_CLASSES[key].label}
          </button>
        ))}
      </div>

      <MeasureInput
        kind="weight"
        label="Exact weight (optional)"
        placeholder="840 g, 0.2 kg, 2 lb"
        value={exactGrams}
        onCommit={commitGrams}
      />

      {mismatch ? (
        <div className="field-note">
          <span className="tiny warn-text">
            {formatGrams(exactGrams ?? 0)} is outside the selected class.
          </span>
          <button
            type="button"
            className="fix-btn"
            onClick={() => {
              classPicked.current = false;
              onChange({ class: mismatch, exactGrams });
            }}
          >
            Use {WEIGHT_CLASSES[mismatch].label}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function SizePicker({
  value,
  onChange,
  readonly,
}: {
  value: Dimensions | null;
  onChange: (dimensions: Dimensions | null) => void;
  readonly?: boolean;
}) {
  const classPicked = useRef(false);
  // Dimensions cannot exist without a class, so a box measured before any class
  // was picked is held here until all three sides are in and a class follows.
  const [localMm, setLocalMm] = useState<Mm>(value?.exactMm ?? ZERO_MM);
  const storedKey = value?.exactMm
    ? `${value.exactMm.l}x${value.exactMm.w}x${value.exactMm.h}`
    : '';

  useEffect(() => {
    if (storedKey !== '') setLocalMm(value?.exactMm ?? ZERO_MM);
    // Only a change of the stored measurement may overwrite what is on screen;
    // a partially typed box (no class yet, nothing stored) has to survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  if (readonly) {
    const stored = value?.exactMm;
    return (
      <p>
        {value ? SIZE_CLASSES[value.class]?.label : '—'}
        {stored ? (
          <span className="muted">
            {' '}
            · {formatMm(stored.l)} × {formatMm(stored.w)} × {formatMm(stored.h)}
          </span>
        ) : null}
      </p>
    );
  }

  const complete = (mm: Mm) => mm.l > 0 && mm.w > 0 && mm.h > 0;
  const empty = (mm: Mm) => mm.l === 0 && mm.w === 0 && mm.h === 0;

  const pickClass = (key: SizeClass) => {
    if (value?.class === key) {
      classPicked.current = false;
      setLocalMm(ZERO_MM);
      onChange(null);
      return;
    }
    classPicked.current = true;
    onChange({ class: key, exactMm: empty(localMm) ? undefined : localMm });
  };

  const setAxis = (axis: 'l' | 'w' | 'h', mm: number | undefined) => {
    const next: Mm = { ...localMm, [axis]: mm ?? 0 };
    setLocalMm(next);
    if (value) {
      const cls = !classPicked.current && complete(next) ? sizeClassForMm(next) : value.class;
      onChange({ class: cls, exactMm: empty(next) ? undefined : next });
    } else if (complete(next)) {
      onChange({ class: sizeClassForMm(next), exactMm: next });
    }
  };

  const derived = complete(localMm) ? sizeClassForMm(localMm) : null;
  const mismatch = derived && value && derived !== value.class ? derived : null;

  return (
    <div className="stack tight">
      <div className="class-grid six" role="group" aria-label="Size class">
        {SIZE_ORDER.map((key) => (
          <button
            type="button"
            key={key}
            className="class-btn"
            aria-pressed={value?.class === key}
            onClick={() => pickClass(key)}
          >
            {SIZE_CLASSES[key].label}
          </button>
        ))}
      </div>

      <div className="field">
        <span className="label">Exact size (optional)</span>
        <div className="row">
          {(['l', 'w', 'h'] as const).map((axis) => (
            <MeasureInput
              key={axis}
              kind="length"
              ariaLabel={
                axis === 'l' ? 'Length' : axis === 'w' ? 'Width' : 'Height'
              }
              placeholder={axis === 'l' ? 'L' : axis === 'w' ? 'W' : 'H'}
              value={localMm[axis] > 0 ? localMm[axis] : undefined}
              onCommit={(mm) => setAxis(axis, mm)}
            />
          ))}
        </div>
        <span className="tiny faint">Millimetres unless a unit is written: 24 cm, 1.2 m, 9 in.</span>
      </div>

      {mismatch ? (
        <div className="field-note">
          <span className="tiny warn-text">The measured box does not match the selected class.</span>
          <button
            type="button"
            className="fix-btn"
            onClick={() => {
              classPicked.current = false;
              onChange({ class: mismatch, exactMm: localMm });
            }}
          >
            Use {SIZE_CLASSES[mismatch].label}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Measurement input that keeps its own text buffer: a remote sync tick (or the
 * echo of the value just written) must never rewrite what is being typed. The
 * text is parsed on blur, unparseable text snaps back to the stored value, and
 * what is shown afterwards is always the normalized form.
 *
 * The keyboard stays alphanumeric on purpose — a decimal keypad has no "kg".
 */
function MeasureInput({
  kind,
  label,
  ariaLabel,
  placeholder,
  value,
  onCommit,
}: {
  kind: 'weight' | 'length';
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
}) {
  const id = useId();
  const parse = kind === 'weight' ? parseWeightToGrams : parseLengthToMm;
  const format = kind === 'weight' ? formatGrams : formatMm;
  const shown = value === undefined ? '' : format(value);

  const [draft, setDraft] = useState(shown);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(value === undefined ? '' : format(value));
  }, [value, focused, format]);

  const commit = () => {
    setFocused(false);
    const raw = draft.trim();
    // Untouched text must not round-trip through the formatter: "1.23 m" would
    // come back as 1230 mm and quietly rewrite a stored 1234.
    if (raw === shown) {
      setDraft(shown);
      return;
    }
    if (raw === '') {
      if (value !== undefined) onCommit(undefined);
      setDraft('');
      return;
    }
    const parsed = parse(raw);
    if (parsed === null || !Number.isFinite(parsed)) {
      setDraft(shown);
      return;
    }
    if (parsed <= 0) {
      if (value !== undefined) onCommit(undefined);
      setDraft('');
      return;
    }
    const rounded = Math.round(parsed);
    setDraft(format(rounded));
    if (rounded !== value) onCommit(rounded);
  };

  const input = (
    <input
      id={id}
      className="input"
      type="text"
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );

  if (!label) return input;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {input}
    </div>
  );
}
