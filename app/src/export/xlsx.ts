import { Workbook, type Image as ExcelImage, type Worksheet } from 'exceljs';

import { convert } from '../services/currency';
import {
  SIZE_CLASSES,
  WEIGHT_CLASSES,
  type InventorySnapshot,
  type Item,
  type MoneyValue,
  type PhotoRef,
} from '../types';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A photo already downscaled to thumbnail size, ready to embed. */
export interface XlsxPhoto {
  /** JPEG bytes. */
  data: ArrayBuffer;
  width: number;
  height: number;
}

/** Loads + downscales an item's main photo. Null = leave the cell empty. */
export type XlsxPhotoLoader = (photo: PhotoRef) => Promise<XlsxPhoto | null>;

/**
 * Column order is what a customs forwarder scans for, most important first.
 * Widths are Excel character units (~7px each).
 */
const MANIFEST_COLUMNS = [
  { header: 'Photo', key: 'photo', width: 24 },
  { header: 'Item name', key: 'itemName', width: 32 },
  { header: 'Qty', key: 'quantity', width: 6 },
  { header: 'Description', key: 'description', width: 34 },
  { header: 'Value', key: 'value', width: 12 },
  { header: 'Currency', key: 'currency', width: 10 },
  { header: 'Value new', key: 'valueNew', width: 14 },
  { header: 'HS code', key: 'hsCode', width: 13 },
  { header: 'Origin', key: 'countryOfOrigin', width: 9 },
  { header: 'Brand/Model', key: 'brandModel', width: 22 },
  { header: 'Serial number', key: 'serialNumber', width: 20 },
  { header: 'Weight', key: 'weight', width: 13 },
  { header: 'Dimensions', key: 'dimensions', width: 20 },
  { header: 'Condition', key: 'condition', width: 12 },
  { header: 'Category', key: 'category', width: 15 },
  { header: 'Location', key: 'location', width: 18 },
  { header: 'Owner', key: 'owner', width: 14 },
  { header: 'Item ID', key: 'id', width: 13 },
] as const;

const FULL_DATA_COLUMNS = [
  ['ID', 'id'],
  ['Description', 'description'],
  ['Category', 'category'],
  ['Tags', 'tags'],
  ['Quantity', 'quantity'],
  ['Current value', 'currentValue'],
  ['Current currency', 'currentCurrency'],
  ['Value when new', 'valueNew'],
  ['New value currency', 'valueNewCurrency'],
  ['Weight class', 'weightClass'],
  ['Weight class label', 'weightClassLabel'],
  ['Exact weight (g)', 'exactWeightGrams'],
  ['Size class', 'sizeClass'],
  ['Size class label', 'sizeClassLabel'],
  ['Length (mm)', 'lengthMm'],
  ['Width (mm)', 'widthMm'],
  ['Height (mm)', 'heightMm'],
  ['Serial number', 'serialNumber'],
  ['Purchase date', 'purchaseDate'],
  ['Purchase price', 'purchasePrice'],
  ['Purchase currency', 'purchaseCurrency'],
  ['Purchase vendor', 'purchaseVendor'],
  ['Box ID', 'boxId'],
  ['Box', 'box'],
  ['Condition', 'condition'],
  ['Lithium battery', 'lithiumBattery'],
  ['Country of origin', 'countryOfOrigin'],
  ['Acquisition', 'acquisition'],
  ['Notes', 'notes'],
  ['HS code', 'hsCode'],
  ['Brand/Model', 'brandModel'],
  ['Translations', 'translations'],
  ['Current location time', 'currentLocationTime'],
  ['Current location latitude', 'currentLocationLatitude'],
  ['Current location longitude', 'currentLocationLongitude'],
  ['Current location label', 'currentLocationLabel'],
  ['Location history', 'locationHistory'],
  ['Current owner', 'currentOwner'],
  ['Current owner since', 'currentOwnerSince'],
  ['Owner history', 'ownerHistory'],
  ['Photo count', 'photoCount'],
  ['Photos', 'photos'],
  ['Created at', 'createdAt'],
  ['Updated at', 'updatedAt'],
] as const;

function formatDecimal(value: number, maximumFractionDigits = 3): string {
  return value.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits,
  });
}

function formatExactWeight(grams: number): string {
  return grams < 1000
    ? `${formatDecimal(grams)} g`
    : `${formatDecimal(grams / 1000)} kg`;
}

function formatWeight(item: Item): string {
  return item.weight.exactGrams !== undefined
    ? formatExactWeight(item.weight.exactGrams)
    : WEIGHT_CLASSES[item.weight.class].label;
}

