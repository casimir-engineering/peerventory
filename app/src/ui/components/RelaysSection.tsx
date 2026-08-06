/**
 * Relay management (Account & sync page, "Sync & relays" card): the account
 * relay list (synced to every linked device; enable/disable stays
 * per-device), per-relay reachability dot, the device-wide "direct
 * device-to-device sync" (WebRTC) toggle, and — on Android — the LAN
 * discovery status. Adding a relay auto-replicates the account's OWN
 * inventories; a one-time prompt offers to replicate joined ones too.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  addRelay,
  canReplicate,
  defaultRelayOrigin,
  getHandlesSnapshot,
  getLanPeerCount,
  getRelaysSnapshot,
  isLanSupported,
  isOwnedInventory,
  isP2pEnabled,
  relayHttpUrl,
  removeRelay,
  replicateToMyRelays,
  setP2pEnabled,
  setRelayEnabled,
  subscribeLan,
  subscribeP2p,
  subscribeRelays,
} from '../../store';
import type { InventoryHandle } from '../../types';
import type { SyncStatus } from '../../store/contract';
import { Toggle } from './Fields';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { TwoStepDeleteButton } from './TwoStepDelete';

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
  const lanPeers = useSyncExternalStore(subscribeLan, getLanPeerCount);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [newUrl, setNewUrl] = useState('');
  const [replicateJoined, setReplicateJoined] = useState<InventoryHandle[] | null>(null);
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
      toast('Relay added — your own inventories replicate to it automatically');
      // One-time prompt: inventories shared WITH you never replicate on
      // their own; offer it now for the ones that hold both tokens.
      const joined = getHandlesSnapshot().filter(
        (h) => !isOwnedInventory(h) && canReplicate(h),
      );
      if (joined.length > 0) setReplicateJoined(joined);
    } else {
      toastError(result.error ?? 'Could not add relay');
    }
  };

  const replicateJoinedNow = async (handles: InventoryHandle[]) => {
    setReplicateJoined(null);
    let ok = 0;
    for (const h of handles) {
      try {
        await replicateToMyRelays(h.docId);
        ok++;
      } catch {
        /* per-inventory failure: the button on its Settings page remains */
      }
    }
    if (ok > 0) toast(`Replicating ${ok} shared inventor${ok === 1 ? 'y' : 'ies'} to your relays`);
    else toastError('Could not replicate the shared inventories');
  };

  return (
    <div className="stack">
      {relays.map((relay) => {
        const dot = relay.enabled ? healthToDot[health[relay.url] ?? 'checking'] : 'offline';
        return (
          <div className="profile-row" key={relay.url} aria-label={`Relay ${relay.url}`}>
            <span className={`sync-dot ${dot}`} aria-hidden="true" />
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
              <TwoStepDeleteButton
                className="btn ghost icon sm"
                label={`Remove relay ${relay.url}`}
                armedLabel="Tap again to remove this relay"
                onDelete={() => {
                  removeRelay(relay.url);
                  toast('Relay removed from this device');
                }}
              >
                ✕
              </TwoStepDeleteButton>
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

      <p className="tiny faint">
        The relay list is shared by all devices of your account; enabling or disabling one only
        affects this device. Your own inventories replicate to every enabled relay automatically.
      </p>

      <Toggle
        label="Direct device-to-device sync"
        description="Syncs inventories straight between your devices (WebRTC). Devices meet through any of your relays — or find each other directly on the same Wi-Fi (Android) — and the data never touches a server. Connected devices also introduce each other to peers they cannot reach themselves."
        checked={p2pOn}
        onChange={setP2pEnabled}
      />
      {isLanSupported() && p2pOn ? (
        <p className="tiny faint">
          Nearby on this network: {lanPeers} device{lanPeers === 1 ? '' : 's'} found via local
          discovery.
        </p>
      ) : null}

      {replicateJoined ? (
        <Modal
          title="Also replicate shared inventories?"
          onClose={() => setReplicateJoined(null)}
          footer={
            <>
              <button type="button" className="btn grow" onClick={() => setReplicateJoined(null)}>
                Not now
              </button>
              <button
                type="button"
                className="btn primary grow"
                onClick={() => void replicateJoinedNow(replicateJoined)}
              >
                Replicate
              </button>
            </>
          }
        >
          <p className="small muted">
            Inventories you created replicate to the new relay automatically. These were shared
            with you, so they are only pushed to your relays if you ask:
          </p>
          <div className="list-rows">
            {replicateJoined.map((h) => (
              <div className="list-row" key={h.docId} style={{ cursor: 'default' }}>
                <span className="small grow">{h.name ?? h.docId}</span>
              </div>
            ))}
          </div>
          <p className="tiny faint">
            You can always do this later per inventory (Settings → Replicate to all my relays).
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
