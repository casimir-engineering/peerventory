/**
 * Relay set: the list of sync-relay endpoints this device knows about.
 * Persisted in localStorage under 'relays:v1', reactive via subscribe().
 *
 * Relays are interchangeable dumb encrypted mailboxes (see CONTRACTS.md
 * "Multi-relay replication"): the same rw/ro tokens and content key work on
 * every relay a doc is pushed to, so no relay is special. Each inventory
 * handle additionally carries the relay origins it is known to live on
 * (InventoryHandle.relays); the device relay set supplies defaults and an
 * enable/disable switch.
 */
import type { Id } from '../types';
import { getStoredHandle } from './registry';

const KEY = 'relays:v1';

export interface RelayEntry {
  /** Normalized http(s) origin, e.g. https://inventory.example.com */
  url: string;
  enabled: boolean;
}

/**
 * The origin the app was configured with (same priority chain as
 * config.getServerConfig): runtime override > build-time origin > page origin.
 * This seeds the relay set and remains the fallback for docs without hints.
 */
export function defaultRelayOrigin(): string {
  const origin =
    (typeof localStorage !== 'undefined' ? localStorage.getItem('serverOrigin') : null) ??
    (import.meta.env.VITE_SERVER_ORIGIN as string | undefined) ??
    window.location.origin;
  return normalizeRelayUrl(origin) ?? origin;
}

/** Hosts that cannot realistically carry a TLS cert: default them to http. */
function isPlainHttpHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Normalize user input to an http(s) origin. Accepts bare hosts ("inv.example.com",
 * "192.168.1.20:8787"), ws(s):// and http(s):// URLs; strips paths. Bare hosts
 * default to https (except localhost/LAN addresses, which default to http);
 * an explicit scheme always wins.
 */
export function normalizeRelayUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  raw = raw.replace(/^ws(s?):\/\//i, 'http$1://');
  if (!/^https?:\/\//i.test(raw)) {
    const host = raw.split('/')[0].split(':')[0];
    raw = (isPlainHttpHost(host) ? 'http://' : 'https://') + raw;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function relayWsUrl(origin: string): string {
  return origin.replace(/^http/, 'ws') + '/sync';
}

export function relayHttpUrl(origin: string): string {
  return origin + '/api';
}

export function relaySignalingUrl(origin: string): string {
  return origin.replace(/^http/, 'ws') + '/signal';
}

let relays: RelayEntry[] = load();
let version = 0;
const listeners = new Set<() => void>();

function load(): RelayEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as RelayEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((r) => typeof r?.url === 'string');
      }
    }
  } catch {
    /* fall through to seeding */
  }
  return [{ url: defaultRelayOrigin(), enabled: true }];
}

function persistAndNotify(next: RelayEntry[]): void {
  relays = next;
  version++;
  try {
    localStorage.setItem(KEY, JSON.stringify(relays));
  } catch (err) {
    console.warn('[relays] failed to persist relay set', err);
  }
  for (const cb of listeners) cb();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    relays = load();
    version++;
    for (const cb of listeners) cb();
  });
}

export function subscribeRelays(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Stable array reference until the relay set changes (useSyncExternalStore). */
export function getRelaysSnapshot(): RelayEntry[] {
  return relays;
}

export function getRelaysVersion(): number {
  return version;
}

export function addRelay(input: string): { ok: boolean; error?: string } {
  const url = normalizeRelayUrl(input);
  if (!url) return { ok: false, error: 'Not a valid relay URL' };
  if (relays.some((r) => r.url === url)) return { ok: false, error: 'Relay already in the list' };
  persistAndNotify([...relays, { url, enabled: true }]);
  return { ok: true };
}

export function removeRelay(url: string): void {
  persistAndNotify(relays.filter((r) => r.url !== url));
}

export function setRelayEnabled(url: string, enabled: boolean): void {
  persistAndNotify(relays.map((r) => (r.url === url ? { ...r, enabled } : r)));
}

/** Origins of every enabled relay in the device relay set. */
export function enabledRelayOrigins(): string[] {
  return relays.filter((r) => r.enabled).map((r) => r.url);
}

/* ---------- share-link relay hints ----------
 * A share link's origin is *a* relay hint, not *the* server. The parse and
 * join steps are decoupled (the join route cannot carry an origin), so a
 * pasted/scanned link's origin is stashed here until joinInventory picks
 * it up. */

const hintKey = (docId: Id) => 'relayhint:' + docId;

export function rememberRelayHint(docId: Id, origin: string): void {
  const url = normalizeRelayUrl(origin);
  if (!url) return;
  try {
    sessionStorage.setItem(hintKey(docId), url);
  } catch {
    /* ignore */
  }
}

export function takeRelayHint(docId: Id): string | null {
  try {
    const url = sessionStorage.getItem(hintKey(docId));
    if (url) sessionStorage.removeItem(hintKey(docId));
    return url;
  } catch {
    return null;
  }
}

/** Union of relay lists, normalized and deduped (order preserved). */
export function mergeRelayLists(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const url = normalizeRelayUrl(raw);
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}

/**
 * The relay origins a doc should sync through:
 * - the origins recorded on its handle (each share link / replication adds one),
 * - falling back to the device's default relay when the handle has none,
 * - minus relays explicitly disabled in the device relay set (origins unknown
 *   to the device list are doc-specific hints and stay active).
 */
export function relayOriginsForDoc(docId: Id): string[] {
  const handleRelays = getStoredHandle(docId)?.relays ?? [];
  const base = handleRelays.length > 0 ? handleRelays : [defaultRelayOrigin()];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of base) {
    const url = normalizeRelayUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const entry = relays.find((r) => r.url === url);
    if (entry && !entry.enabled) continue;
    out.push(url);
  }
  return out.length > 0 ? out : [defaultRelayOrigin()];
}
