import { Workbook, type Worksheet } from 'exceljs';

import {
  SIZE_CLASSES,
  WEIGHT_CLASSES,
  type InventorySnapshot,
  type Item,
  type MoneyValue,
} from '../types';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const MANIFEST_COLUMNS = [
  { header: '#', key: 'number', width: 6 },
  { header: 'Description', key: 'description', width: 34 },
  { header: 'Brand/Model', key: 'brandModel', width: 22 },
  { header: 'Qty', key: 'quantity', width: 8 },
  { header: 'Unit value', key: 'unitValue', width: 13 },
  { header: 'Currency', key: 'currency', width: 11 },
  { header: 'Total value', key: 'totalValue', width: 18 },
  { header: 'Value when new', key: 'valueNew', width: 18 },
  { header: 'Weight', key: 'weight', width: 15 },
  { header: 'Dimensions', key: 'dimensions', width: 24 },
  { header: 'Serial number', key: 'serialNumber', width: 22 },
  { header: 'Box', key: 'box', width: 16 },
  { header: 'Lithium battery', key: 'lithiumBattery', width: 16 },
  { header: 'Country of origin', key: 'countryOfOrigin', width: 18 },
  { header: 'Condition', key: 'condition', width: 14 },
  { header: 'HS code', key: 'hsCode', width: 14 },
  { header: 'Notes', key: 'notes', width: 32 },
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

function populateManifest(
  worksheet: Worksheet,
  snap: InventorySnapshot,
  items: Item[],
): void {
  const boxLabels = new Map(snap.boxes.map((box) => [box.id, box.label]));
  worksheet.columns = MANIFEST_COLUMNS.map((column) => ({ ...column }));

  const totalsByCurrency = new Map<string, number>();
  let totalQuantity = 0;
  let totalWeightGrams = 0;

  items.forEach((item, index) => {
    const currentTotal = item.valueCurrent
      ? item.valueCurrent.amount * item.quantity
      : undefined;
    if (item.valueCurrent) {
      totalsByCurrency.set(
        item.valueCurrent.currency,
        (totalsByCurrency.get(item.valueCurrent.currency) ?? 0) + currentTotal!,
      );
    }
    totalQuantity += item.quantity;
    totalWeightGrams += estimatedWeightGrams(item) * item.quantity;

    worksheet.addRow({
      number: index + 1,
      description: item.description,
      brandModel: item.brandModel ?? '',
      quantity: item.quantity,
      unitValue: item.valueCurrent?.amount ?? '',
      currency: item.valueCurrent?.currency ?? '',
      totalValue: currentTotal ?? '',
      valueNew: formatValueWhenNew(
        item.valueNew,
        item.valueCurrent?.currency ?? snap.meta.currency,
      ),
      weight: formatWeight(item),
      dimensions: formatDimensions(item),
      serialNumber: item.serialNumber ?? '',
      box: item.boxId ? (boxLabels.get(item.boxId) ?? '') : '',
      lithiumBattery: item.lithiumBattery ? 'YES' : '',
      countryOfOrigin: item.countryOfOrigin ?? '',
      condition: item.condition ?? '',
      hsCode: item.hsCode ?? '',
      notes: item.notes ?? '',
    });
  });

  const totalValues = [...totalsByCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => `${formatDecimal(amount, 2)} ${currency}`)
    .join('\n');
  const totalsRow = worksheet.addRow({
    description: 'TOTALS',
    quantity: totalQuantity,
    totalValue: totalValues,
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
  worksheet.getColumn('unitValue').numFmt = '#,##0.00';
  worksheet.getColumn('totalValue').numFmt = '#,##0.00';
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
): Promise<Blob> {
  const workbook = new Workbook();
  workbook.creator = 'Inventory App';
  workbook.created = new Date();

  const items = selectItems(snap, itemIds);
  populateManifest(workbook.addWorksheet('Manifest'), snap, items);
  populateFullData(workbook.addWorksheet('Full data'), snap, items);

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const browserBuffer = new Uint8Array(bytes.byteLength);
  browserBuffer.set(bytes);
  return new Blob([browserBuffer], { type: XLSX_MIME });
}
