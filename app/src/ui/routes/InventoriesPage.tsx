import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as services from '../../services';
import { getDeviceId, snapshotInventory, useInventories } from '../../store';
import type { UseInventoriesResult } from '../../store/contract';
import type { Id, InventoryHandle, InventorySnapshot, Item } from '../../types';
import { formatAmount, itemCountLabel, lineValueDisplay } from '../lib/format';
import { AppHeader } from '../components/AppHeader';
import { NameModal } from '../components/AccountModals';
import { EmptyState, SectionTitle } from '../components/Common';
import { PhotoImage } from '../components/Photos';
import { Field, Toggle, useCurrencyComboOptions } from '../components/Fields';
import { SmartCombo } from '../components/SmartCombo';
import { useImportFlow } from '../components/ImportFlow';
import { Modal } from '../components/Modal';
import { QrScanner } from '../components/QrScanner';
import { useToast } from '../components/Toast';

const NAME_WELCOME_DISMISSED = 'profile-name-welcome-dismissed:v1';

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
  // A result is a line in a list, so it is worth its line total; the unit
  // price trails it. Results span inventories, so there is no main currency
  // to convert into here.
  const units = services.unitCount(item);
  const value = lineValueDisplay(item, undefined);
  const money = value
    ? value.perUnit
      ? `${value.total} (${value.perUnit})`
      : value.total
    : units > 1
      ? `× ${units}`
      : null;
  const detail = [inventoryName, money, location].filter(Boolean).join(' · ');
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
  const [welcomeOpen, setWelcomeOpen] = useState(
    () => userName === null && !nameWelcomeWasDismissed(),
  );
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  // Files and codes: share links, device links, exports, account backups,
  // AI-key QRs — via drag & drop or the Open / Scan modal.
  const { openText, openFile, modals: importModals } = useImportFlow({
    onHandled: () => setJoining(false),
  });

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

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) void openFile(file);
    },
    [openFile],
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
        title="Peerventory"
        subtitle="Local-first packing and customs manifests"
        actions={
          <>
            <button type="button" className="btn ghost sm" onClick={() => setJoining(true)}>
              Open / Scan
            </button>
            <Link
              className="btn ghost icon"
              aria-label="Account & sync"
              title="Account & sync"
              to="/account"
            >
              <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>
                {'\u2699\uFE0E'}
              </span>
            </Link>
          </>
        }
      />

      <main className="page narrow">
        <div className="stack">
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
              profile; forgetting one removes it from their lists too. Backups, relays and device
              linking live under the {'\u2699\uFE0E'} Account &amp; sync screen.
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
          onOpen={openText}
          onUploadImage={(file) => void openFile(file)}
        />
      ) : null}

      {importModals}

      {welcomeOpen ? (
        <NameModal
          welcome
          initialValue={userName ?? ''}
          onClose={() => {
            rememberNameWelcomeDismissal();
            setWelcomeOpen(false);
          }}
          onSave={(name) => {
            services.setUserName(name);
            setUserNameState(name);
            setWelcomeOpen(false);
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
  unitCount: number;
  valueText: string | null;
  weightText: string | null;
  volumeText: string | null;
  peerLabel: string | null;
}

/** Every figure is a total: per-unit values multiplied by each item's quantity. */
function computeRowStats(snap: InventorySnapshot): RowStats {
  const main = snap.meta.currency || 'USD';
  const totals = services.summarizeItems(snap.items, main);
  const { converted, unconverted } = totals.currentValue;
  const grams = totals.weightGrams;
  const m3 = totals.volumeM3;

  const myDevice = getDeviceId();
  const peer = (snap.devices ?? []).find((d) => d.id !== myDevice);

  return {
    itemCount: totals.itemCount,
    unitCount: totals.unitCount,
    valueText:
      totals.itemCount === 0
        ? null
        : formatAmount(Math.round(converted), main) + (unconverted.length > 0 ? '+' : ''),
    weightText:
      grams > 0
        ? (totals.weightEstimated ? '~' : '') + services.formatGrams(Math.round(grams))
        : null,
    volumeText:
      m3 > 0 ? `${totals.volumeEstimated ? '~' : ''}${m3.toFixed(m3 < 0.1 ? 3 : 2)} m³` : null,
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
        itemCountLabel(stats.itemCount, stats.unitCount),
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
