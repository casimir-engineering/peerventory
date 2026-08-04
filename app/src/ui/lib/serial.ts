/*
 * Picks the serial number out of the handful of short lines an OCR pass returns
 * for a rating plate. Everything here works on one frame's worth of text: the
 * scanner is the part that decides when a value has been read reliably.
 */

/** A serial is an unbroken run of these, 5 to 30 long. */
const SHAPE = /^[A-Z0-9/.-]{5,30}$/;
const HAS_DIGIT = /[0-9]/;
const HAS_LETTER = /[A-Z]/;
const DIGITS_ONLY = /^[0-9]+$/;
const ALNUM_ONLY = /^[A-Z0-9]+$/;
/** 2024-01-15, 15/01/24 and friends: common on plates, never the serial. */
const DATE_LIKE = /^[0-9]{1,4}[.\-/][0-9]{1,2}[.\-/][0-9]{1,4}$/;
/** "100-240V", "50/60HZ": the ratings printed right next to the serial. */
const RATING_LIKE = /^[0-9][0-9./-]*(?:V|A|W|MA|VA|HZ|KW|MM|KG|MAH|VAC|VDC)$/;

/** Boilerplate that shares the shape of a serial once a digit lands in it. */
const NOISE = [
  'MODEL',
  'MADE',
  'JAPAN',
  'TAIWAN',
  'KOREA',
  'WWW',
  'HTTP',
  '.COM',
  '.CN',
  'PATENT',
  'RATED',
  'INPUT',
  'OUTPUT',
];

/** The value usually follows one of these, as in "S/N: ABC123". */
const LABELS = new Set([
  'S/N',
  'S/NO',
  'SN',
  'SNO',
  'SER',
  'SERIAL',
  'SERIALNO',
  'NO',
  'NUM',
  'NUMBER',
]);

/** Uppercase, cut on anything a serial cannot contain, drop edge punctuation. */
function tokenize(line: string): string[] {
  return line
    .toUpperCase()
    .split(/[^A-Z0-9/.-]+/)
    .map((token) => token.replace(/^[^A-Z0-9]+/, '').replace(/[^A-Z0-9]+$/, ''))
    .filter((token) => token !== '');
}

function isCandidate(token: string): boolean {
  if (!SHAPE.test(token) || !HAS_DIGIT.test(token)) return false;
  if (DIGITS_ONLY.test(token) && token.length < 6) return false;
  if (DATE_LIKE.test(token) || RATING_LIKE.test(token)) return false;
  return !NOISE.some((word) => token.includes(word));
}

/**
 * OCR often breaks one serial in two at a wide gap ("ABC 12345"). Only join
 * when the pieces are unconvincing on their own and the join is not, and only
 * across a prefix/number break, so that "RATED 12V" stays two words.
 */
function joinSplit(left: string, right: string | undefined): string | null {
  if (!right || !ALNUM_ONLY.test(left) || !ALNUM_ONLY.test(right)) return null;
  if (left.length < 2 || right.length < 2) return null;
  if (!HAS_DIGIT.test(left) && !(DIGITS_ONLY.test(right) && right.length >= 3)) return null;
  if (isCandidate(left) && isCandidate(right)) return null;
  const joined = left + right;
  return isCandidate(joined) ? joined : null;
}

interface Hit {
  value: string;
  score: number;
  order: number;
}

/** Serial-looking strings from one OCR pass, best first, deduped. */
export function extractSerialCandidates(rawLines: string[]): string[] {
  const hits = new Map<string, Hit>();
  let order = 0;
  // A line holding nothing but "SERIAL NO" labels the line under it.
  let carried = false;

  const add = (value: string, labelled: boolean) => {
    let score = labelled ? 100 : 0;
    if (HAS_LETTER.test(value) && HAS_DIGIT.test(value)) score += 20;
    if (value.length >= 8) score += 5;
    if (DIGITS_ONLY.test(value)) score -= 10;
    const seen = hits.get(value);
    if (!seen) hits.set(value, { value, score, order: order++ });
    else if (score > seen.score) seen.score = score;
  };

  for (const line of rawLines) {
    const tokens = tokenize(line);
    let labelled = carried;
    carried = tokens.length > 0 && tokens.every((token) => LABELS.has(token));
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (LABELS.has(token)) {
        labelled = true;
        continue;
      }
      if (isCandidate(token)) add(token, labelled);
      const joined = joinSplit(token, tokens[i + 1]);
      if (joined) add(joined, labelled);
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((hit) => hit.value);
}

/** Default matcher for the OCR scanner. */
export function matchSerial(lines: string[]): string | null {
  return extractSerialCandidates(lines)[0] ?? null;
}
