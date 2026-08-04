import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as services from '../../services';
import { useInventory } from '../../store';
import type { UseInventoryResult } from '../../store/contract';
import type { Box, Item } from '../../types';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, LoadingPage, SectionTitle, SyncingState } from '../components/Common';
import { convertedAmount, formatAmount } from '../lib/format';

type ValueField = 'valueCurrent' | 'valueNew';

interface ValueSummary {
  converted: number;
  convertedCount: number;
  valuedCount: number;
  unconverted: Array<{ currency: string; amount: number }>;
}

interface BreakdownRow {
  key: string;
  label: string;
  count: number;
  value: number;
  valueCount: number;
  unconvertedValueCount: number;
  weightGrams: number;
  weightEstimated: boolean;
  volumeM3: number;
  volumeEstimated: boolean;
}

function quantityOf(item: Item): number {
  return Math.max(1, Number.isFinite(item.quantity) ? item.quantity : 1);
}

function summarizeValue(items: Item[], field: ValueField, mainCurrency: string): ValueSummary {
  let converted = 0;
  let convertedCount = 0;
  let valuedCount = 0;
  const unconverted = new Map<string, number>();

  for (const item of items) {
    const value = item[field];
    if (!value || !Number.isFinite(value.amount)) continue;
    valuedCount += 1;
    const amount = value.amount * quantityOf(item);
    const currency = value.currency?.trim().toUpperCase();
    const result = currency ? convertedAmount(amount, currency, mainCurrency) : null;
    if (result === null) {
      const label = currency || 'No currency';
      unconverted.set(label, (unconverted.get(label) ?? 0) + amount);
    } else {
      converted += result;
      convertedCount += 1;
    }
  }

  return {
    converted,
    convertedCount,
    valuedCount,
    unconverted: [...unconverted.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

function itemWeight(item: Item) {
  const result = services.weightGramsOfItem(item);
  return {
    amount: Number.isFinite(result.grams) ? result.grams * quantityOf(item) : 0,
    estimated: result.estimated,
  };
}

function itemVolume(item: Item) {
  const result = services.volumeM3OfItem(item);
  return {
    amount: Number.isFinite(result.m3) ? result.m3 * quantityOf(item) : 0,
    estimated: result.estimated,
  };
}

function makeBreakdown(
  items: Item[],
  mainCurrency: string,
  groupFor: (item: Item) => { key: string; label: string },
): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>();

  for (const item of items) {
    const group = groupFor(item);
    let row = rows.get(group.key);
    if (!row) {
      row = {
        ...group,
        count: 0,
        value: 0,
        valueCount: 0,
        unconvertedValueCount: 0,
        weightGrams: 0,
        weightEstimated: false,
        volumeM3: 0,
        volumeEstimated: false,
      };
      rows.set(group.key, row);
    }

    row.count += 1;
    const value = item.valueCurrent;
    if (value && Number.isFinite(value.amount)) {
      const converted = convertedAmount(
        value.amount * quantityOf(item),
        value.currency,
        mainCurrency,
      );
      if (converted === null) row.unconvertedValueCount += 1;
      else {
        row.value += converted;
        row.valueCount += 1;
      }
    }

    const weight = itemWeight(item);
    row.weightGrams += weight.amount;
    row.weightEstimated ||= weight.estimated;
    const volume = itemVolume(item);
    row.volumeM3 += volume.amount;
    row.volumeEstimated ||= volume.estimated;
  }

  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function formatVolume(m3: number, estimated: boolean): string {
  const safe = Number.isFinite(m3) ? m3 : 0;
  return `${estimated ? '~' : ''}${safe.toFixed(3)} m³`;
}

export function StatsPage() {
  const { docId = '' } = useParams();
  const inv: UseInventoryResult = useInventory(docId || null);
  const items: Item[] = inv.items ?? [];
  const boxes: Box[] = inv.boxes ?? [];
  const mainCurrency = inv.meta?.currency?.trim().toUpperCase() || 'USD';

  const stats = useMemo(() => {
    const currentValue = summarizeValue(items, 'valueCurrent', mainCurrency);
    const newValue = summarizeValue(items, 'valueNew', mainCurrency);
    let weightGrams = 0;
    let weightEstimated = false;
    let volumeM3 = 0;
    let volumeEstimated = false;

    for (const item of items) {
      const weight = itemWeight(item);
      weightGrams += weight.amount;
      weightEstimated ||= weight.estimated;
      const volume = itemVolume(item);
      volumeM3 += volume.amount;
      volumeEstimated ||= volume.estimated;
    }

    const boxLabels = new Map(boxes.map((box) => [box.id, box.label]));
    return {
      quantity: items.reduce((total, item) => total + quantityOf(item), 0),
      currentValue,
      newValue,
      weightGrams,
      weightEstimated,
      volumeM3,
      volumeEstimated,
      lithiumCount: items.filter((item) => item.lithiumBattery).length,
      photoCount: items.reduce((total, item) => total + (item.photos?.length ?? 0), 0),
      byBox: makeBreakdown(items, mainCurrency, (item) => ({
        key: item.boxId ?? '__unboxed__',
        label: item.boxId ? (boxLabels.get(item.boxId) ?? 'Unknown box') : 'Unboxed',
      })),
      byCategory: makeBreakdown(items, mainCurrency, (item) => ({
        key: item.category?.trim().toLocaleLowerCase() || '__uncategorized__',
        label: item.category?.trim() || 'Uncategorized',
      })),
    };
  }, [boxes, items, mainCurrency]);

  if (!inv.loaded) {
    return (
      <>
        <AppHeader title="Stats" back={`/inv/${docId}`} />
        <main className="page">
          <LoadingPage />
        </main>
      </>
    );
  }

  if (!inv.meta) {
    return (
      <>
        <AppHeader title="Stats" back={`/inv/${docId}`} status={inv.syncStatus} />
        <main className="page narrow">
          {inv.syncStatus === 'connecting' ? (
            <SyncingState body="This inventory has not reached this device yet, so totals are not available." />
          ) : (
            <EmptyState
              title="Inventory not available"
              body="This inventory is not stored on this device."
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

  return (
    <>
      <AppHeader
        title="Stats"
        subtitle={inv.meta.name}
        back={`/inv/${docId}`}
        status={inv.syncStatus}
      />
      <main className="page stats-page">
        <div className="stack loose">
          <section className="stats-summary">
            <StatCard label="Items" value={String(items.length)} detail={`${stats.quantity} total quantity`} />
            <StatCard
              label={`Current value in ${mainCurrency}`}
              value={
                stats.currentValue.valuedCount === 0
                  ? '—'
                  : stats.currentValue.convertedCount === 0
                    ? 'Not converted'
                    : formatAmount(stats.currentValue.converted, mainCurrency)
              }
            >
              <UnconvertedLines summary={stats.currentValue} />
            </StatCard>
            <StatCard
              label={stats.weightEstimated ? 'Estimated weight' : 'Weight'}
              value={`${stats.weightEstimated ? '~' : ''}${services.formatGrams(stats.weightGrams)}`}
            />
            <StatCard
              label={stats.volumeEstimated ? 'Estimated volume' : 'Volume'}
              value={formatVolume(stats.volumeM3, stats.volumeEstimated)}
            />
            <StatCard label="Lithium battery items" value={String(stats.lithiumCount)} />
            <StatCard label="Photos" value={String(stats.photoCount)} />
          </section>

          <section className="card replacement-row">
            <div>
              <div className="tiny faint">Value when new in {mainCurrency}</div>
              <div className="replacement-value">
                {stats.newValue.valuedCount === 0
                  ? '—'
                  : stats.newValue.convertedCount === 0
                    ? 'Not converted'
                    : formatAmount(stats.newValue.converted, mainCurrency)}
              </div>
            </div>
            <UnconvertedLines summary={stats.newValue} compact />
          </section>

          <div className="stats-breakdowns">
            <BreakdownTable title="By box" rows={stats.byBox} mainCurrency={mainCurrency} />
            <BreakdownTable
              title="By category"
              rows={stats.byCategory}
              mainCurrency={mainCurrency}
            />
          </div>

          {(stats.weightEstimated || stats.volumeEstimated) && (
            <p className="tiny faint">
              The ~ mark means at least one item uses its weight or size class estimate instead of
              an exact measurement.
            </p>
          )}
        </div>
      </main>
    </>
  );
}

function StatCard({
  label,
  value,
  detail,
  children,
}: {
  label: string;
  value: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <article className="stat-card">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {detail ? <div className="tiny faint">{detail}</div> : null}
      {children}
    </article>
  );
}

function UnconvertedLines({
  summary,
  compact = false,
}: {
  summary: ValueSummary;
  compact?: boolean;
}) {
  if (summary.unconverted.length === 0) return null;
  return (
    <div className={compact ? 'unconverted compact' : 'unconverted'}>
      <span>Not converted:</span>{' '}
      {summary.unconverted.map((line, index) => (
        <span key={line.currency}>
          {index > 0 ? ' + ' : ''}
          {line.currency === 'No currency'
            ? `${line.amount.toLocaleString()} (no currency)`
            : formatAmount(line.amount, line.currency)}
        </span>
      ))}
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  mainCurrency,
}: {
  title: string;
  rows: BreakdownRow[];
  mainCurrency: string;
}) {
  return (
    <section className="stack tight stats-table-section">
      <SectionTitle>{title}</SectionTitle>
      <div className="table-wrap">
        <table className="data stats-table">
          <thead>
            <tr>
              <th>{title === 'By box' ? 'Box' : 'Category'}</th>
              <th className="num">Count</th>
              <th className="num">Value ({mainCurrency})</th>
              <th className="num">Weight</th>
              <th className="num">Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="faint">
                  No items
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td className="num">{row.count}</td>
                  <td className="num">
                    {row.valueCount > 0 ? formatAmount(row.value, mainCurrency) : '—'}
                    {row.unconvertedValueCount > 0 ? (
                      <div className="conversion-hint">
                        {row.unconvertedValueCount} not converted
                      </div>
                    ) : null}
                  </td>
                  <td className="num">
                    {row.weightEstimated ? '~' : ''}
                    {services.formatGrams(row.weightGrams)}
                  </td>
                  <td className="num">{formatVolume(row.volumeM3, row.volumeEstimated)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
