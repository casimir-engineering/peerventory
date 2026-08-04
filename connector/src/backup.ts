/**
 * Decodes the app's profile share / backup link
 * (`https://<origin>/#/restore/<base64url payload>`, see
 * app/src/services/backup.ts and CONTRACTS.md "Share links, backups").
 *
 * The origin in the link IS the relay origin (one host serves the PWA,
 * /sync and /api), so pasting the link gives the extension everything:
 * server address, tokens and content keys.
 *
 * The backup payload may also carry the user's Anthropic AI key (`k`). The
 * connector intentionally DROPS it — AI copywriting stays in the app, the
 * extension must never hold that key.
 */

import type { Profile, ProfileHandle } from './types';

interface WirePayload {
  v: 1 | 2;
  n?: string;
  h: Array<{ d: string; rw?: string; ro?: string; ek?: string; nm?: string }>;
}

const RESTORE_RE = /\/restore\/([A-Za-z0-9_-]{8,})/;

function fromBase64Url(payload: string): string | null {
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export interface ParsedProfileLink {
  payload: string;
  /** null when the user pasted a bare payload instead of the full URL. */
  origin: string | null;
}

/** Accepts the full restore URL, a bare `#/restore/...` fragment, or the raw payload. */
export function parseProfileLink(text: string): ParsedProfileLink | null {
  const trimmed = text.trim();
  const match = RESTORE_RE.exec(trimmed);
  if (match) {
    let origin: string | null = null;
    try {
      const url = new URL(trimmed);
      if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
    } catch {
      origin = null;
    }
    return { payload: match[1], origin };
  }
  // A bare payload is a base64url blob that decodes to the wire JSON.
  if (/^[A-Za-z0-9_-]{8,}$/.test(trimmed) && decodeHandles(trimmed)) {
    return { payload: trimmed, origin: null };
  }
  return null;
}

export function decodeHandles(
  payload: string,
): { userName?: string; handles: ProfileHandle[] } | null {
  const json = fromBase64Url(payload);
  if (!json) return null;
  try {
    const wire = JSON.parse(json) as WirePayload;
    if ((wire.v !== 1 && wire.v !== 2) || !Array.isArray(wire.h)) return null;
    return {
      userName: typeof wire.n === 'string' && wire.n ? wire.n : undefined,
      handles: wire.h
        .filter((h) => typeof h?.d === 'string' && h.d)
        .map((h) => ({
          docId: h.d,
          rwToken: typeof h.rw === 'string' ? h.rw : undefined,
          roToken: typeof h.ro === 'string' ? h.ro : undefined,
          key: typeof h.ek === 'string' ? h.ek : undefined,
          name: typeof h.nm === 'string' ? h.nm : undefined,
        })),
    };
  } catch {
    return null;
  }
}

/** Builds the stored profile from a pasted link (origin may come from a separate input). */
export function buildProfile(text: string, fallbackOrigin?: string): Profile | null {
  const parsed = parseProfileLink(text);
  if (!parsed) return null;
  const decoded = decodeHandles(parsed.payload);
  if (!decoded || decoded.handles.length === 0) return null;
  const origin = (parsed.origin ?? fallbackOrigin ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(origin)) return null;
  return {
    origin,
    userName: decoded.userName,
    handles: decoded.handles,
    importedAt: Date.now(),
  };
}

/** Read access is all the connector needs; fall back to the rw token only when ro is absent. */
export function syncToken(handle: ProfileHandle): string | null {
  return handle.roToken ?? handle.rwToken ?? null;
}
