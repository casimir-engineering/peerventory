import JSZip from 'jszip';
import { parse } from 'yaml';

import {
  SIZE_CLASSES,
  WEIGHT_CLASSES,
  type AcquisitionMethod,
  type Box,
  type Dimensions,
  type InventoryMeta,
  type InventorySnapshot,
  type Item,
  type LocationEntry,
  type MoneyValue,
  type OwnerEntry,
  type PhotoRef,
  type PhotoRole,
  type SavedList,
  type Weight,
} from '../../types';

export interface ParsedImport {
  snapshot: InventorySnapshot;
  photoBlobs: Map<string, Blob>;
  skippedItems: number;
}

const NOT_EXPORT_ERROR = 'This file is not an inventory export (YAML or ZIP)';
const PHOTO_ROLES = new Set<PhotoRole>(['photo', 'serial_label', 'receipt']);
const ACQUISITION_METHODS = new Set<AcquisitionMethod>(['new', 'used', 'gift']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseMoney(value: unknown): MoneyValue | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.amount) || typeof value.currency !== 'string') {
    return undefined;
  }
  return { amount: value.amount, currency: value.currency };
}

function parseWeight(value: unknown): Weight | null {
  if (
    !isRecord(value) ||
    typeof value.class !== 'string' ||
    !hasOwn(WEIGHT_CLASSES, value.class)
  ) {
    return null;
  }
  return {
    class: value.class as Weight['class'],
    ...(isFiniteNumber(value.exactGrams) ? { exactGrams: value.exactGrams } : {}),
  };
}

function parseDimensions(value: unknown): Dimensions | null {
  if (
    !isRecord(value) ||
    typeof value.class !== 'string' ||
    !hasOwn(SIZE_CLASSES, value.class)
  ) {
    return null;
  }

  let exactMm: Dimensions['exactMm'];
  if (
    isRecord(value.exactMm) &&
    isFiniteNumber(value.exactMm.l) &&
    isFiniteNumber(value.exactMm.w) &&
    isFiniteNumber(value.exactMm.h)
  ) {
    exactMm = { l: value.exactMm.l, w: value.exactMm.w, h: value.exactMm.h };
  }

  return {
    class: value.class as Dimensions['class'],
    ...(exactMm ? { exactMm } : {}),
  };
}

function parsePhotos(value: unknown): PhotoRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PhotoRef[] => {
    if (!isRecord(entry) || typeof entry.hash !== 'string' || typeof entry.mime !== 'string') {
      return [];
    }
    const role =
      typeof entry.role === 'string' && PHOTO_ROLES.has(entry.role as PhotoRole)
        ? (entry.role as PhotoRole)
        : 'photo';
    return [
      {
        hash: entry.hash,
        mime: entry.mime,
        role,
        addedAt: isFiniteNumber(entry.addedAt) ? entry.addedAt : 0,
      },
    ];
  });
}

function parseLocations(value: unknown): LocationEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LocationEntry[] => {
    if (!isRecord(entry) || !isFiniteNumber(entry.time)) return [];
    return [
      {
        time: entry.time,
        ...(isFiniteNumber(entry.lat) ? { lat: entry.lat } : {}),
        ...(isFiniteNumber(entry.lon) ? { lon: entry.lon } : {}),
        ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
      },
    ];
  });
}

function parseOwners(value: unknown): OwnerEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): OwnerEntry[] => {
    if (!isRecord(entry) || !isFiniteNumber(entry.time) || typeof entry.owner !== 'string') {
      return [];
    }
    return [{ time: entry.time, owner: entry.owner }];
  });
}

function parseTranslations(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const translations = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return Object.keys(translations).length > 0 ? translations : undefined;
}

function parsePurchase(value: unknown): Item['purchase'] {
  if (!isRecord(value)) return undefined;
  const price = parseMoney(value.price);
  const purchase = {
    ...(typeof value.date === 'string' ? { date: value.date } : {}),
    ...(price ? { price } : {}),
    ...(typeof value.vendor === 'string' ? { vendor: value.vendor } : {}),
  };
  return Object.keys(purchase).length > 0 ? purchase : undefined;
}

function parseItem(value: unknown): Item | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.description !== 'string'
  ) {
    return null;
  }
  const weight = parseWeight(value.weight);
  const dimensions = parseDimensions(value.dimensions);
  if (!weight || !dimensions) return null;

  const createdAt = isFiniteNumber(value.createdAt) ? value.createdAt : 0;
  const purchase = parsePurchase(value.purchase);
  const valueCurrent = parseMoney(value.valueCurrent);
  const valueNew = parseMoney(value.valueNew);
  const translations = parseTranslations(value.translations);
  const acquisition =
    typeof value.acquisition === 'string' &&
    ACQUISITION_METHODS.has(value.acquisition as AcquisitionMethod)
      ? (value.acquisition as AcquisitionMethod)
      : undefined;

  return {
    id: value.id,
    description: value.description,
    createdAt,
    updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : createdAt,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    quantity: isFiniteNumber(value.quantity) ? value.quantity : 1,
    photos: parsePhotos(value.photos),
    locationHistory: parseLocations(value.locationHistory),
    ownerHistory: parseOwners(value.ownerHistory),
    weight,
    dimensions,
    category: optionalString(value.category),
    valueCurrent,
    valueNew,
    ownerDisabled: typeof value.ownerDisabled === 'boolean' ? value.ownerDisabled : undefined,
    serialNumber: optionalString(value.serialNumber),
    purchase,
    boxId: optionalString(value.boxId),
    condition: optionalString(value.condition),
    lithiumBattery:
      typeof value.lithiumBattery === 'boolean' ? value.lithiumBattery : undefined,
    countryOfOrigin: optionalString(value.countryOfOrigin),
    acquisition,
    notes: optionalString(value.notes),
    hsCode: optionalString(value.hsCode),
    brandModel: optionalString(value.brandModel),
    translations,
  };
}