function estimatedWeightGrams(item: Item): number {
  if (item.weight.exactGrams !== undefined) return item.weight.exactGrams;
  const weightClass = WEIGHT_CLASSES[item.weight.class];
  return weightClass.maxG === null
    ? weightClass.minG
    : (weightClass.minG + weightClass.maxG) / 2;
}

function formatDimensions(item: Item): string {
  const exact = item.dimensions.exactMm;
  if (exact) {
    return `${formatDecimal(exact.l)}×${formatDecimal(exact.w)}×${formatDecimal(exact.h)} mm`;
  }
  return SIZE_CLASSES[item.dimensions.class].label;
}

function formatValueWhenNew(
  value: MoneyValue | undefined,
  rowCurrency: string,
): number | string {
  if (!value) return '';
  return value.currency === rowCurrency
    ? value.amount
    : `${formatDecimal(value.amount, 2)} ${value.currency}`;
}

function toIso(time: number | undefined): string {
  return time === undefined ? '' : new Date(time).toISOString();
}

function selectItems(snap: InventorySnapshot, itemIds?: string[]): Item[] {
  if (itemIds !== undefined) {
    const byId = new Map(snap.items.map((item) => [item.id, item]));
    return itemIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }

  const boxLabels = new Map(snap.boxes.map((box) => [box.id, box.label]));
  return [...snap.items].sort((left, right) => {
    const boxComparison = (boxLabels.get(left.boxId ?? '') ?? '').localeCompare(
      boxLabels.get(right.boxId ?? '') ?? '',
    );
    return boxComparison || left.description.localeCompare(right.description) || left.id.localeCompare(right.id);
  });
}

function ownerName(snap: InventorySnapshot, item: Item): string {
  const entry = item.ownerHistory.at(-1);
  if (!entry) return '';
  if (entry.ownerId) {
    const dir = snap.owners?.[entry.ownerId];
    if (dir?.name) return dir.name;
  }
  return entry.owner ?? '';
}

async function populateManifest(
  workbook: Workbook,
  worksheet: Worksheet,
  snap: InventorySnapshot,
  items: Item[],
  loadPhoto?: XlsxPhotoLoader,
): Promise<void> {
  worksheet.columns = MANIFEST_COLUMNS.map((column) => ({ ...column }));

  const mainCurrency = snap.meta.currency;
  let totalQuantity = 0;
  let totalWeightGrams = 0;
  let totalValueMain = 0;
  const unconvertible = new Map<string, number>();

  for (const item of items) {
    const quantity = item.quantity || 1;
    totalQuantity += quantity;
    totalWeightGrams += estimatedWeightGrams(item) * quantity;
    if (item.valueCurrent) {
      const lineTotal = item.valueCurrent.amount * quantity;
      const converted = convert(lineTotal, item.valueCurrent.currency, mainCurrency);
      if (converted === null) {
        unconvertible.set(
          item.valueCurrent.currency,
          (unconvertible.get(item.valueCurrent.currency) ?? 0) + lineTotal,
        );
      } else {
        totalValueMain += converted;
      }
    }

    const currentLocation = item.locationHistory.at(-1);
    const row = worksheet.addRow({
      photo: '',
      itemName: item.description,
      quantity,
      description: item.notes ?? '',
      value: item.valueCurrent?.amount ?? '',
      currency: item.valueCurrent?.currency ?? '',
      valueNew: formatValueWhenNew(
        item.valueNew,
        item.valueCurrent?.currency ?? mainCurrency,
      ),
      hsCode: item.hsCode ?? '',
      countryOfOrigin: item.countryOfOrigin ?? '',
      brandModel: item.brandModel ?? '',
      serialNumber: item.serialNumber ?? '',
      weight: formatWeight(item),
      dimensions: formatDimensions(item),
      condition: item.condition ?? '',
      category: item.category ?? '',
      location: currentLocation?.label ?? '',
      owner: ownerName(snap, item),
      id: item.id,
    });
    row.alignment = { vertical: 'middle', wrapText: true };

    const mainPhoto = item.photos[0];
    if (mainPhoto && loadPhoto) {
      const thumb = await loadPhoto(mainPhoto);
      if (thumb) {
        // exceljs' Buffer type is just `interface Buffer extends ArrayBuffer`.
        const imageId = workbook.addImage({
          buffer: thumb.data as ExcelImage['buffer'],
          extension: 'jpeg',
        });
        // Anchor inside the Photo cell with a small inset; ext is in pixels.
        worksheet.addImage(imageId, {
          tl: { col: 0.1, row: row.number - 1 + 0.05 },
          ext: { width: thumb.width, height: thumb.height },
          editAs: 'oneCell',
        });
        // Row height is in points (1px = 0.75pt); add a little padding.
        row.height = Math.max(20, thumb.height * 0.75 + 6);
      }
    }
  }

  const extraTotals = [...unconvertible.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => `${formatDecimal(amount, 2)} ${currency}`);
  const totalsRow = worksheet.addRow({
    itemName: `TOTALS (${items.length} items)`,
    quantity: totalQuantity,
    value:
      extraTotals.length === 0
        ? totalValueMain
        : [`${formatDecimal(totalValueMain, 2)} ${mainCurrency}`, ...extraTotals].join(' + '),
    currency: extraTotals.length === 0 ? mainCurrency : '',
    weight: `~${formatDecimal(totalWeightGrams / 1000)} kg`,
  });

  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: MANIFEST_COLUMNS.length },
  };
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E78' },
  };
  worksheet.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  worksheet.getRow(1).height = 30;
  totalsRow.font = { bold: true };
  totalsRow.alignment = { vertical: 'top', wrapText: true };
  worksheet.getColumn('value').numFmt = '#,##0.00';
  worksheet.getColumn('valueNew').numFmt = '#,##0.00';
}

