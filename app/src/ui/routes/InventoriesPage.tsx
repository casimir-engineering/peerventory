import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import * as services from '../../services';
import {
  getDeviceId,
  getProfileStatus,
  rememberRelayHint,
  snapshotInventory,
  subscribeProfileStatus,
  useInventories,
} from '../../store';
import type { UseInventoriesResult } from '../../store/contract';
import type { Id, InventoryHandle, InventorySnapshot, Item } from '../../types';
import { formatAmount, formatMoney } from '../lib/format';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, SectionTitle, Spinner } from '../components/Common';
import { PhotoImage } from '../components/Photos';
import { Field, Toggle, useCurrencyComboOptions } from '../components/Fields';
import { SmartCombo } from '../components/SmartCombo';
import { AccountRestoreModal } from '../components/AccountRestoreModal';
import { ImportModal } from '../components/ImportModal';
import { ConfirmModal, Modal } from '../components/Modal';
import { QrCanvas } from '../components/QrCanvas';
import { QrScanner } from '../components/QrScanner';
import { RelaysSection } from '../components/RelaysSection';
import { useToast } from '../components/Toast';
import { buildAccountBackup } from '../lib/accountBackup';
import { buildBackupUrl, copyToClipboard, joinRoute, parseShareLink } from '../lib/links';
import type { ParsedAccount, ParsedImport } from '../lib/importFile';
import { parseImportFile } from '../lib/importFile';
import { decodeQrImage } from '../lib/qrDecode';
import { dataUrlToBlob, useFileSaver } from '../lib/saveFile';

const NAME_WELCOME_DISMISSED = 'profile-name-welcome-dismissed:v1';
const CONFIG_OPEN = 'inventories-config-open:v1';

function configWasOpen(): boolean {
  try {
    return localStorage.getItem(CONFIG_OPEN) === '1';
  } catch {
    return false;
  }
}

function rememberConfigOpen(open: boolean) {
  try {
    localStorage.setItem(CONFIG_OPEN, open ? '1' : '0');
  } catch {
    // A locked-down WebView may not expose persistent storage.
  }
}

function nameWelcomeWasDismissed(): boolean {
  try {
    return localStorage.getItem(NAME_WELCOME_DISMISSED) === '1';
  } catch {
    return false;
  }
}

function rememberNameWelcomeDismissal() {
  try {
    localStorage.setItem(NAME_WELCOME_DISMISSED, '1');
  } catch {
    // A locked-down WebView may not expose persistent storage.
  }
}

/* ---------------- cross-inventory item search ---------------- */

const SEARCH_DEBOUNCE_MS = 150;
const MAX_SEARCH_RESULTS = 50;

interface SearchableInventory {
  docId: Id;
  inventoryName: string;
  currency: string;
  items: Item[];
}

interface SearchResult {
  docId: Id;
  inventoryName: string;
  item: Item;
  /** Lower ranks sort first (0 = name match). */
  rank: number;
}

/** ~150ms trailing debounce so search keeps up with typing without thrashing. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Local snapshots of every inventory on this device, loaded lazily the first
 * time the search is used. snapshotInventory only waits for IndexedDB
 * persistence — it never blocks on the network (same mechanism the per-row
 * stats below use).
 */
function useSearchableInventories(active: boolean, handles: InventoryHandle[]): {
  inventories: SearchableInventory[];
  loading: boolean;
} {
  const [inventories, setInventories] = useState<SearchableInventory[] | null>(null);
  // Reload when the set of inventories or their sync state changes.
  const handlesKey = handles.map((h) => `${h.docId}:${h.lastSyncedAt ?? 0}`).join(',');

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void Promise.all(
      handles.map(async (handle): Promise<SearchableInventory | null> => {
        try {
          const snap = await snapshotInventory(handle.docId);
          return {
            docId: handle.docId,
            inventoryName: snap.meta.name || handle.name || 'Untitled inventory',
            currency: snap.meta.currency || 'USD',
            items: snap.items,
          };
        } catch {
          return null; // e.g. missing encryption key; skip this inventory
        }
      }),
    ).then((loaded) => {
      if (alive) setInventories(loaded.filter((s): s is SearchableInventory => s !== null));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, handlesKey]);

  return { inventories: inventories ?? [], loading: active && inventories === null };
}

