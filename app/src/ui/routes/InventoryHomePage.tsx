import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as services from '../../services';
import { useInventory } from '../../store';
import type { UseInventoryResult } from '../../store/contract';
import type { Box, Id, Item, SavedList } from '../../types';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, LoadingPage, SyncingState } from '../components/Common';
import { ExportButtons } from '../components/ExportButtons';
import { Field } from '../components/Fields';
import { hasOpenModal, Modal } from '../components/Modal';
import { PhotoImage } from '../components/Photos';
import { ShareModal } from '../components/ShareModal';
import { useToast } from '../components/Toast';
import { TwoStepDeleteButton } from '../components/TwoStepDelete';
import { itemCountLabel, itemMatchesQuery, lineValueDisplay, weightLabel } from '../lib/format';
import { buildShareUrl, selectionNeedsSavedList } from '../lib/links';
import type { LinkTarget } from '../lib/links';
import { registerNavigationGuard } from '../lib/navGuard';

const NO_BOX = '__none__';

export function InventoryHomePage() {
  const { docId = '' } = useParams();
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const inv: UseInventoryResult = useInventory(docId || null);

  const [query, setQuery] = useState('');
  const [boxFilter, setBoxFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Id[]>([]);
  const [shareTarget, setShareTarget] = useState<LinkTarget | null>(null);
  const [savePrompt, setSavePrompt] = useState<null | { thenShare: boolean }>(null);
  const [exporting, setExporting] = useState(false);
  const [ownerAlias, setOwnerAliasState] = useState(() =>
    docId ? services.ownerAliasFor(docId) : null,
  );

  const items: Item[] = inv.items ?? [];
  const boxes: Box[] = inv.boxes ?? [];
  const savedLists: SavedList[] = inv.savedLists ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) if (item.category) set.add(item.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const userName = services.getUserName();
  const existingOwners = useMemo(() => {
    const distinct = new Map<string, string>();
    for (const item of items) {
      if (item.ownerDisabled) continue;
      const owner = item.ownerHistory?.[item.ownerHistory.length - 1]?.owner?.trim();
      if (owner && !distinct.has(owner.toLocaleLowerCase())) {
        distinct.set(owner.toLocaleLowerCase(), owner);
      }
    }
    return [...distinct.values()].sort((a, b) => a.localeCompare(b));
  }, [items]);

  useEffect(() => {
    setOwnerAliasState(docId ? services.ownerAliasFor(docId) : null);
  }, [docId]);

  const answerOwnerQuestion = (name: string) => {
    services.setOwnerAlias(docId, name);
    setOwnerAliasState(name);
  };

  const shouldAskOwner =
    inv.loaded &&
    Boolean(inv.meta) &&
    !inv.readonly &&
    Boolean(userName) &&
    ownerAlias === null &&
    existingOwners.length > 0 &&
    !existingOwners.some(
      (owner) => owner.toLocaleLowerCase() === userName?.trim().toLocaleLowerCase(),
    );

  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (!itemMatchesQuery(item, query)) return false;
        if (boxFilter === NO_BOX && item.boxId) return false;
        if (boxFilter && boxFilter !== NO_BOX && item.boxId !== boxFilter) return false;
        if (categoryFilter && item.category !== categoryFilter) return false;
        return true;
      }),
    [items, query, boxFilter, categoryFilter],
  );

  const unitsOf = (list: Item[]) =>
    list.reduce((sum, item) => sum + services.unitCount(item), 0);
  const allCount = itemCountLabel(items.length, unitsOf(items));
  const filteredUnits = unitsOf(filtered);
  const filteredCount =
    `${filtered.length} of ${items.length} items` +
    (filteredUnits === filtered.length ? '' : ` (${filteredUnits} units)`);

  const boxLabel = (boxId: Id | undefined) =>
    boxId ? boxes.find((b) => b.id === boxId)?.label : undefined;

  const toggle = (id: Id) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const leaveSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected([]);
  }, []);

  /** Long-press on a card is the touch way in; it picks that card straight away. */
  const enterSelectModeWith = (id: Id) => {
    setSelectMode(true);
    setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((item) => selected.includes(item.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) setSelected([]);
    else setSelected((prev) => [...new Set([...prev, ...filtered.map((item) => item.id)])]);
  };

  // The system back button leaves the selection instead of leaving the page —
  // the same escape hatch the Cancel button gives, on the gesture Android
  // users reach for first.
  useEffect(() => {
    if (!selectMode) return;
    return registerNavigationGuard(() => {
      leaveSelectMode();
      return true;
    });
  }, [selectMode, leaveSelectMode]);

  // Escape is the desktop equivalent, unless a dialog is using it first.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !hasOpenModal()) leaveSelectMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectMode, leaveSelectMode]);

  const deleteSelection = () => {
    const count = selected.length;
    if (count === 0 || inv.readonly) return;
    inv.deleteItems(selected);
    leaveSelectMode();
    toast(`${count} item${count === 1 ? '' : 's'} deleted`);
  };

  const shareSelection = () => {
    if (selected.length === 0) return;
    // A long dot-joined URL will not survive a QR scan or a chat app, so it
    // becomes a saved list instead.
    const probe = buildShareUrl(docId, 'x'.repeat(16), { kind: 'list', itemIds: selected });
    if (selectionNeedsSavedList(selected, probe)) {
      if (inv.readonly) {
        toastError('Too many items for one link. Select fewer items to share.');
        return;
      }
      setSavePrompt({ thenShare: true });
      return;
    }
    setShareTarget({ kind: 'list', itemIds: selected });
  };

  if (!inv.loaded) {
    return (
      <>
        <AppHeader title="Inventory" back="/" />
        <main className="page">
          <LoadingPage />
        </main>
      </>
    );
  }

  if (inv.keyMissing && !inv.meta) {
    // The doc synced, but it is end-to-end encrypted and this device has no
    // content key: everything we received is unreadable ciphertext.
    return (
      <>
        <AppHeader title="Inventory" back="/" status={inv.syncStatus} />
        <main className="page narrow">
          <EmptyState
            title="Encryption key missing"
            body="This inventory is end-to-end encrypted and this device does not have its key. Open a full share link or QR code from a device that has access — the link carries the key."
            action={
              <Link className="btn primary" to="/">
                Back to inventories
              </Link>
            }
          />
        </main>
      </>
    );
  }

  if (!inv.meta) {
    // Nothing of this document has arrived yet. While the provider is still
    // connecting that is a wait, not a missing inventory.
    return (
      <>
        <AppHeader title="Inventory" back="/" status={inv.syncStatus} />
        <main className="page narrow">
          {inv.syncStatus === 'connecting' ? (
            <SyncingState body="This inventory has not reached this device yet. Keep this screen open while it downloads." />
          ) : (
            <EmptyState
              title="Inventory not available"
              body={
                inv.syncStatus === 'synced'
                  ? 'This inventory is empty, or it is not stored on this device. Open its share link again to add it.'
                  : 'This inventory has not synced to this device yet, and the sync server cannot be reached right now.'
              }
              action={
                <Link className="btn primary" to="/">
                  Back to inventories
                </Link>
              }
            />
          )}
        </main>
      </>
    );
  }

  const mainCurrency = inv.meta.currency;

  return (
    <>
      <AppHeader
        title={inv.meta.name || 'Untitled inventory'}
        subtitle={`${allCount}${inv.readonly ? ' · view only' : ''}`}
        back="/"
        status={inv.syncStatus}
        actions={
          <>
            <Link className="btn ghost sm" to={`/inv/${docId}/stats`}>
              Stats
            </Link>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setShareTarget({ kind: 'inventory' })}
            >
              Share
            </button>
            <Link className="btn ghost sm" to={`/inv/${docId}/settings`}>
              Settings
            </Link>
          </>
        }
      />

      <main className="page">
        <div className="stack">
          <div className="search">
            <input
              className="input"
              type="search"
              value={query}
              placeholder="Search description, tags, serial"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {(boxes.length > 0 || categories.length > 0) && (
            <div className="filters">
              {boxes.length > 0 ? (
                <select
                  className="select"
                  aria-label="Filter by box"
                  value={boxFilter}
                  onChange={(e) => setBoxFilter(e.target.value)}
                >
                  <option value="">All boxes</option>
                  <option value={NO_BOX}>No box</option>
                  {boxes.map((box) => (
                    <option key={box.id} value={box.id}>
                      {box.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {categories.length > 0 ? (
                <select
                  className="select"
                  aria-label="Filter by category"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                >
                  <option value="">All categories</option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          )}

          {selectMode ? (
            <div className="select-bar">
              <span className="count">{selected.length} selected</span>
              <button type="button" className="link-btn" onClick={toggleSelectAll}>
                {allFilteredSelected ? 'Select none' : 'Select all'}
              </button>
              <button type="button" className="link-btn" onClick={leaveSelectMode}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row between">
              <span className="small muted">
                {filtered.length === items.length ? allCount : filteredCount}
              </span>
              {items.length > 0 ? (
                <button type="button" className="link-btn" onClick={() => setSelectMode(true)}>
                  Select items
                </button>
              ) : null}
            </div>
          )}

          {savedLists.length > 0 && !selectMode ? (
            <details className="disclosure">
              <summary>Saved lists ({savedLists.length})</summary>
              <div className="disclosure-body">
                <div className="list-rows">
                  {savedLists.map((list) => (
                    <Link key={list.id} className="list-row" to={`/inv/${docId}/sl/${list.id}`}>
                      <span className="grow">{list.name}</span>
                      <span className="chip">{list.itemIds.length}</span>
                    </Link>
                  ))}
                </div>
              </div>
            </details>
          ) : null}

          {items.length === 0 ? (
            <EmptyState
              glyph="▤"
              title="No items yet"
              body={
                inv.readonly
                  ? 'Nothing has been added to this inventory yet.'
                  : 'Add the first item: photo, description, weight, size. It takes about fifteen seconds per item.'
              }
              action={
                inv.readonly ? undefined : (
                  <Link className="btn primary" to={`/inv/${docId}/new`}>
                    Add first item
                  </Link>
                )
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No matches"
              body="Try a different search term or clear the filters."
              action={
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setQuery('');
                    setBoxFilter('');
                    setCategoryFilter('');
                  }}
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <div className="item-grid">
              {filtered.map((item) => (
                <ItemCard
                  key={item.id}
                  docId={docId}
                  item={item}
                  boxLabel={boxLabel(item.boxId)}
                  mainCurrency={mainCurrency}
                  selectMode={selectMode}
                  selected={selected.includes(item.id)}
                  onClick={() =>
                    selectMode ? toggle(item.id) : navigate(`/inv/${docId}/i/${item.id}`)
                  }
                  onLongPress={() => enterSelectModeWith(item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {!selectMode && !inv.readonly ? (
        <button type="button" className="fab" onClick={() => navigate(`/inv/${docId}/new`)}>
          <span className="glyph" aria-hidden="true">
            +
          </span>
          Add item
        </button>
      ) : null}

      {selectMode ? (
        <div className="bottom-bar">
          <div className="inner">
            <button
              type="button"
              className="btn primary"
              disabled={selected.length === 0}
              onClick={shareSelection}
            >
              Share
            </button>
            <button
              type="button"
              className="btn"
              disabled={selected.length === 0 || inv.readonly}
              onClick={() => setSavePrompt({ thenShare: false })}
            >
              Save as list
            </button>
            <button
              type="button"
              className="btn"
              disabled={selected.length === 0}
              onClick={() => setExporting(true)}
            >
              Export
            </button>
            {inv.readonly ? null : (
              <TwoStepDeleteButton
                onDelete={deleteSelection}
                label={`Delete ${selected.length} selected item${
                  selected.length === 1 ? '' : 's'
                }`}
                armedLabel="Tap again to delete the selected items"
                disabled={selected.length === 0}
                resetKey={selected.join(',')}
                armedChildren="Confirm"
              >
                Delete{selected.length > 0 ? ` (${selected.length})` : ''}
              </TwoStepDeleteButton>
            )}
          </div>
        </div>
      ) : null}

      {shareTarget ? (
        <ShareModal
          docId={docId}
          target={shareTarget}
          title={shareTarget.kind === 'inventory' ? 'Share inventory' : 'Share selection'}
          subtitle={
            shareTarget.kind === 'list'
              ? `${selected.length} items travel inside the link itself.`
              : undefined
          }
          onClose={() => setShareTarget(null)}
        />
      ) : null}

      {savePrompt ? (
        <SaveListModal
          count={selected.length}
          forced={savePrompt.thenShare}
          onClose={() => setSavePrompt(null)}
          onSave={(name) => {
            const listId = inv.createSavedList(name, selected);
            setSavePrompt(null);
            toast('List saved');
            if (savePrompt.thenShare) {
              setShareTarget({ kind: 'savedList', listId });
            } else {
              leaveSelectMode();
              navigate(`/inv/${docId}/sl/${listId}`);
            }
          }}
        />
      ) : null}

      {exporting ? (
        <Modal title="Export selection" onClose={() => setExporting(false)}>
          <ExportButtons
            docId={docId}
            inventoryName={inv.meta.name}
            itemIds={selected}
            selectionLabel={`${selected.length} selected`}
          />
        </Modal>
      ) : null}

      {shouldAskOwner && userName ? (
        <Modal
          title="Are you one of these owners?"
          onClose={() => answerOwnerQuestion(userName)}
        >
          <p className="small muted">
            Match your name to the owner labels already used in this inventory.
          </p>
          <div className="owner-choice-list">
            {existingOwners.map((owner) => (
              <button
                key={owner}
                type="button"
                className="btn block"
                onClick={() => answerOwnerQuestion(owner)}
              >
                {owner}
              </button>
            ))}
            <button
              type="button"
              className="btn outline block"
              onClick={() => answerOwnerQuestion(userName)}
            >
              No, I’m {userName}
            </button>
          </div>
          <p className="tiny faint">Closing this question keeps your current name.</p>
        </Modal>
      ) : null}
    </>
  );
}

const LONG_PRESS_MS = 450;

function ItemCard({
  docId,
  item,
  boxLabel,
  mainCurrency,
  selectMode,
  selected,
  onClick,
  onLongPress,
}: {
  docId: Id;
  item: Item;
  boxLabel?: string;
  mainCurrency: string;
  selectMode: boolean;
  selected: boolean;
  onClick: () => void;
  /** Press-and-hold: the touch way into selection mode. */
  onLongPress: () => void;
}) {
  const cover = item.photos?.[0]?.hash ?? null;
  // The card is a line in a list, so its money is what the line is worth.
  const value = lineValueDisplay(item, mainCurrency);
  const timer = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  // A long press ends in a click too; that click would undo the selection the
  // press just made, so it is swallowed once.
  const fired = useRef(false);

  const cancelPress = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => cancelPress, []);

  const startPress = (x: number, y: number) => {
    cancelPress();
    fired.current = false;
    origin.current = { x, y };
    timer.current = window.setTimeout(() => {
      timer.current = null;
      fired.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  };

  // A finger never holds perfectly still; only a real drag (or a scroll)
  // should call the hold off.
  const pressMoved = (x: number, y: number) => {
    if (timer.current === null) return;
    if (Math.hypot(x - origin.current.x, y - origin.current.y) > 12) cancelPress();
  };

  return (
    <div
      className={selected ? 'item-card selected' : 'item-card'}
      onClick={() => {
        if (fired.current) {
          fired.current = false;
          return;
        }
        onClick();
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        startPress(e.clientX, e.clientY);
      }}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onPointerMove={(e) => pressMoved(e.clientX, e.clientY)}
      onContextMenu={(e) => {
        // Android fires this at the end of a hold; the selection is the menu.
        if (fired.current) e.preventDefault();
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {selectMode ? (
        <span className={selected ? 'checkbox-dot on' : 'checkbox-dot'} aria-hidden="true">
          ✓
        </span>
      ) : null}
      <PhotoImage docId={docId} hash={cover} alt="" className="thumb" />
      <div className="body">
        <span className="name clamp-2">{item.description || 'Untitled item'}</span>
        <span className="meta">
          {item.quantity > 1 ? <span className="chip accent">×{item.quantity}</span> : null}
          <span className="chip">{weightLabel(item.weight)}</span>
          {boxLabel ? <span className="chip">{boxLabel}</span> : null}
          {value ? (
            <>
              <span>
                {value.total}
                {value.conversion ? (
                  <span className="conversion-hint"> {value.conversion}</span>
                ) : null}
              </span>
              {value.perUnit ? <span className="conversion-hint">{value.perUnit}</span> : null}
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function SaveListModal({
  count,
  forced,
  onClose,
  onSave,
}: {
  count: number;
  forced: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');
  // Held Enter repeats the keydown; each repeat would save another copy.
  const submitted = useRef(false);

  const submit = () => {
    if (submitted.current || !name.trim()) return;
    submitted.current = true;
    onSave(name.trim());
  };

  return (
    <Modal
      title="Save as list"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={!name.trim()}
            onClick={submit}
          >
            {forced ? 'Save and share' : 'Save list'}
          </button>
        </>
      }
    >
      {forced ? (
        <p className="small muted">
          {count} items are too many to fit inside a share link. Save them as a named list and the
          link will point at the list instead.
        </p>
      ) : null}
      <Field label="List name" hint="For example: Carton 3 contents">
        <input
          className="input lg"
          autoFocus
          value={name}
          placeholder="List name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </Field>
    </Modal>
  );
}
