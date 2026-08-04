/**
 * Per-device Anthropic API key. Lives only in this device's localStorage:
 * never written into the synced document, never sent to the sync server.
 * Provisioned by pasting in settings or scanning an `inv-ai:<key>` QR code.
 */

const KEY = 'aiKey:v1';

export const AI_KEY_QR_PREFIX = 'inv-ai:';

export function getAiKey(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function setAiKey(key: string): void {
  try {
    const v = key.trim();
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the key just won't persist
  }
}

export function clearAiKey(): void {
  setAiKey('');
}

/** "sk-ant-…A1gAA" for display; never show the middle. */
export function maskedAiKey(): string | null {
  const key = getAiKey();
  if (!key) return null;
  if (key.length <= 14) return '•'.repeat(key.length);
  return `${key.slice(0, 7)}…${key.slice(-5)}`;
}

/** Payload of a provisioning QR code, or null if this is not one. */
export function parseAiKeyQr(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith(AI_KEY_QR_PREFIX)) return null;
  const key = t.slice(AI_KEY_QR_PREFIX.length).trim();
  return key.length >= 20 ? key : null;
}
