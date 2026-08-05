import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as services from '../../services';
import { useInventory } from '../../store';
import type { UseInventoryResult } from '../../store/contract';
import type { Box, Id, Item, SavedList } from '../../types';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, LoadingPage, SyncingState } from '../components/Common';
import { ExportButtons } from '../components/ExportButtons';
import { Field } from '../components/Fields';
import { Modal } from '../components/Modal';
import { PhotoImage } from '../components/Photos';
import { ShareModal } from '../components/ShareModal';
import { useToast } from '../components/Toast';
import {
  convertedMoneyHint,
  formatMoney,
  itemCountLabel,
  itemMatchesQuery,
  weightLabel,
} from '../lib/format';
import { buildShareUrl, selectionNeedsSavedList } from '../lib/links';
import type { LinkTarget } from '../lib/links';

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

  const leaveSelectMode = () => {
    setSelectMode(false);
    setSelected([]);
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

          <div className="row between">
            <span className="small muted">
              {filtered.length === items.length ? allCount : filteredCount}
            </span>
            {items.length > 0 ? (
              <button
                type="button"
                className="link-btn"
                onClick={() => (selectMode ? leaveSelectMode() : setSelectMode(true))}
              >
                {selectMode ? 'Cancel selection' : 'Select items'}
              </button>
            ) : null}
          </div>

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
            <span className="small muted" style={{ minWidth: 64 }}>
              {selected.length} selected
            </span>
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

function ItemCard({
  docId,
  item,
  boxLabel,
  mainCurrency,
  selectMode,
  selected,
  onClick,
}: {
  docId: Id;
  item: Item;
  boxLabel?: string;
  mainCurrency: string;
  selectMode: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const cover = item.photos?.[0]?.hash ?? null;
  const conversionHint = convertedMoneyHint(item.valueCurrent, mainCurrency);
  return (
    <div
      className={selected ? 'item-card selected' : 'item-card'}
      onClick={onClick}
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
          {item.valueCurrent ? (
            <span>
              {formatMoney(item.valueCurrent)}
              {conversionHint ? <span className="conversion-hint"> {conversionHint}</span> : null}
            </span>
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