function lastLocationLabel(item: Item): string | undefined {
  const history = item.locationHistory ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const label = history[i]?.label?.trim();
    if (label) return label;
  }
  return undefined;
}

/**
 * Case-insensitive substring match over name/description, brand/model,
 * category, serial number, condition and location label. Every whitespace-
 * separated word must match; items whose NAME matches rank first.
 */
function searchAllInventories(inventories: SearchableInventory[], query: string): SearchResult[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const results: SearchResult[] = [];
  for (const inv of inventories) {
    for (const item of inv.items) {
      const name = (item.description || '').toLowerCase();
      const rest = [
        item.brandModel,
        item.category,
        item.serialNumber,
        item.condition,
        lastLocationLabel(item),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!words.every((w) => name.includes(w) || rest.includes(w))) continue;
      results.push({
        docId: inv.docId,
        inventoryName: inv.inventoryName,
        item,
        rank: words.every((w) => name.includes(w)) ? 0 : 1,
      });
    }
  }
  results.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.item.description || '').localeCompare(b.item.description || ''),
  );
  return results.slice(0, MAX_SEARCH_RESULTS);
}

function SearchResultRow({ result }: { result: SearchResult }) {
  const { docId, inventoryName, item } = result;
  const cover = item.photos?.[0]?.hash ?? null;
  const location = lastLocationLabel(item);
  const detail = [inventoryName, item.valueCurrent ? formatMoney(item.valueCurrent) : null, location]
    .filter(Boolean)
    .join(' · ');
  return (
    <Link className="list-row" to={`/inv/${docId}/i/${item.id}`}>
      <PhotoImage docId={docId} hash={cover} alt="" className="thumb sm" />
      <div className="grow">
        <div style={{ fontWeight: 600 }}>{item.description || 'Untitled item'}</div>
        <div className="tiny faint">{detail}</div>
      </div>
      <span className="muted" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

export function InventoriesPage() {
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const { handles, createInventory, unlinkDevice }: UseInventoriesResult = useInventories();

  const [creating, setCreating] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [joining, setJoining] = useState(false);
  const [userName, setUserNameState] = useState(() => services.getUserName());
  const [nameModal, setNameModal] = useState<'welcome' | 'edit' | null>(() =>
    userName === null && !nameWelcomeWasDismissed() ? 'welcome' : null,
  );
  const [aiKeyMasked, setAiKeyMasked] = useState(() => services.maskedAiKey());
  const [aiKeyModal, setAiKeyModal] = useState(false);
  const [backupModal, setBackupModal] = useState(false);
  const [importState, setImportState] = useState<{ parsed: ParsedImport; fileName: string } | null>(
    null,
  );
  const [accountRestore, setAccountRestore] = useState<{
    account: ParsedAccount;
    fileName: string;
  } | null>(null);
  const [configOpen, setConfigOpen] = useState(configWasOpen);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const debouncedQuery = useDebounced(searchQuery, SEARCH_DEBOUNCE_MS);
  const searching = debouncedQuery.trim().length > 0;
  // Snapshots load on the first keystroke and stay warm afterwards.
  const [searchTouched, setSearchTouched] = useState(false);
  const { inventories: searchable, loading: searchLoading } = useSearchableInventories(
    searchTouched,
    handles,
  );
  const searchResults = useMemo(
    () => (searching ? searchAllInventories(searchable, debouncedQuery) : []),
    [searching, searchable, debouncedQuery],
  );

  /**
   * One entry point for anything scanned, pasted, or decoded from an image.
   * Always returns a reason when it refuses: a scanner that silently ignores
   * a code the user is pointing at is indistinguishable from a broken camera.
   */
  const handleScannedText = useCallback(
    (text: string): { ok: true } | { ok: false; reason: string } => {
      const aiKey = services.parseAiKeyQr(text);
      if (aiKey) {
        services.setAiKey(aiKey);
        setAiKeyMasked(services.maskedAiKey());
        setJoining(false);
        toast('Claude API key installed on this device');
        return { ok: true };
      }
      const backupPayload = services.parseBackupText(text);
      if (backupPayload) {
        setJoining(false);
        navigate(`/restore/${backupPayload}`);
        return { ok: true };
      }
      const parsed = parseShareLink(text);
      if (!parsed) {
        return {
          ok: false,
          reason: /^https?:\/\//i.test(text.trim())
            ? 'That is a web link, but not an inventory or device code.'
            : 'That code is not an inventory link or device code.',
        };
      }
      // A pasted/scanned link's origin is a relay hint the join flow records.
      if (parsed.origin) rememberRelayHint(parsed.docId, parsed.origin);
      setJoining(false);
      navigate(joinRoute(parsed));
      return { ok: true };
    },
    [navigate, toast],
  );

  /**
   * Dispatch a dropped or picked file: QR image, single inventory export
   * (ZIP/YAML), or a full-account backup ZIP.
   */
  const handleFile = useCallback(
    async (file: File) => {
      const name = file.name.toLowerCase();
      const isData =
        name.endsWith('.zip') ||
        name.endsWith('.yaml') ||
        name.endsWith('.yml') ||
        file.type === 'application/zip';
      if (isData) {
        try {
          const result = await parseImportFile(file);
          if (result.kind === 'account') {
            setAccountRestore({ account: result.account, fileName: file.name });
          } else {
            setImportState({ parsed: result.parsed, fileName: file.name });
          }
        } catch (err) {
          toastError(err instanceof Error ? err.message : 'Could not read this file');
        }
        return;
      }
      if (file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(name)) {
        const text = await decodeQrImage(file);
        if (!text) {
          toastError('No QR code found in this image');
          return;
        }
        const outcome = handleScannedText(text);
        if (!outcome.ok) toastError(outcome.reason);
        return;
      }
      toastError('Drop a .zip or .yaml export, or a QR code image');
    },
    [handleScannedText, toastError],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={onDrop}
    >
      {dragActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">
            Drop an account backup, a .zip / .yaml export, or a QR image
          </div>
        </div>
      ) : null}
      <AppHeader
        title="Inventories"
        subtitle="Local-first packing and customs manifests"
        actions={
          <button type="button" className="btn ghost sm" onClick={() => setJoining(true)}>
            Open / Scan
          </button>
        }
      />

      <main className="page narrow">
        <div className="stack">
          <section aria-label="Profile and device settings">
            <button
              type="button"
              className="profile-row config-toggle"
              aria-expanded={configOpen}
              onClick={() => {
                setConfigOpen((open) => {
                  rememberConfigOpen(!open);
                  return !open;
                });
              }}
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                <div className="tiny faint">You &amp; this device</div>
                <div className="small">
                  {userName || 'Name not set'}
                  {' · '}
                  {aiKeyMasked ? 'AI key set' : 'no AI key'}
                </div>
              </div>
              <span className={`chevron${configOpen ? ' open' : ''}`} aria-hidden="true">
                ›
              </span>
            </button>

            {configOpen ? (
              <div className="stack" style={{ marginTop: 8 }}>
                <div className="profile-row" aria-label="Your profile">
                  <div className="grow">
                    <div className="tiny faint">You</div>
                    <div className="small">{userName || 'Name not set'}</div>
                  </div>
                  <button type="button" className="link-btn" onClick={() => setNameModal('edit')}>
                    {userName ? 'Change' : 'Set your name'}
                  </button>
                </div>

                <div className="profile-row" aria-label="AI key">
                  <div className="grow">
                    <div className="tiny faint">Claude API key (this device only)</div>
                    <div className="small">{aiKeyMasked ?? 'Not set — AI autofill disabled'}</div>
                  </div>
                  <button type="button" className="link-btn" onClick={() => setAiKeyModal(true)}>
                    {aiKeyMasked ? 'Change' : 'Add key'}
                  </button>
                </div>

                <div className="profile-row" aria-label="Backup and import">
                  <div className="grow">
                    <div className="tiny faint">This device</div>
                    <div className="small">
                      Link devices, back up, or import data
                      {' · '}
                      <ProfileSyncStatus />
                    </div>
                  </div>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => importInputRef.current?.click()}
                  >
                    Import file
                  </button>
                  <button type="button" className="link-btn" onClick={() => setBackupModal(true)}>
                    Link / backup
                  </button>
                </div>

                <div className="profile-row" aria-label="Account">
                  <div className="grow">
                    <div className="tiny faint">Account</div>
                    <div className="small">
                      {handles.length} inventor{handles.length === 1 ? 'y' : 'ies'} synced across
                      your linked devices
                    </div>
                  </div>
                  <button
                    type="button"
                    className="link-btn danger"
                    onClick={() => setConfirmUnlink(true)}
                  >
                    Unlink this device
                  </button>
                </div>

                <RelaysSection />
              </div>
            ) : null}

            <input
              ref={importInputRef}
              type="file"
              accept=".zip,.yaml,.yml,image/*"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleFile(file);
              }}
            />
          </section>

          {handles.length > 0 ? (
            <div className="search">
              <input
                className="input"
                type="search"
                value={searchQuery}
                placeholder="Search items in all inventories"
                aria-label="Search items in all inventories"
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (e.target.value.trim()) setSearchTouched(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearchQuery('');
                  } else if (e.key === 'Enter' && searchResults.length > 0) {
                    e.preventDefault();
                    const first = searchResults[0];
                    navigate(`/inv/${first.docId}/i/${first.item.id}`);
                  }
                }}
              />
            </div>
          ) : null}

          {handles.length === 0 ? (
            <EmptyState
              glyph="▤"
              title="No inventories yet"
              body="Create one per shipment or per room. Everything is stored on this device first and synced when a connection is available."
              action={
                <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                  Create inventory
                </button>
              }
            />
          ) : searching ? (
            searchLoading ? (
              <p className="small muted">Searching…</p>
            ) : searchResults.length === 0 ? (
              <EmptyState
                title="No matching items"
                body="No item in any inventory on this device matches this search."
                action={
                  <button type="button" className="btn" onClick={() => setSearchQuery('')}>
                    Clear search
                  </button>
                }
              />
            ) : (
              <>
                <SectionTitle>
                  {searchResults.length === MAX_SEARCH_RESULTS
                    ? `First ${MAX_SEARCH_RESULTS} matching items`
                    : `${searchResults.length} matching item${searchResults.length === 1 ? '' : 's'}`}
                </SectionTitle>
                <div className="card flush">
                  <div className="list-rows">
                    {searchResults.map((result) => (
                      <SearchResultRow key={`${result.docId}:${result.item.id}`} result={result} />
                    ))}
                  </div>
                </div>
              </>
            )
          ) : (
            <>
            <SectionTitle>On this device</SectionTitle>
            <div className="card flush">
              <div className="list-rows">
                {handles.map((handle: InventoryHandle) => (
                  <InventoryRow key={handle.docId} handle={handle} />
                ))}
              </div>
            </div>
            <p className="tiny faint">
              Opening a shared link adds it here. Inventories appear on all devices linked to your
              profile; forgetting one removes it from their lists too.
            </p>
            </>
          )}
        </div>
      </main>

      <button type="button" className="fab" onClick={() => setCreating(true)}>
        <span className="glyph" aria-hidden="true">
          +
        </span>
        New inventory
      </button>

      {creating ? (
        <CreateInventoryModal
          onClose={() => setCreating(false)}
          onCreate={async (name, currency, ownerTrackingEnabled, preciseLocation) => {
            try {
              const handle: InventoryHandle = await createInventory(name, {
                currency,
                ownerTrackingEnabled,
                preciseLocation,
              });
              setCreating(false);
              toast('Inventory created');
              navigate(`/inv/${handle.docId}`);
            } catch (err) {
              toastError(err instanceof Error ? err.message : 'Could not create the inventory');
            }
          }}
        />
      ) : null}

      {joining ? (
        <JoinLinkModal
          onClose={() => setJoining(false)}
          onOpen={handleScannedText}
          onUploadImage={(file) => void handleFile(file)}
        />
      ) : null}

      {backupModal ? <BackupModal onClose={() => setBackupModal(false)} /> : null}

      {confirmUnlink ? (
        <ConfirmModal
          title="Unlink this device?"
          body={`This device will leave the account and delete its ${handles.length} inventor${handles.length === 1 ? 'y' : 'ies'}, photos and access tokens from this phone. Your other devices keep everything. To come back later, scan the device-link code from one of them.`}
          confirmLabel="Unlink"
          destructive
          onClose={() => setConfirmUnlink(false)}
          onConfirm={() => {
            toast('Unlinking…');
            unlinkDevice()
              .then(() => toast('This device left the account'))
              .catch((err: unknown) =>
                toastError(err instanceof Error ? err.message : 'Could not unlink this device'),
              );
          }}
        />
      ) : null}

      {accountRestore ? (
        <AccountRestoreModal
          account={accountRestore.account}
          fileName={accountRestore.fileName}
          onClose={() => setAccountRestore(null)}
          onRestored={(summary) => {
            setAccountRestore(null);
            toast(summary);
          }}
        />
      ) : null}

      {importState ? (
        <ImportModal
          parsed={importState.parsed}
          fileName={importState.fileName}
          onClose={() => setImportState(null)}
          onImported={(docId) => {
            setImportState(null);
            toast('Inventory imported');
            navigate(`/inv/${docId}`);
          }}
        />
      ) : null}

      {aiKeyModal ? (
        <AiKeyModal
          hasKey={aiKeyMasked !== null}
          onClose={() => setAiKeyModal(false)}
          onSave={(key) => {
            services.setAiKey(key);
            setAiKeyMasked(services.maskedAiKey());
            setAiKeyModal(false);
            toast(key ? 'API key saved on this device' : 'API key removed');
          }}
        />
      ) : null}

      {nameModal ? (
        <NameModal
          welcome={nameModal === 'welcome'}
          initialValue={userName ?? ''}
          onClose={() => {
            if (nameModal === 'welcome') rememberNameWelcomeDismissal();
            setNameModal(null);
          }}
          onSave={(name) => {
            services.setUserName(name);
            setUserNameState(name);
            setNameModal(null);
            toast('Name saved');
          }}
        />
      ) : null}
    </div>
  );
}

