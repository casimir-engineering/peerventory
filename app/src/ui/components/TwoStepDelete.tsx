/**
 * Two-step deletion for anything that removes data without a confirm dialog.
 *
 * The first activation arms the control — it turns red, pulses once and says
 * "Tap again to delete" — and a second activation within a few seconds does
 * the deletion. The arming lapses on its own, so an accidental tap costs
 * nothing. Deletions that already ask through a modal keep the modal; the two
 * are alternatives, never stacked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const ARMED_MS = 5000;

export function useTwoStepAction(
  onConfirm: () => void,
  armedMs: number = ARMED_MS,
): { armed: boolean; trigger: () => void; disarm: () => void } {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clear, []);

  const disarm = useCallback(() => {
    clear();
    setArmed(false);
  }, []);

  const trigger = useCallback(() => {
    if (timer.current !== null) {
      clear();
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setArmed(false);
    }, armedMs);
  }, [onConfirm, armedMs]);

  return { armed, trigger, disarm };
}

export function TwoStepDeleteButton({
  onDelete,
  label,
  armedLabel = 'Tap again to delete',
  className = 'btn danger',
  disabled,
  children,
  armedChildren,
  resetKey,
}: {
  onDelete: () => void;
  /** What the button does, for the tooltip and the screen reader. */
  label: string;
  armedLabel?: string;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
  /** Label text while armed; icon buttons keep their glyph and omit this. */
  armedChildren?: ReactNode;
  /**
   * Disarms whenever this value changes. Buttons that act on a moving target
   * — a multi-selection, say — pass it so the second tap can never delete a
   * set the first tap did not describe.
   */
  resetKey?: unknown;
}) {
  const { armed, trigger, disarm } = useTwoStepAction(onDelete);
  const text = armed ? armedLabel : label;

  useEffect(() => {
    disarm();
  }, [resetKey, disarm]);

  return (
    <button
      type="button"
      className={`${className} two-step${armed ? ' armed' : ''}`}
      aria-label={text}
      title={text}
      disabled={disabled}
      onClick={trigger}
      onBlur={disarm}
    >
      {armed && armedChildren !== undefined ? armedChildren : children}
    </button>
  );
}
