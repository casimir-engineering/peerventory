import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import * as services from '../../services';
import { getDeviceId, snapshotInventory, useInventories } from '../../store';
import type { UseInventoriesResult } from '../../store/contract';
import type { Id, InventoryHandle, InventorySnapshot, Item } from '../../types';
import { formatAmount, formatMoney } from '../lib/format';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, SectionTitle } from '../components/Common';
import { PhotoImage } from '../components/Photos';
import { Field, Toggle, useCurrencyComboOptions } from '../components/Fields';
import { SmartCombo } from '../components/SmartCombo';
import { ImportModal } from '../components/ImportModal';
import { Modal } from '../components/Modal';
import { QrCanvas } from '../components/QrCanvas';
import { QrScanner } from '../components/QrScanner';
import { useToast } from '../components/Toast';
import { buildBackupUrl, joinRoute, parseShareLink } from '../lib/links';
import type { ParsedImport } from '../lib/importFile';
import { parseInventoryFile } from '../lib/importFile';
import { decodeQrImage } from '../lib/qrDecode';

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
  const { handles, createInventory }: UseInventoriesResult = useInventories();

  const [creating, setCreating] = useState(false);
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

  /** One entry point for anything scanned, pasted, or decoded from an image. */
  const handleScannedText = useCallback(
    (text: string): boolean => {
      const aiKey = services.parseAiKeyQr(text);
      if (aiKey) {
        services.setAiKey(aiKey);
        setAiKeyMasked(services.maskedAiKey());
        setJoining(false);
        toast('Claude API key installed on this device');
        return true;
      }
      const backupPayload = services.parseBackupText(text);
      if (backupPayload) {
        setJoining(false);
        navigate(`/restore/${backupPayload}`);
        return true;
      }
      const parsed = parseShareLink(text);
      if (!parsed) return false;
      setJoining(false);
      navigate(joinRoute(parsed));
      return true;
    },
    [navigate, toast],
  );

  /** Dispatch a dropped or picked file: QR image, or ZIP/YAML inventory export. */
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
          const parsed = await parseInventoryFile(file);
          setImportState({ parsed, fileName: file.name });
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
        if (!handleScannedText(text)) {
          toastError('The QR code in this image is not a known link');
        }
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
          <div className="drop-overlay-inner">Drop a .zip / .yaml export or a QR image</div>
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
                    <div className="small">Backup, transfer, or import data</div>
                  </div>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => importInputRef.current?.click()}
                  >
                    Import file
                  </button>
                  <button type="button" className="link-btn" onClick={() => setBackupModal(true)}>
                    Backup
                  </button>
                </div>
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
              Opening a shared link adds it here. Forgetting an inventory only removes it from this
              device.
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
          onOpen={(link) => {
            if (handleScannedText(link)) return true;
            toastError('That does not look like an inventory share link');
            return false;
          }}
          onUploadImage={(file) => void handleFile(file)}
        />
      ) : null}

      {backupModal ? <BackupModal onClose={() => setBackupModal(false)} /> : null}

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

function BackupModal({ onClose }: { onClose: () => void }) {
  const { toast, toastError } = useToast();
  const [payload] = useState(() => services.encodeBackup());
  const url = buildBackupUrl(payload);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Backup link copied');
    } catch {
      toastError('Clipboard unavailable — long-press the link to copy it');
    }
  };

  const downloadQr = async () => {
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        width: 640,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b0e11', light: '#ffffff' },
      });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `inventory-backup-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
    } catch {
      toastError('This backup is too large for a QR code — use the link instead');
    }
  };

  return (
    <Modal
      title="Backup / transfer"
      onClose={onClose}
      footer={
        <button type="button" className="btn grow" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="small muted">
        This code carries your name, your inventories with their access tokens, and your API key
        if one is set. Scan it with Open / Scan on the new device (or open the link there) to move
        everything over. Anyone holding it gets the same access — treat it like a password.
      </p>
      <QrCanvas value={url} size={264} />
      <div className="row" style={{ justifyContent: 'center' }}>
        <button type="button" className="link-btn" onClick={() => void copyLink()}>
          Copy link
        </button>
        <button type="button" className="link-btn" onClick={() => void downloadQr()}>
          Save QR image
        </button>
      </div>
      <p className="tiny faint">
        The backup contains access tokens, not the data itself: the new device pulls items and
        photos from sync after import. Item data added later is not in this code — make a fresh
        backup when you add inventories.
      </p>
    </Modal>
  );
}

function JoinLinkModal({
  onClose,
  onOpen,
  onUploadImage,
}: {
  onClose: () => void;
  /** Returns true when the text was accepted as a share link. */
  onOpen: (link: string) => boolean;
  onUploadImage: (file: File) => void;
}) {
  const [mode, setMode] = useState<'scan' | 'paste'>('scan');
  const [link, setLink] = useState('');
  const [scanError, setScanError] = useState(false);
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

  return (
    <Modal
      title="Open a share link"
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
              onClick={() => onOpen(link)}
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
            paused={scanError}
            onResult={(text) => {
              if (!onOpen(text)) {
                setScanError(true);
                setTimeout(() => setScanError(false), 1500);
              }
            }}
          />
          <p className="tiny faint" style={{ textAlign: 'center' }}>
            {scanError
              ? 'That code is not an inventory share link.'
              : 'Point the camera at a share QR code.'}
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
          <Field label="Share link" hint="Paste a link that ends in /#/join/...">
            <textarea
              className="textarea"
              autoFocus
              value={link}
              placeholder="https://example.com/#/join/..."
              onChange={(e) => setLink(e.target.value)}
            />
          </Field>
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
            <button type="button" className="link-btn" onClick={() => setMode('scan')}>
              Scan QR code
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
