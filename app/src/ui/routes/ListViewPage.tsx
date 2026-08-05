import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { itemValueTotal, itemWeightGrams, unitCount } from '../../services';
import { useInventory } from '../../store';
import type { UseInventoryResult } from '../../store/contract';
import type { Box, Item, MoneyValue, SavedList } from '../../types';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, LoadingPage, SectionTitle, SyncingState } from '../components/Common';
import { ExportButtons } from '../components/ExportButtons';
import { ConfirmModal } from '../components/Modal';
import { InlineText } from '../components/Fields';
import { PhotoImage } from '../components/Photos';
import { ShareModal } from '../components/ShareModal';
import { useToast } from '../components/Toast';
import {
  anyWeightEstimated,
  convertedMoneyHint,
  convertTotalsToCurrency,
  formatAmount,
  formatGrams,
  formatMoney,
  formatTotals,
  sizeLabel,
  totalWeightGrams,
  totalsByCurrency,
  weightLabel,
} from '../lib/format';
import { parseDotIds } from '../lib/links';
import type { LinkTarget } from '../lib/links';

/**
 * Read-focused manifest view. This is what a forwarder or a customs officer
 * sees when they open a shared link, so totals come before controls.
 */
export function ListViewPage() {
  const { docId = '', dotIds, listId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const inv: UseInventoryResult = useInventory(docId || null);

  const [sharing, setSharing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const savedList: SavedList | undefined = listId
    ? (inv.savedLists ?? []).find((list) => list.id === listId)
    : undefined;

  const itemIds = useMemo(
    () => (listId ? (savedList?.itemIds ?? []) : parseDotIds(dotIds)),
    [listId, savedList, dotIds],
  );

  const { items, missing } = useMemo(() => {
    const byId = new Map<string, Item>();
    for (const item of inv.items ?? []) byId.set(item.id, item);
    const found: Item[] = [];
    let notFound = 0;
    for (const id of itemIds) {
      const item = byId.get(id);
      if (item) found.push(item);
      else notFound += 1;
    }
    return { items: found, missing: notFound };
  }, [inv.items, itemIds]);

  const boxes: Box[] = inv.boxes ?? [];
  const boxLabel = (boxId: string | undefined) =>
    boxId ? (boxes.find((b) => b.id === boxId)?.label ?? '—') : '—';

  const totalUnits = items.reduce((sum, item) => sum + unitCount(item), 0);
  const weightGramsTotal = totalWeightGrams(items);
  const weightIsEstimate = anyWeightEstimated(items);
  const currentTotals = totalsByCurrency(items, 'valueCurrent');
  const newTotals = totalsByCurrency(items, 'valueNew');
  const mainCurrency = inv.meta?.currency ?? '';
  const currentTotalInMain = mainCurrency
    ? convertTotalsToCurrency(currentTotals, mainCurrency)
    : null;
  const newTotalInMain = mainCurrency ? convertTotalsToCurrency(newTotals, mainCurrency) : null;
  const hasForeignCurrent = currentTotals.some(
    (line) => line.currency.trim().toUpperCase() !== mainCurrency.trim().toUpperCase(),
  );
  const hasForeignNew = newTotals.some(
    (line) => line.currency.trim().toUpperCase() !== mainCurrency.trim().toUpperCase(),
  );

  const target: LinkTarget = listId
    ? { kind: 'savedList', listId }
    : { kind: 'list', itemIds };

  const title = savedList?.name ?? (listId ? 'Saved list' : 'Selection');

  if (!inv.loaded) {
    return (
      <>
        <AppHeader title="List" back={`/inv/${docId}`} />
        <main className="page">
          <LoadingPage />
        </main>
      </>
    );
  }

  if (!inv.meta && inv.syncStatus === 'connecting') {
    return (
      <>
        <AppHeader title="List" back={`/inv/${docId}`} status={inv.syncStatus} />
        <main className="page narrow">
          <SyncingState body="This list has not reached this device yet. Keep this screen open while it downloads." />
        </main>
      </>
    );
  }

  if (listId && !savedList) {
    return (
      <>
        <AppHeader title="List" back={`/inv/${docId}`} status={inv.syncStatus} />
        <main className="page narrow">
          <EmptyState
            title="List not found"
            body="The saved list may have been deleted, or it has not synced to this device yet."
            action={
              <Link className="btn primary" to={`/inv/${docId}`}>
                Back to inventory
              </Link>
            }
          />
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader
        title={title}
        subtitle={inv.meta?.name}
        back={`/inv/${docId}`}
        status={inv.syncStatus}
        actions={
          <button type="button" className="btn ghost sm" onClick={() => setSharing(true)}>
            Share
          </button>
        }
      />

      <main className="page">
        <div className="stack loose">
          <section className="totals">
            <div className="total-box">
              <div className="k">Items</div>
              <div className="v">{items.length}</div>
            </div>
            <div className="total-box">
              <div className="k">Units</div>
              <div className="v">{totalUnits}</div>
            </div>
            <div className="total-box">
              <div className="k">{weightIsEstimate ? 'Estimated weight' : 'Weight'}</div>
              <div className="v">
                {weightIsEstimate ? '~' : ''}
                {formatGrams(weightGramsTotal)}
              </div>
            </div>
            <div className="total-box">
              <div className="k">Declared value</div>
              <div className="v">
                {currentTotals.length === 0
                  ? '—'
                  : currentTotals.map((total) => (
                      <div key={total.currency}>{formatAmount(total.amount, total.currency)}</div>
                    ))}
                {currentTotalInMain !== null && hasForeignCurrent ? (
                  <div className="conversion-total">
                    ≈ total in {mainCurrency}: {formatAmount(currentTotalInMain, mainCurrency)}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <p className="tiny faint">
            {newTotals.length > 0
              ? `Replacement value when new: ${formatTotals(newTotals)}. `
              : ''}
            {newTotalInMain !== null && hasForeignNew
              ? `≈ total in ${mainCurrency}: ${formatAmount(newTotalInMain, mainCurrency)}. `
              : ''}
            {weightIsEstimate
              ? 'The ~ marks a total that includes weights estimated from the weight class of an item rather than measured.'
              : 'Every item in this list was weighed, so the total is not an estimate.'}
          </p>

          {missing > 0 ? (
            <p className="banner plain">
              {missing} item{missing === 1 ? '' : 's'} in this list {missing === 1 ? 'is' : 'are'}{' '}
              not available on this device yet.
            </p>
          ) : null}

          {items.length === 0 ? (
            <EmptyState
              title="Nothing to show"
              body="This list does not contain any item that is available on this device."
              action={
                <Link className="btn primary" to={`/inv/${docId}`}>
                  Back to inventory
                </Link>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Photo</th>
                    <th>Description</th>
                    <th className="num">Qty</th>
                    <th>Weight</th>
                    <th>Size</th>
                    <th>Box</th>
                    <th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() => navigate(`/inv/${docId}/i/${item.id}`)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <PhotoImage
                          docId={docId}
                          hash={item.photos?.[0]?.hash ?? null}
                          alt=""
                          className="thumb"
                        />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{item.description || 'Untitled item'}</div>
                        {item.serialNumber ? (
                          <div className="tiny faint">Serial {item.serialNumber}</div>
                        ) : null}
                      </td>
                      <td className="num">{unitCount(item)}</td>
                      <td>
                        {weightLabel(item.weight)}
                        <LineTotalHint item={item} kind="weight" />
                      </td>
                      <td>{sizeLabel(item.dimensions)}</td>
                      <td>{boxLabel(item.boxId)}</td>
                      <td className="num">
                        <MoneyWithConversion
                          value={item.valueCurrent}
                          mainCurrency={mainCurrency}
                        />
                        <LineTotalHint item={item} kind="value" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <section className="stack tight">
            <SectionTitle>Export</SectionTitle>
            <ExportButtons
              docId={docId}
              inventoryName={inv.meta?.name ?? 'inventory'}
              itemIds={itemIds}
              selectionLabel={`${items.length} items`}
            />
          </section>

          {savedList && !inv.readonly ? (
            <section className="card stack tight">
              <SectionTitle>List settings</SectionTitle>
              <InlineText
                label="List name"
                value={savedList.name}
                onCommit={(value) => value && inv.updateSavedList(savedList.id, { name: value })}
              />
              <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
                Delete list
              </button>
              <p className="tiny faint">Deleting a list never deletes the items inside it.</p>
            </section>
          ) : null}
        </div>
      </main>

      <div className="bottom-bar">
        <div className="inner">
          <button type="button" className="btn primary" onClick={() => setSharing(true)}>
            Share this list
          </button>
        </div>
      </div>

      {sharing ? (
        <ShareModal
          docId={docId}
          target={target}
          title="Share list"
          subtitle={
            listId
              ? 'The link points at the saved list, so it stays short however many items it holds.'
              : 'The item IDs travel inside the link itself.'
          }
          onClose={() => setSharing(false)}
        />
      ) : null}

      {confirmDelete && savedList ? (
        <ConfirmModal
          title="Delete list"
          body="The list is removed everywhere. The items themselves stay in the inventory."
          confirmLabel="Delete list"
          destructive
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            inv.deleteSavedList(savedList.id);
            toast('List deleted');
            navigate(`/inv/${docId}`, { replace: true });
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Per-unit figures describe the object, which is what a manifest row is for.
 * When one row stands for several units, the line total is what feeds the
 * totals at the top, so it is spelled out rather than left to the reader.
 */
function LineTotalHint({ item, kind }: { item: Item; kind: 'value' | 'weight' }) {
  const units = unitCount(item);
  if (units < 2) return null;
  if (kind === 'weight') {
    const total = itemWeightGrams(item);
    if (total.grams <= 0) return null;
    return (
      <div className="conversion-hint">
        × {units} = {total.estimated ? '~' : ''}
        {formatGrams(total.grams)}
      </div>
    );
  }
  const total = itemValueTotal(item);
  if (!total) return null;
  return (
    <div className="conversion-hint">
      × {units} = {formatAmount(total.amount, total.currency)}
    </div>
  );
}

function MoneyWithConversion({
  value,
  mainCurrency,
}: {
  value: MoneyValue | undefined;
  mainCurrency: string;
}) {
  const hint = convertedMoneyHint(value, mainCurrency);
  return (
    <>
      <div>{formatMoney(value)}</div>
      {hint ? <div className="conversion-hint">{hint}</div> : null}
    </>
  );
}
