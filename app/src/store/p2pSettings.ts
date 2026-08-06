/**
 * Device-wide "direct device-to-device sync" toggle (default ON). Leaf module
 * so both p2p.ts and lan.ts can read it without an import cycle.
 */
const P2P_KEY = 'p2p:v1';

const p2pListeners = new Set<() => void>();

export function isP2pEnabled(): boolean {
  try {
    return localStorage.getItem(P2P_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setP2pEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(P2P_KEY, enabled ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  for (const cb of p2pListeners) cb();
}

export function subscribeP2p(cb: () => void): () => void {
  p2pListeners.add(cb);
  return () => p2pListeners.delete(cb);
}
