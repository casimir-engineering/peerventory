/**
 * Device relay management (Inventories page, "You & this device" area):
 * list/add/remove/enable relays, per-relay reachability dot, and the
 * device-wide "direct device-to-device sync" (WebRTC) toggle.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  addRelay,
  defaultRelayOrigin,
  getRelaysSnapshot,
  isP2pEnabled,
  relayHttpUrl,
  removeRelay,
  setP2pEnabled,
  setRelayEnabled,
  subscribeP2p,
  subscribeRelays,
} from '../../store';
import type { SyncStatus } from '../../store/contract';
import { Toggle } from './Fields';
import { useToast } from './Toast';

type Health = 'checking' | 'ok' | 'unreachable';

const healthToDot: Record<Health, SyncStatus> = {
  checking: 'connecting',
  ok: 'synced',
  unreachable: 'error',
};

async function probe(origin: string): Promise<Health> {
  try {
    const res = await fetch(`${relayHttpUrl(origin)}/health`, {
      signal: AbortSignal.timeout(6000),
    });
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export function RelaysSection() {
  const { toast, toastError } = useToast();
  const relays = useSyncExternalStore(subscribeRelays, getRelaysSnapshot);
  const p2pOn = useSyncExternalStore(subscribeP2p, isP2pEnabled);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [newUrl, setNewUrl] = useState('');
  const defaultOrigin = defaultRelayOrigin();

  // Reachability probe for every enabled relay whenever the list changes.
  useEffect(() => {
    let cancelled = false;
    for (const r of relays) {
      if (!r.enabled) continue;
      setHealth((h) => (h[r.url] ? h : { ...h, [r.url]: 'checking' }));
      void probe(r.url).then((result) => {
        if (!cancelled) setHealth((h) => ({ ...h, [r.url]: result }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [relays]);

  const add = () => {
    const result = addRelay(newUrl);
    if (result.ok) {
      setNewUrl('');
      toast('Relay added — new inventories will use it; use "replicate" on existing ones');
    } else {
      toastError(result.error ?? 'Could not add relay');
    }
  };

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <div className="profile-row" aria-label="Sync relays">
        <div className="grow">
          <div className="tiny faint">Sync relays (this device)</div>
          <div className="small">
            Interchangeable, self-hostable servers that only ever store encrypted data. Inventories
            can sync through several at once.
          </div>
        </div>
      </div>

      {relays.map((relay) => {
        const dot = relay.enabled ? healthToDot[health[relay.url] ?? 'checking'] : 'offline';
        return (
          <div className="profile-row" key={relay.url} aria-label={`Relay ${relay.url}`}>
            <span className={`n ${dot}`} aria-hidden="true" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small" style={{ overflowWrap: 'anywhere' }}>
                {relay.url.replace(/^https?:\/\//, '')}
              </div>
              <div className="tiny faint">
                {relay.url === defaultOrigin ? 'default · ' : ''}
                {!relay.enabled
                  ? 'disabled'
                  : (health[relay.url] ?? 'checking') === 'ok'
                    ? 'reachable'
                    : health[relay.url] === 'unreachable'
                      ? 'not reachable'
                      : 'checking…'}
              </div>
            </div>
            <button
              type="button"
              className="link-btn"
              onClick={() => setRelayEnabled(relay.url, !relay.enabled)}
            >
              {relay.enabled ? 'Disable' : 'Enable'}
            </button>
            {relay.url !== defaultOrigin ? (
              <button
                type="button"
                className="btn ghost icon sm"
                aria-label={`Remove relay ${relay.url}`}
                onClick={() => {
                  removeRelay(relay.url);
                  toast('Relay removed from this device');
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
        );
      })}

      <div className="row">
        <input
          className="input grow"
          value={newUrl}
          placeholder="Add relay, e.g. inv.example.com"
          aria-label="Add relay URL"
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newUrl.trim()) add();
          }}
        />
        <button type="button" className="btn" disabled={!newUrl.trim()} onClick={add}>
          Add
        </button>
      </div>

      <Toggle
        label="Direct device-to-device sync"
        description="Syncs inventories straight between your devices over the local network (WebRTC). Devices find each other through your own relays; the data never touches them."
        checked={p2pOn}
        onChange={setP2pEnabled}
      />
    </div>
  );
}