function populateFullData(
  worksheet: Worksheet,
  snap: InventorySnapshot,
  items: Item[],
): void {
  const boxLabels = new Map(snap.boxes.map((box) => [box.id, box.label]));
  worksheet.columns = FULL_DATA_COLUMNS.map(([header, key]) => ({ header, key }));

  for (const item of items) {
    const currentLocation = item.locationHistory.at(-1);
    const currentOwner = item.ownerHistory.at(-1);
    worksheet.addRow({
      id: item.id,
      description: item.description,
      category: item.category ?? '',
      tags: item.tags.join(', '),
      quantity: item.quantity,
      currentValue: item.valueCurrent?.amount ?? '',
      currentCurrency: item.valueCurrent?.currency ?? '',
      valueNew: item.valueNew?.amount ?? '',
      valueNewCurrency: item.valueNew?.currency ?? '',
      weightClass: item.weight.class,
      weightClassLabel: WEIGHT_CLASSES[item.weight.class].label,
      exactWeightGrams: item.weight.exactGrams ?? '',
      sizeClass: item.dimensions.class,
      sizeClassLabel: SIZE_CLASSES[item.dimensions.class].label,
      lengthMm: item.dimensions.exactMm?.l ?? '',
      widthMm: item.dimensions.exactMm?.w ?? '',
      heightMm: item.dimensions.exactMm?.h ?? '',
      serialNumber: item.serialNumber ?? '',
      purchaseDate: item.purchase?.date ?? '',
      purchasePrice: item.purchase?.price?.amount ?? '',
      purchaseCurrency: item.purchase?.price?.currency ?? '',
      purchaseVendor: item.purchase?.vendor ?? '',
      boxId: item.boxId ?? '',
      box: item.boxId ? (boxLabels.get(item.boxId) ?? '') : '',
      condition: item.condition ?? '',
      lithiumBattery: item.lithiumBattery === undefined ? '' : item.lithiumBattery,
      countryOfOrigin: item.countryOfOrigin ?? '',
      acquisition: item.acquisition ?? '',
      notes: item.notes ?? '',
      hsCode: item.hsCode ?? '',
      brandModel: item.brandModel ?? '',
      translations: item.translations ? JSON.stringify(item.translations) : '',
      currentLocationTime: toIso(currentLocation?.time),
      currentLocationLatitude: currentLocation?.lat ?? '',
      currentLocationLongitude: currentLocation?.lon ?? '',
      currentLocationLabel: currentLocation?.label ?? '',
      locationHistory: item.locationHistory.length ? JSON.stringify(item.locationHistory) : '',
      currentOwner: currentOwner?.owner ?? '',
      currentOwnerSince: toIso(currentOwner?.time),
      ownerHistory: item.ownerHistory.length ? JSON.stringify(item.ownerHistory) : '',
      photoCount: item.photos.length,
      photos: item.photos.length ? JSON.stringify(item.photos) : '',
      createdAt: toIso(item.createdAt),
      updatedAt: toIso(item.updatedAt),
    });
  }

  worksheet.getRow(1).font = { bold: true };
}

export async function inventoryToXlsx(
  snap: InventorySnapshot,
  itemIds?: string[],
  loadPhoto?: XlsxPhotoLoader,
): Promise<Blob> {
  const workbook = new Workbook();
  workbook.creator = 'Peerventory';
  workbook.created = new Date();

  const items = selectItems(snap, itemIds);
  await populateManifest(workbook, workbook.addWorksheet('Manifest'), snap, items, loadPhoto);
  populateFullData(workbook.addWorksheet('Full data'), snap, items);

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const browserBuffer = new Uint8Array(bytes.byteLength);
  browserBuffer.set(bytes);
  return new Blob([browserBuffer], { type: XLSX_MIME });
}
