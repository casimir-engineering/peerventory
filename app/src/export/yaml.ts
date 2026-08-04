import { stringify } from 'yaml';

import type {
  Box,
  Dimensions,
  InventoryMeta,
  InventorySnapshot,
  Item,
  LocationEntry,
  MoneyValue,
  OwnerEntry,
  SavedList,
  Weight,
} from '../types';

type YamlObject = Record<string, unknown>;

function definedEntries(entries: Array<[string, unknown]>): YamlObject {
  return Object.fromEntries(
    entries.filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value as object).length === 0
      ) {
        return false;
      }
      return true;
    }),
  );
}

function moneyToYaml(value: MoneyValue | undefined): YamlObject | undefined {
  if (!value) return undefined;
  return definedEntries([
    ['amount', value.amount],
    ['currency', value.currency],
  ]);
}

function weightToYaml(weight: Weight): YamlObject {
  return definedEntries([
    ['class', weight.class],
    ['exactGrams', weight.exactGrams],
  ]);
}

function dimensionsToYaml(dimensions: Dimensions): YamlObject {
  const exactMm = dimensions.exactMm
    ? definedEntries([
        ['l', dimensions.exactMm.l],
        ['w', dimensions.exactMm.w],
        ['h', dimensions.exactMm.h],
      ])
    : undefined;

  return definedEntries([
    ['class', dimensions.class],
    ['exactMm', exactMm],
  ]);
}

function locationToYaml(entry: LocationEntry): YamlObject {
  return definedEntries([
    ['time', entry.time],
    ['lat', entry.lat],
    ['lon', entry.lon],
    ['label', entry.label],
  ]);
}

function ownerToYaml(entry: OwnerEntry): YamlObject {
  return definedEntries([
    ['time', entry.time],
    ['owner', entry.owner],
  ]);
}

function metaToYaml(meta: InventoryMeta): YamlObject {
  return definedEntries([
    ['id', meta.id],
    ['name', meta.name],
    ['description', meta.description],
    ['createdAt', meta.createdAt],
    ['ownerTrackingEnabled', meta.ownerTrackingEnabled],
    ['currency', meta.currency],
  ]);
}

function boxToYaml(box: Box): YamlObject {
  return definedEntries([
    ['id', box.id],
    ['label', box.label],
    ['notes', box.notes],
  ]);
}

function savedListToYaml(savedList: SavedList): YamlObject {
  return definedEntries([
    ['id', savedList.id],
    ['name', savedList.name],
    ['itemIds', savedList.itemIds],
    ['createdAt', savedList.createdAt],
  ]);
}

function itemToYaml(item: Item): YamlObject {
  const purchase = item.purchase
    ? definedEntries([
        ['date', item.purchase.date],
        ['price', moneyToYaml(item.purchase.price)],
        ['vendor', item.purchase.vendor],
      ])
    : undefined;
  const translations = item.translations
    ? Object.fromEntries(
        Object.entries(item.translations)
          .filter(([, translation]) => translation !== '')
          .sort(([left], [right]) => left.localeCompare(right)),
      )
    : undefined;

  return definedEntries([
    ['id', item.id],
    ['description', item.description],
    ['category', item.category],
    ['tags', item.tags],
    ['quantity', item.quantity],
    ['valueCurrent', moneyToYaml(item.valueCurrent)],
    ['valueNew', moneyToYaml(item.valueNew)],
    ['weight', weightToYaml(item.weight)],
    ['dimensions', dimensionsToYaml(item.dimensions)],
    ['serialNumber', item.serialNumber],
    ['purchase', purchase],
    ['boxId', item.boxId],
    ['condition', item.condition],
    ['lithiumBattery', item.lithiumBattery],
    ['countryOfOrigin', item.countryOfOrigin],
    ['acquisition', item.acquisition],
    ['notes', item.notes],
    [
      'photos',
      item.photos.map(({ hash, mime, role }) => definedEntries([
        ['hash', hash],
        ['mime', mime],
        ['role', role],
      ])),
    ],
    ['locationHistory', item.locationHistory.map(locationToYaml)],
    ['ownerHistory', item.ownerHistory.map(ownerToYaml)],
    ['createdAt', item.createdAt],
    ['updatedAt', item.updatedAt],
    ['hsCode', item.hsCode],
    ['brandModel', item.brandModel],
    ['translations', translations],
  ]);
}

export function inventoryToYaml(snap: InventorySnapshot): string {
  const document = definedEntries([
    ['schemaVersion', 1],
    ['meta', metaToYaml(snap.meta)],
    ['boxes', snap.boxes.map(boxToYaml)],
    ['savedLists', snap.savedLists.map(savedListToYaml)],
    [
      'items',
      [...snap.items]
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(itemToYaml),
    ],
  ]);

  return `# inventory export v1, ${new Date().toISOString()}\n${stringify(document, {
    lineWidth: 100,
  })}`;
}