function parseBoxes(value: unknown): Box[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Box[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.label !== 'string') {
      return [];
    }
    return [
      {
        id: entry.id,
        label: entry.label,
        ...(typeof entry.notes === 'string' ? { notes: entry.notes } : {}),
      },
    ];
  });
}

function parseSavedLists(value: unknown): SavedList[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SavedList[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
      return [];
    }
    return [
      {
        id: entry.id,
        name: entry.name,
        itemIds: Array.isArray(entry.itemIds)
          ? entry.itemIds.filter((id): id is string => typeof id === 'string')
          : [],
        createdAt: isFiniteNumber(entry.createdAt) ? entry.createdAt : 0,
      },
    ];
  });
}

function parseDocument(source: string, fallbackName: string): Omit<ParsedImport, 'photoBlobs'> {
  let document: unknown;
  try {
    document = parse(source);
  } catch {
    throw new Error(NOT_EXPORT_ERROR);
  }

  if (
    !isRecord(document) ||
    document.schemaVersion !== 1 ||
    !isRecord(document.meta) ||
    typeof document.meta.id !== 'string' ||
    document.meta.id.length === 0
  ) {
    throw new Error(NOT_EXPORT_ERROR);
  }

  const rawMeta = document.meta;
  const meta: InventoryMeta = {
    id: rawMeta.id as string,
    name:
      typeof rawMeta.name === 'string' && rawMeta.name.trim()
        ? rawMeta.name
        : fallbackName || 'Imported inventory',
    createdAt: isFiniteNumber(rawMeta.createdAt) ? rawMeta.createdAt : 0,
    ownerTrackingEnabled:
      typeof rawMeta.ownerTrackingEnabled === 'boolean' ? rawMeta.ownerTrackingEnabled : true,
    currency:
      typeof rawMeta.currency === 'string' && rawMeta.currency.trim()
        ? rawMeta.currency
        : 'USD',
    description: optionalString(rawMeta.description),
    preciseLocation:
      typeof rawMeta.preciseLocation === 'boolean' ? rawMeta.preciseLocation : undefined,
  };

  const rawItems = Array.isArray(document.items) ? document.items : [];
  const items: Item[] = [];
  let skippedItems = 0;
  for (const rawItem of rawItems) {
    const item = parseItem(rawItem);
    if (item) items.push(item);
    else skippedItems += 1;
  }

  return {
    snapshot: {
      meta,
      items,
      boxes: parseBoxes(document.boxes),
      savedLists: parseSavedLists(document.savedLists),
    },
    skippedItems,
  };
}

function fileBaseName(fileName: string): string {
  return fileName.replace(/\.(?:ya?ml|zip)$/i, '').trim();
}

function mimeForPhotoPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

async function parseZip(file: File, fallbackName: string): Promise<ParsedImport> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error(NOT_EXPORT_ERROR);
  }

  const inventoryEntry = zip.file('inventory.yaml');
  if (!inventoryEntry) throw new Error('This archive does not contain inventory.yaml');

  let parsed: Omit<ParsedImport, 'photoBlobs'>;
  try {
    parsed = parseDocument(await inventoryEntry.async('string'), fallbackName);
  } catch {
    throw new Error(NOT_EXPORT_ERROR);
  }

  const photoBlobs = new Map<string, Blob>();
  await Promise.all(
    Object.values(zip.files).map(async (entry) => {
      if (entry.dir || !entry.name.startsWith('photos/')) return;
      const fileName = entry.name.split('/').pop() ?? '';
      const extensionAt = fileName.lastIndexOf('.');
      const hash = extensionAt > 0 ? fileName.slice(0, extensionAt) : fileName;
      if (!hash) return;
      const bytes = await entry.async('uint8array');
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      photoBlobs.set(hash, new Blob([buffer], { type: mimeForPhotoPath(fileName) }));
    }),
  );

  return { ...parsed, photoBlobs };
}

function hasZipSignature(file: File): Promise<boolean> {
  return file
    .slice(0, 4)
    .arrayBuffer()
    .then((buffer) => {
      const bytes = new Uint8Array(buffer);
      return (
        bytes.length >= 4 &&
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
        (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
      );
    })
    .catch(() => false);
}

export async function parseInventoryFile(file: File): Promise<ParsedImport> {
  const fallbackName = fileBaseName(file.name);
  const lowerName = file.name.toLowerCase();
  const looksLikeZip =
    lowerName.endsWith('.zip') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    (await hasZipSignature(file));

  if (looksLikeZip) return parseZip(file, fallbackName);

  let source: string;
  try {
    source = await file.text();
  } catch {
    throw new Error(NOT_EXPORT_ERROR);
  }

  const hasYamlExtension = /\.ya?ml$/i.test(file.name);
  const hasExportMarker =
    source.trimStart().startsWith('# inventory export') || /\bschemaVersion\s*:\s*1\b/.test(source);
  if (!hasYamlExtension && !hasExportMarker) throw new Error(NOT_EXPORT_ERROR);

  const parsed = parseDocument(source, fallbackName);
  return { ...parsed, photoBlobs: new Map<string, Blob>() };
}