/** Subtle live status of the profile (device group) sync. */
function ProfileSyncStatus() {
  const status = useSyncExternalStore(subscribeProfileStatus, getProfileStatus);
  const label =
    status === 'synced'
      ? 'devices in sync'
      : status === 'connecting'
        ? 'linking…'
        : status === 'error'
          ? 'device link error'
          : 'offline';
  return <span className="faint">{label}</span>;
}

function formatAgo(epochMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

interface RowStats {
  itemCount: number;
  valueText: string | null;
  weightText: string | null;
  volumeText: string | null;
  peerLabel: string | null;
}

function computeRowStats(snap: InventorySnapshot): RowStats {
  const items = snap.items;
  const main = snap.meta.currency || 'USD';

  let value = 0;
  let unconverted = 0;
  let grams = 0;
  let weightEstimated = false;
  let m3 = 0;
  let volumeEstimated = false;

  for (const item of items) {
    const qty = item.quantity ?? 1;
    if (item.valueCurrent) {
      const converted = services.convert(item.valueCurrent.amount, item.valueCurrent.currency, main);
      if (converted === null) unconverted += 1;
      else value += converted * qty;
    }
    const w = services.weightGramsOfItem(item);
    grams += w.grams * qty;
    if (w.estimated) weightEstimated = true;
    const v = services.volumeM3OfItem(item);
    m3 += v.m3 * qty;
    if (v.estimated) volumeEstimated = true;
  }

  const myDevice = getDeviceId();
  const peer = (snap.devices ?? []).find((d) => d.id !== myDevice);

  return {
    itemCount: items.length,
    valueText:
      items.length === 0
        ? null
        : formatAmount(Math.round(value), main) + (unconverted > 0 ? '+' : ''),
    weightText:
      grams > 0 ? (weightEstimated ? '~' : '') + services.formatGrams(Math.round(grams)) : null,
    volumeText: m3 > 0 ? `${volumeEstimated ? '~' : ''}${m3.toFixed(m3 < 0.1 ? 3 : 2)} m³` : null,
    peerLabel: peer ? `${peer.label} ${formatAgo(peer.at)}` : null,
  };
}

function InventoryRow({ handle }: { handle: InventoryHandle }) {
  const [stats, setStats] = useState<RowStats | null>(null);

  useEffect(() => {
    let alive = true;
    snapshotInventory(handle.docId)
      .then((snap) => {
        if (alive) setStats(computeRowStats(snap));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [handle.docId, handle.lastSyncedAt]);

  const summary = stats
    ? [
        `${stats.itemCount} item${stats.itemCount === 1 ? '' : 's'}`,
        stats.valueText,
        stats.weightText,
        stats.volumeText,
      ]
        .filter(Boolean)
        .join(' · ')
    : '…';

  const syncText = handle.lastSyncedAt ? `Synced ${formatAgo(handle.lastSyncedAt)}` : 'Not synced yet';

  return (
    <Link className="list-row" to={`/inv/${handle.docId}`}>
      <div className="grow">
        <div style={{ fontWeight: 600 }}>{handle.name || 'Untitled inventory'}</div>
        <div className="tiny faint">{summary}</div>
        <div className="tiny faint">
          {syncText}
          {stats?.peerLabel ? ` · seen: ${stats.peerLabel}` : ''}
        </div>
      </div>
      {handle.readonly ? <span className="chip">View only</span> : null}
      <span className="muted" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

function NameModal({
  welcome,
  initialValue,
  onClose,
  onSave,
}: {
  welcome: boolean;
  initialValue: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initialValue);
  const submit = () => {
    const value = name.trim();
    if (value) onSave(value);
  };

  return (
    <Modal
      title={welcome ? 'Welcome' : 'Your name'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            {welcome ? 'Skip for now' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={!name.trim()}
            onClick={submit}
          >
            Save
          </button>
        </>
      }
    >
      <p className="small muted">Your name is used as the default owner of items you add.</p>
      <Field label="Name">
        <input
          className="input lg"
          autoFocus
          autoComplete="name"
          value={name}
          placeholder="Your name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
      </Field>
    </Modal>
  );
}

function AiKeyModal({
  hasKey,
  onClose,
  onSave,
}: {
  hasKey: boolean;
  onClose: () => void;
  /** Empty string removes the stored key. */
  onSave: (key: string) => void;
}) {
  const [key, setKey] = useState('');

  return (
    <Modal
      title="Claude API key"
      onClose={onClose}
      footer={
        <>
          {hasKey ? (
            <button type="button" className="btn danger grow" onClick={() => onSave('')}>
              Remove key
            </button>
          ) : (
            <button type="button" className="btn grow" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn primary grow"
            disabled={!key.trim()}
            onClick={() => onSave(key.trim())}
          >
            Save
          </button>
        </>
      }
    >
      <p className="small muted">
        Used for AI photo autofill. Calls go straight from this device to Anthropic; the key is
        stored only here and never shared or synced.
      </p>
      <Field label="API key">
        <input
          className="input"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder="sk-ant-..."
          onChange={(event) => setKey(event.target.value)}
        />
      </Field>
    </Modal>
  );
}

function CreateInventoryModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (
    name: string,
    currency: string,
    ownerTracking: boolean,
    preciseLocation: boolean,
  ) => void;
}) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [ownerTracking, setOwnerTracking] = useState(true);
  const [preciseLocation, setPreciseLocation] = useState(true);
  const [busy, setBusy] = useState(false);
  const currencyOptions = useCurrencyComboOptions(currency);

  const submit = () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    onCreate(name.trim(), currency.trim().toUpperCase() || 'USD', ownerTracking, preciseLocation);
  };

  return (
    <Modal
      title="New inventory"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={!name.trim() || busy}
            onClick={submit}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Name" hint="For example: Overseas lab shipment">
        <input
          className="input lg"
          autoFocus
          value={name}
          placeholder="Inventory name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </Field>
      <Field
        label="Default currency"
        hint="Used for new item values. Type a code or a name, e.g. USD or Swiss Franc."
      >
        <SmartCombo
          value={currency}
          options={currencyOptions}
          strict
          ariaLabel="Default currency"
          onCommit={setCurrency}
        />
      </Field>
      <Toggle
        label="Track owner per item"
        description="On by default; individual items can opt out."
        checked={ownerTracking}
        onChange={setOwnerTracking}
      />
      <Toggle
        label="Store precise GPS locations"
        description="Off: only place labels are stored and shared, coordinates never leave your device."
        checked={preciseLocation}
        onChange={setPreciseLocation}
      />
    </Modal>
  );
}

/**
 * Two different things live here, and conflating them is what made the QR
 * unscannable: the DEVICE LINK (tiny, camera-friendly, everything else
 * arrives via profile sync) and the FULL BACKUP (every token, for links and
 * files, where size costs nothing).
 */
function BackupModal({ onClose }: { onClose: () => void }) {
  const { toast, toastError } = useToast();
  const { saveFile } = useFileSaver();
  const [linkPayload] = useState(() => services.encodeLinkToken());
  const [backupPayload] = useState(() => services.encodeBackup());
  const [zipBusy, setZipBusy] = useState<string | null>(null);
  const linkUrl = buildBackupUrl(linkPayload);
  const backupUrl = buildBackupUrl(backupPayload);

  const copy = async (text: string, label: string) => {
    if (await copyToClipboard(text)) toast(`${label} copied`);
    else toastError('Clipboard unavailable — long-press the link to copy it');
  };

  const shareQr = async (url: string, kind: 'device-link' | 'full-backup') => {
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        // A saved image is decoded from clean pixels, not through a camera,
        // so the dense full backup survives here even though it cannot be
        // scanned off a screen.
        width: kind === 'full-backup' ? 1280 : 640,
        margin: 2,
        errorCorrectionLevel: kind === 'full-backup' ? 'M' : 'Q',
        color: { dark: '#0b0e11', light: '#ffffff' },
      });
      const filename = `peerventory-${kind}-${new Date().toISOString().slice(0, 10)}.png`;
      await saveFile(dataUrlToBlob(dataUrl), filename, 'QR image');
    } catch {
      toastError('This backup is too large for a QR code — use the link instead');
    }
  };

  const shareAccountZip = async () => {
    if (zipBusy !== null) return;
    setZipBusy('Packing…');
    try {
      const { blob, filename, inventories } = await buildAccountBackup((done, total) =>
        setZipBusy(`Packing ${done}/${total}`),
      );
      await saveFile(
        blob,
        filename,
        `Account backup (${inventories} inventor${inventories === 1 ? 'y' : 'ies'})`,
      );
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Could not build the account backup');
    } finally {
      setZipBusy(null);
    }
  };

  return (
    <Modal
      title="Link a device / backup"
      onClose={onClose}
      footer={
        <button type="button" className="btn grow" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="small muted">
        <strong>Link a device to this account.</strong> Scan this with Open / Scan on your other
        device: it joins your account and every inventory follows through sync — including the
        ones you add later. To share a single inventory with someone else, use Share inside that
        inventory instead.
      </p>
      <QrCanvas value={linkUrl} size={308} ecc="Q" />
      <div className="row" style={{ justifyContent: 'center' }}>
        <button type="button" className="link-btn" onClick={() => void copy(linkUrl, 'Link')}>
          Copy link
        </button>
        <button
          type="button"
          className="link-btn"
          onClick={() => void shareQr(linkUrl, 'device-link')}
        >
          Share QR image
        </button>
      </div>
      <p className="tiny faint">
        The code carries access to your account, not the data itself. Anyone holding it gets
        everything you have — treat it like a password.
      </p>
      <hr />
      <p className="small muted">
        <strong>Full account backup (.zip).</strong> One file with your account and the complete
        contents of every inventory, photos included. This is the offline backup: restoring it
        brings everything back even with no relay in reach. Drop it on the inventories list (or use
        Import file) to restore.
      </p>
      <button
        type="button"
        className="btn primary"
        disabled={zipBusy !== null}
        onClick={() => void shareAccountZip()}
      >
        {zipBusy !== null ? <Spinner /> : null} {zipBusy ?? 'Share full account backup (.zip)'}
      </button>
      <hr />
      <p className="tiny faint">
        <strong>Full backup link.</strong> Every inventory token in one payload — access only, so
        the contents are pulled from a relay afterwards. For archiving alongside the ZIP and for
        connecting the browser extension. Far too dense to read off a screen with a camera, so use
        the link — or the saved image, which decodes from clean pixels.
      </p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button
          type="button"
          className="link-btn"
          onClick={() => void copy(backupUrl, 'Full backup link')}
        >
          Copy full backup link
        </button>
        <button
          type="button"
          className="link-btn"
          onClick={() => void shareQr(backupUrl, 'full-backup')}
        >
          Share full backup image
        </button>
      </div>
    </Modal>
  );
}

function JoinLinkModal({
  onClose,
  onOpen,
  onUploadImage,
}: {
  onClose: () => void;
  /** Accepts the text, or explains why it was refused. */
  onOpen: (link: string) => { ok: true } | { ok: false; reason: string };
  onUploadImage: (file: File) => void;
}) {
  const [mode, setMode] = useState<'scan' | 'paste'>('scan');
  const [link, setLink] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  const uploadInput = (
    <input
      ref={uploadRef}
      type="file"
      accept="image/*"
      style={{ display: 'none' }}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) onUploadImage(file);
      }}
    />
  );

  const [pasteError, setPasteError] = useState<string | null>(null);

  return (
    <Modal
      title="Open a code or link"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            Cancel
          </button>
          {mode === 'paste' ? (
            <button
              type="button"
              className="btn primary grow"
              disabled={!link.trim()}
              onClick={() => {
                const outcome = onOpen(link);
                setPasteError(outcome.ok ? null : outcome.reason);
              }}
            >
              Open
            </button>
          ) : (
            <button type="button" className="btn primary grow" onClick={() => setMode('paste')}>
              Paste a link instead
            </button>
          )}
        </>
      }
    >
      {mode === 'scan' ? (
        <>
          <QrScanner
            paused={scanError !== null}
            onStalled={() => setStalled(true)}
            onResult={(text) => {
              setStalled(false);
              const outcome = onOpen(text);
              if (!outcome.ok) {
                setScanError(outcome.reason);
                setTimeout(() => setScanError(null), 2500);
              }
            }}
          />
          <p
            className={scanError ? 'tiny warn-text' : 'tiny faint'}
            style={{ textAlign: 'center' }}
          >
            {scanError ??
              (stalled
                ? 'Still nothing. Hold steady about 20 cm away, raise the other screen’s brightness — or use the link instead.'
                : 'Point the camera at a share link or a device-link QR code.')}
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button type="button" className="link-btn" onClick={() => uploadRef.current?.click()}>
              Upload a QR image
            </button>
          </div>
          {uploadInput}
        </>
      ) : (
        <>
          <Field
            label="Share or device link"
            hint="A link that contains /#/join/… (an inventory) or /#/restore/… (a device link)"
          >
            <textarea
              className="textarea"
              autoFocus
              value={link}
              placeholder="https://example.com/#/join/..."
              onChange={(e) => {
                setLink(e.target.value);
                setPasteError(null);
              }}
            />
          </Field>
          {pasteError ? <p className="tiny warn-text">{pasteError}</p> : null}
          <div className="row">
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  if (text) setLink(text);
                } catch {
                  /* clipboard read blocked; the user can paste manually */
                }
              }}
            >
              Paste from clipboard
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setPasteError(null);
                setStalled(false);
                setMode('scan');
              }}
            >
              Scan QR code
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
