import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  analyzeItemPhotos,
  formatGrams,
  getLastCurrency,
  itemValueTotal,
  itemWeightGrams,
  rememberInput,
  rememberPlace,
  setLastCurrency,
  suggestInputs,
  unitCount,
} from '../../services';
import type { AiSuggestions } from '../../services';
import { getPhotoBlob, ownerDisplayName, useInventory } from '../../store';
import type { ItemPatch, UseInventoryResult } from '../../store/contract';
import type {
  AcquisitionMethod,
  Box,
  Item,
  LocationEntry,
  MoneyValue,
  PhotoRole,
} from '../../types';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, LoadingPage, SectionTitle, SyncingState } from '../components/Common';
import {
  SizePicker,
  WeightPicker,
  sizeClassForMm,
  weightClassForGrams,
} from '../components/ClassPickers';
import {
  AiReviewModal,
  Field,
  InlineMoney,
  InlineSelect,
  InlineText,
  PlaceInput,
  Stepper,
  Toggle,
} from '../components/Fields';
import type { AiFieldKey } from '../components/Fields';
import { ConfirmModal, Modal } from '../components/Modal';
import { MoveItemModal } from '../components/MoveItemModal';
import { SmartCombo } from '../components/SmartCombo';
import { OcrScanner } from '../components/OcrScanner';
import { PhotoGallery, type PendingPhotoPreview } from '../components/Photos';
import { SellModal } from '../components/SellModal';
import { ShareModal } from '../components/ShareModal';
import { useToast } from '../components/Toast';
import { countryComboOptions } from '../lib/countries';
import {
  formatAmount,
  formatDateTime,
  locationText,
  parseTags,
  sizeLabel,
  weightLabel,
} from '../lib/format';
import { matchSerial } from '../lib/serial';
import { getLocationWithPlace } from '../lib/geo';
import '../entry.css';

/** Recent entries for this key first, then whatever the inventory already holds. */
function mergeSuggestions(key: string, existing: string[]): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const clean = (value ?? '').trim();
    if (clean !== '' && !out.includes(clean)) out.push(clean);
  };
  try {
    for (const value of suggestInputs(key)) push(value);
  } catch {
    /* no history yet; the inventory values are enough */
  }
  for (const value of existing) push(value);
  return out;
}

/**
 * The sheet describes a single object, so every figure on it is per unit.
 * When it stands for several units, this spells out what they add up to —
 * the same line totals the stats, list totals and exports are built from.
 */
function MultiUnitHint({ item }: { item: Item }) {
  const units = unitCount(item);
  if (units < 2) return null;
  const value = itemValueTotal(item);
  const weight = itemWeightGrams(item);
  const parts = [
    value ? `value ${formatAmount(value.amount, value.currency)}` : null,
    weight.grams > 0 ? `weight ${weight.estimated ? '~' : ''}${formatGrams(weight.grams)}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="tiny faint">
      Every figure below is for one unit. × {units} = total {parts.join(', ')}.
    </p>
  );
}

export function ItemSheetPage() {
  const { docId = '', itemId = '' } = useParams();
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const inv: UseInventoryResult = useInventory(docId || null);

  const [sharing, setSharing] = useState(false);
  const [selling, setSelling] = useState(false);
  const [moving, setMoving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [pendingPhotos, setPendingPhotos] = useState<PendingPhotoPreview[]>([]);
  const pendingPhotosRef = useRef<PendingPhotoPreview[]>([]);
  pendingPhotosRef.current = pendingPhotos;
  // Leaving the sheet mid-save must not leak the preview URLs.
  useEffect(
    () => () => {
      for (const photo of pendingPhotosRef.current) URL.revokeObjectURL(photo.url);
    },
    [],
  );
  const [locationDraft, setLocationDraft] = useState('');
  const [locationPick, setLocationPick] = useState<{ lat: number; lon: number } | null>(null);
  const [ownerDraft, setOwnerDraft] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestions | null>(null);

  const allItems: Item[] = inv.items ?? [];

  const ownerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const candidate of allItems) {
      const last = candidate.ownerHistory?.[candidate.ownerHistory.length - 1];
      const name = last ? ownerDisplayName(inv.owners, last) : '';
      if (name) set.add(name);
    }
    // The owners directory knows people even when they own nothing right now.
    for (const dir of Object.values(inv.owners)) {
      if (dir.name.trim()) set.add(dir.name);
    }
    return mergeSuggestions('owner', [...set].sort((a, b) => a.localeCompare(b)));
  }, [allItems, inv.owners]);

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const candidate of allItems) if (candidate.category) set.add(candidate.category);
    return mergeSuggestions('category', [...set].sort((a, b) => a.localeCompare(b)));
  }, [allItems]);

  const countryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const candidate of allItems) {
      if (candidate.countryOfOrigin) set.add(candidate.countryOfOrigin);
    }
    return countryComboOptions(
      mergeSuggestions('country', [...set].sort((a, b) => a.localeCompare(b))),
    );
  }, [allItems]);

  const vendorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const candidate of allItems) {
      if (candidate.purchase?.vendor) set.add(candidate.purchase.vendor);
    }
    return mergeSuggestions('vendor', [...set].sort((a, b) => a.localeCompare(b)));
  }, [allItems]);

  const item: Item | undefined = allItems.find((candidate) => candidate.id === itemId);
  const boxes: Box[] = inv.boxes ?? [];
  const readonly = Boolean(inv.readonly);
  const mainCurrency = inv.meta?.currency ?? 'USD';
  const entryCurrency = getLastCurrency() ?? mainCurrency;

  if (!inv.loaded) {
    return (
      <>
        <AppHeader title="Item" back={`/inv/${docId}`} />
        <main className="page narrow">
          <LoadingPage />
        </main>
      </>
    );
  }

  if (!item) {
    // A move deletes the item here the moment the copy landed in the target;
    // the redirect follows on the next tick, so this is not "gone".
    if (moving) {
      return (
        <>
          <AppHeader title="Item" back={`/inv/${docId}`} />
          <main className="page narrow">
            <LoadingPage label="Moving item" />
          </main>
        </>
      );
    }
    // An item share link can be opened before the document has synced; only
    // call the item missing once something of the inventory has arrived.
    const stillArriving = !inv.meta && inv.syncStatus === 'connecting';
    return (
      <>
        <AppHeader title="Item" back={`/inv/${docId}`} status={inv.syncStatus} />
        <main className="page narrow">
          {stillArriving ? (
            <SyncingState body="This item is still downloading from the sync server." />
          ) : (
            <EmptyState
              title="Item not found"
              body="It may have been deleted, or this device has not synced it yet."
              action={
                <Link className="btn primary" to={`/inv/${docId}`}>
                  Back to inventory
                </Link>
              }
            />
          )}
        </main>
      </>
    );
  }

  const sheet: Item = item;
  const patch = (values: ItemPatch) => inv.updateItem(sheet.id, values);

  /** Clearing the last purchase field drops the record instead of leaving {}. */
  const patchPurchase = (values: NonNullable<Item['purchase']>) => {
    const merged = { ...sheet.purchase, ...values };
    const empty = !merged.date && !merged.price && !merged.vendor;
    patch({ purchase: empty ? undefined : merged });
  };

  /** Local convenience stores only; a failure here must never surface. */
  const remember = (key: string, value: string | undefined) => {
    const clean = (value ?? '').trim();
    if (clean === '') return;
    try {
      rememberInput(key, clean);
    } catch {
      /* history is optional */
    }
  };

  const rememberCurrencyOf = (value: MoneyValue | undefined) => {
    const code = (value?.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return;
    try {
      setLastCurrency(code);
      rememberInput('currency', code);
    } catch {
      /* history is optional */
    }
  };

  const commitLocation = (entry: LocationEntry) => {
    inv.addLocation(sheet.id, entry);
    if (entry.label && typeof entry.lat === 'number' && typeof entry.lon === 'number') {
      try {
        rememberPlace(entry.label, entry.lat, entry.lon);
      } catch {
        /* place memory is optional */
      }
    }
    setLocationDraft('');
    setLocationPick(null);
    toast('Location updated');
  };

  /**
   * The capture is on screen in the same tick the file arrives, straight from
   * the raw blob; downscaling, encrypting and storing it runs behind that
   * tile, which is swapped for the stored photo when it lands.
   */
  const addPhotos = (files: File[], role: PhotoRole) => {
    const queued = files.map((file, index) => ({
      key: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      url: URL.createObjectURL(file),
      role,
      file,
    }));
    setPendingPhotos((prev) => [...prev, ...queued.map(({ file: _f, ...preview }) => preview)]);

    void (async () => {
      for (const entry of queued) {
        try {
          await inv.addPhoto(sheet.id, entry.file, role);
        } catch (err) {
          toastError(err instanceof Error ? err.message : 'Photo could not be saved');
        } finally {
          setPendingPhotos((prev) => prev.filter((p) => p.key !== entry.key));
          URL.revokeObjectURL(entry.url);
        }
      }
    })();
  };

  const runAutofill = async () => {
    const candidates = [...(sheet.photos ?? [])]
      .sort((a, b) => a.addedAt - b.addedAt)
      .slice(0, 3);
    if (aiBusy || candidates.length === 0) return;
    setAiBusy(true);
    try {
      const blobs: Blob[] = [];
      for (const photo of candidates) {
        const blob = await getPhotoBlob(docId, photo.hash);
        if (blob) blobs.push(blob);
      }
      if (blobs.length === 0) {
        toastError('The photos have not been downloaded to this device yet');
        return;
      }
      const suggestions = await analyzeItemPhotos(docId, blobs, {
        description: sheet.description || undefined,
        mainCurrency,
      });
      setAiSuggestions(suggestions);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Autofill is not available right now');
    } finally {
      setAiBusy(false);
    }
  };

  /** Only empty fields are checked by default; see AiReviewModal. */
  const aiFieldFilled = (key: AiFieldKey): boolean => {
    switch (key) {
      case 'description':
        return (sheet.description ?? '').trim() !== '';
      case 'category':
        return (sheet.category ?? '').trim() !== '';
      case 'tags':
        return (sheet.tags ?? []).length > 0;
      case 'brandModel':
        return (sheet.brandModel ?? '').trim() !== '';
      case 'valueCurrent':
        return sheet.valueCurrent !== undefined;
      case 'valueNew':
        return sheet.valueNew !== undefined;
      case 'weightGrams':
        return typeof sheet.weight?.exactGrams === 'number';
      case 'dimensionsMm':
        return Boolean(sheet.dimensions?.exactMm);
      case 'lithiumBattery':
        return sheet.lithiumBattery !== undefined;
      case 'countryOfOrigin':
        return (sheet.countryOfOrigin ?? '').trim() !== '';
      case 'hsCode':
        return (sheet.hsCode ?? '').trim() !== '';
      case 'condition':
        return (sheet.condition ?? '').trim() !== '';
      case 'translations':
        return Object.keys(sheet.translations ?? {}).length > 0;
    }
  };

  const applyAi = (suggestions: AiSuggestions, keys: Set<AiFieldKey>) => {
    const next: ItemPatch = {};

    if (keys.has('description') && suggestions.description) {
      next.description = suggestions.description.trim();
    }
    if (keys.has('category') && suggestions.category) next.category = suggestions.category.trim();
    if (keys.has('tags') && suggestions.tags) next.tags = parseTags(suggestions.tags.join(', '));
    if (keys.has('brandModel') && suggestions.brandModel) {
      next.brandModel = suggestions.brandModel.trim();
    }
    if (keys.has('valueCurrent') && suggestions.valueCurrent) {
      next.valueCurrent = suggestions.valueCurrent;
    }
    if (keys.has('valueNew') && suggestions.valueNew) next.valueNew = suggestions.valueNew;
    if (keys.has('weightGrams') && typeof suggestions.weightGrams === 'number') {
      const grams = Math.round(suggestions.weightGrams);
      if (grams > 0) next.weight = { class: weightClassForGrams(grams), exactGrams: grams };
    }
    if (keys.has('dimensionsMm') && suggestions.dimensionsMm) {
      const mm = suggestions.dimensionsMm;
      if (mm.l > 0 && mm.w > 0 && mm.h > 0) {
        next.dimensions = { class: sizeClassForMm(mm), exactMm: mm };
      }
    }
    if (keys.has('lithiumBattery') && typeof suggestions.lithiumBattery === 'boolean') {
      next.lithiumBattery = suggestions.lithiumBattery || undefined;
    }
    if (keys.has('countryOfOrigin') && suggestions.countryOfOrigin) {
      next.countryOfOrigin = suggestions.countryOfOrigin.trim();
    }
    if (keys.has('hsCode') && suggestions.hsCode) next.hsCode = suggestions.hsCode.trim();
    if (keys.has('condition') && suggestions.condition) next.condition = suggestions.condition.trim();
    if (keys.has('translations') && suggestions.translations) {
      next.translations = { ...(sheet.translations ?? {}), ...suggestions.translations };
    }

    setAiSuggestions(null);
    if (Object.keys(next).length === 0) return;
    patch(next);
    rememberCurrencyOf(next.valueCurrent ?? next.valueNew);
    remember('category', next.category);
    remember('country', next.countryOfOrigin);
    toast(`Applied ${keys.size} suggestion${keys.size === 1 ? '' : 's'}`);
  };

  const locations: LocationEntry[] = sheet.locationHistory ?? [];
  const currentLocationEntry = locations.length > 0 ? locations[locations.length - 1] : undefined;
  const owners = sheet.ownerHistory ?? [];
  const lastOwnerEntry = owners.length > 0 ? owners[owners.length - 1] : undefined;
  // ownerId -> owners-directory current name -> stored fallback string.
  const currentOwnerName = lastOwnerEntry
    ? ownerDisplayName(inv.owners, lastOwnerEntry) || undefined
    : undefined;
  const ownerTracking = Boolean(inv.meta?.ownerTrackingEnabled);
  const ownerDisabled = Boolean(sheet.ownerDisabled);
  const hasPhotos = (sheet.photos ?? []).length > 0;

  return (
    <>
      <AppHeader
        title={sheet.description || 'Untitled item'}
        subtitle={inv.meta?.name}
        back={`/inv/${docId}`}
        status={inv.syncStatus}
        actions={
          <button type="button" className="btn ghost sm" onClick={() => setSharing(true)}>
            Share
          </button>
        }
      />

      <main className="page narrow">
        <div className="stack loose">
          <section className="stack tight">
            <SectionTitle>Photos</SectionTitle>
            <PhotoGallery
              docId={docId}
              photos={sheet.photos ?? []}
              pending={pendingPhotos}
              readonly={readonly}
              onAdd={addPhotos}
              onRemove={(hash) => inv.removePhoto(sheet.id, hash)}
            />
            {!readonly && hasPhotos ? (
              <div className="ai-bar">
                <button
                  type="button"
                  className="btn sm"
                  disabled={aiBusy}
                  onClick={() => void runAutofill()}
                >
                  {aiBusy ? 'Reading the photos' : 'Autofill from photos (AI)'}
                </button>
                <span className="tiny faint">
                  Sends up to 3 photos. Optional, and only works online.
                </span>
              </div>
            ) : null}
          </section>

          <section className="card stack">
            <InlineText
              label="Description"
              value={sheet.description}
              multiline
              readonly={readonly}
              onCommit={(value) => patch({ description: value })}
            />

            {readonly ? (
              <Field label="Quantity">
                <p>{sheet.quantity}</p>
              </Field>
            ) : (
              <div className="row between">
                <span className="label">Quantity</span>
                <Stepper
                  value={sheet.quantity || 1}
                  onChange={(value) => patch({ quantity: value })}
                />
              </div>
            )}
            <MultiUnitHint item={sheet} />

            <InlineMoney
              label="Value now"
              value={sheet.valueCurrent}
              defaultCurrency={entryCurrency}
              mainCurrency={mainCurrency}
              readonly={readonly}
              onCommit={(value) => {
                rememberCurrencyOf(value);
                patch({ valueCurrent: value });
              }}
            />
            <InlineMoney
              label="Value when new"
              value={sheet.valueNew}
              defaultCurrency={entryCurrency}
              mainCurrency={mainCurrency}
              readonly={readonly}
              onCommit={(value) => {
                rememberCurrencyOf(value);
                patch({ valueNew: value });
              }}
            />
            {readonly ? (
              <InlineText label="Category" value={sheet.category} readonly onCommit={() => {}} />
            ) : (
              <Field label="Category">
                <SmartCombo
                  value={sheet.category ?? ''}
                  options={categoryOptions.map((name) => ({ value: name, label: name }))}
                  ariaLabel="Category"
                  onCommit={(value) => {
                    remember('category', value);
                    patch({ category: value || undefined });
                  }}
                />
              </Field>
            )}
            <InlineText
              label="Tags"
              hint="Comma separated"
              value={(sheet.tags ?? []).join(', ')}
              readonly={readonly}
              onCommit={(value) => patch({ tags: parseTags(value) })}
            />
          </section>

          <section className="card stack tight">
            <SectionTitle>Weight</SectionTitle>
            {readonly ? (
              <p>{weightLabel(sheet.weight)}</p>
            ) : (
              <WeightPicker
                value={sheet.weight ?? null}
                onChange={(weight) => weight && patch({ weight })}
              />
            )}
          </section>

          <section className="card stack tight">
            <SectionTitle>Size</SectionTitle>
            {readonly ? (
              <p>{sizeLabel(sheet.dimensions)}</p>
            ) : (
              <SizePicker
                value={sheet.dimensions ?? null}
                onChange={(dimensions) => dimensions && patch({ dimensions })}
              />
            )}
          </section>

          <section className="card stack tight">
            <SectionTitle>Location</SectionTitle>
            <p>{locationText(currentLocationEntry)}</p>
            {currentLocationEntry ? (
              <p className="tiny faint">Recorded {formatDateTime(currentLocationEntry.time)}</p>
            ) : null}

            {!readonly ? (
              <>
                <PlaceInput
                  label="Place for the next update"
                  hint="Type to search for a place, or write anything. Free text is fine."
                  value={locationDraft}
                  placeholder="Warehouse, Rotterdam"
                  onChange={(value) => {
                    setLocationDraft(value);
                    setLocationPick(null);
                  }}
                  onPick={(hit) => {
                    setLocationDraft(hit.label);
                    setLocationPick({ lat: hit.lat, lon: hit.lon });
                  }}
                />
                {locationPick ? (
                  <span className="chip accent">Coordinates from the picked place</span>
                ) : null}
                <div className="row wrap">
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      const entry = await getLocationWithPlace();
                      if (!entry) {
                        toastError('No position available');
                        return;
                      }
                      const label = locationDraft.trim() || (entry.label ?? '').trim();
                      commitLocation({
                        time: entry.time,
                        lat: entry.lat,
                        lon: entry.lon,
                        label: label || undefined,
                      });
                    }}
                  >
                    Update to my GPS position
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!locationDraft.trim()}
                    onClick={() => {
                      const entry: LocationEntry = {
                        time: Date.now(),
                        label: locationDraft.trim(),
                      };
                      if (locationPick) {
                        entry.lat = locationPick.lat;
                        entry.lon = locationPick.lon;
                      }
                      commitLocation(entry);
                    }}
                  >
                    {locationPick ? 'Save this place' : 'Save label only'}
                  </button>
                </div>
              </>
            ) : null}

            {locations.length > 1 ? (
              <details className="disclosure" style={{ marginTop: 8 }}>
                <summary>Location history ({locations.length})</summary>
                <div className="disclosure-body">
                  <ul className="timeline">
                    {[...locations].reverse().map((entry, index) => (
                      <li key={`${entry.time}-${index}`}>
                        <span className="when">{formatDateTime(entry.time)}</span>
                        <span className="grow">{locationText(entry)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            ) : null}
          </section>

          {ownerTracking && ownerDisabled ? (
            <section className="card stack tight">
              <div className="owner-inline">
                <SectionTitle>Owner</SectionTitle>
                {!readonly ? (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      patch({ ownerDisabled: false });
                      toast('Owner tracking on for this item');
                    }}
                  >
                    Track owner
                  </button>
                ) : null}
              </div>
              <p className="small muted">Owner tracking is off for this item.</p>
            </section>
          ) : null}

          {ownerTracking && !ownerDisabled ? (
            <section className="card stack tight">
              <div className="owner-inline">
                <SectionTitle>Owner</SectionTitle>
                {!readonly ? (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => {
                      patch({ ownerDisabled: true });
                      toast('Owner tracking off for this item');
                    }}
                  >
                    Stop tracking
                  </button>
                ) : null}
              </div>
              <p>{currentOwnerName ?? 'Not assigned'}</p>

              {!readonly ? (
                <div className="row">
                  <input
                    className="input grow"
                    list="sheet-owners"
                    value={ownerDraft}
                    placeholder="Transfer to"
                    onChange={(e) => setOwnerDraft(e.target.value)}
                  />
                  <datalist id="sheet-owners">
                    {ownerOptions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="btn"
                    disabled={!ownerDraft.trim()}
                    onClick={() => {
                      const name = ownerDraft.trim();
                      inv.setOwner(sheet.id, name);
                      remember('owner', name);
                      setOwnerDraft('');
                      toast('Owner updated');
                    }}
                  >
                    Transfer
                  </button>
                </div>
              ) : null}

              {owners.length > 0 ? (
                <details className="disclosure" style={{ marginTop: 8 }}>
                  <summary>Owner history ({owners.length})</summary>
                  <div className="disclosure-body">
                    <ul className="timeline">
                      {[...owners].reverse().map((entry, index) => (
                        <li key={`${entry.time}-${index}`}>
                          <span className="when">{formatDateTime(entry.time)}</span>
                          <span className="grow">{ownerDisplayName(inv.owners, entry)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              ) : null}
            </section>
          ) : null}

          <details className="disclosure" open>
            <summary>Customs details</summary>
            <div className="disclosure-body">
              <div className="serial-row">
                <InlineText
                  label="Serial number"
                  value={sheet.serialNumber}
                  readonly={readonly}
                  onCommit={(value) => patch({ serialNumber: value || undefined })}
                />
                {!readonly ? (
                  <button type="button" className="btn ghost sm" onClick={() => setScanOpen(true)}>
                    Scan
                  </button>
                ) : null}
              </div>
              <InlineText
                label="Purchase date"
                type="date"
                value={sheet.purchase?.date}
                readonly={readonly}
                onCommit={(value) => patchPurchase({ date: value || undefined })}
              />
              <InlineMoney
                label="Purchase price"
                value={sheet.purchase?.price}
                defaultCurrency={entryCurrency}
                mainCurrency={mainCurrency}
                readonly={readonly}
                onCommit={(value) => {
                  rememberCurrencyOf(value);
                  patchPurchase({ price: value });
                }}
              />
              <InlineText
                label="Vendor"
                value={sheet.purchase?.vendor}
                readonly={readonly}
                listId="sheet-vendors"
                onCommit={(value) => {
                  remember('vendor', value);
                  patchPurchase({ vendor: value || undefined });
                }}
              />
              <datalist id="sheet-vendors">
                {vendorOptions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <InlineSelect
                label="Box"
                value={sheet.boxId}
                readonly={readonly}
                placeholder="No box"
                options={boxes.map((box) => ({ value: box.id, label: box.label }))}
                onCommit={(value) => patch({ boxId: value || undefined })}
              />
              <InlineText
                label="Condition"
                value={sheet.condition}
                readonly={readonly}
                onCommit={(value) => patch({ condition: value || undefined })}
              />
              {readonly ? (
                <Field label="Lithium battery">
                  <p>{sheet.lithiumBattery ? 'Yes' : 'No'}</p>
                </Field>
              ) : (
                <Toggle
                  label="Contains a lithium battery"
                  checked={Boolean(sheet.lithiumBattery)}
                  onChange={(checked) => patch({ lithiumBattery: checked || undefined })}
                />
              )}
              {readonly ? (
                <InlineText
                  label="Country of origin"
                  value={sheet.countryOfOrigin}
                  readonly
                  onCommit={() => {}}
                />
              ) : (
                <Field label="Country of origin">
                  <SmartCombo
                    value={sheet.countryOfOrigin ?? ''}
                    options={countryOptions}
                    ariaLabel="Country of origin"
                    onCommit={(value) => {
                      remember('country', value);
                      patch({ countryOfOrigin: value || undefined });
                    }}
                  />
                </Field>
              )}
              <InlineSelect
                label="Acquisition"
                value={sheet.acquisition}
                readonly={readonly}
                placeholder="Not stated"
                options={[
                  { value: 'new', label: 'Bought new' },
                  { value: 'used', label: 'Bought used' },
                  { value: 'gift', label: 'Gift' },
                ]}
                onCommit={(value) =>
                  patch({ acquisition: (value || undefined) as AcquisitionMethod | undefined })
                }
              />
              <InlineText
                label="HS code"
                value={sheet.hsCode}
                readonly={readonly}
                onCommit={(value) => patch({ hsCode: value || undefined })}
              />
              <InlineText
                label="Brand and model"
                value={sheet.brandModel}
                readonly={readonly}
                onCommit={(value) => patch({ brandModel: value || undefined })}
              />
              <InlineText
                label="Notes"
                value={sheet.notes}
                multiline
                readonly={readonly}
                onCommit={(value) => patch({ notes: value || undefined })}
              />
              {Object.keys(sheet.translations ?? {}).length > 0 ? (
                <Field label="Translations">
                  <div className="stack tight">
                    {Object.entries(sheet.translations ?? {}).map(([lang, text]) => (
                      <p key={lang} className="small">
                        <span className="muted">{lang}: </span>
                        {text}
                      </p>
                    ))}
                  </div>
                </Field>
              ) : null}
            </div>
          </details>

          <p className="tiny faint">
            Added {formatDateTime(sheet.createdAt)} · Updated {formatDateTime(sheet.updatedAt)}
          </p>

          <button type="button" className="btn" onClick={() => setSelling(true)}>
            Sell / export listing
          </button>

          {!readonly ? (
            <button type="button" className="btn" onClick={() => setMoving(true)}>
              Move to another inventory…
            </button>
          ) : null}

          {!readonly ? (
            <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
              Delete item
            </button>
          ) : null}
        </div>
      </main>

      {aiSuggestions ? (
        <AiReviewModal
          suggestions={aiSuggestions}
          isFilled={aiFieldFilled}
          onApply={(keys) => applyAi(aiSuggestions, keys)}
          onClose={() => setAiSuggestions(null)}
        />
      ) : null}

      {scanOpen ? (
        <Modal title="Scan serial number" onClose={() => setScanOpen(false)}>
          <OcrScanner
            match={matchSerial}
            onResult={(text) => {
              patch({ serialNumber: text });
              setScanOpen(false);
              toast('Serial captured');
            }}
          />
        </Modal>
      ) : null}

      {selling ? (
        <SellModal
          docId={docId}
          item={sheet}
          mainCurrency={mainCurrency}
          onClose={() => setSelling(false)}
        />
      ) : null}

      {moving ? (
        <MoveItemModal
          docId={docId}
          itemId={sheet.id}
          onClose={() => setMoving(false)}
          onMoved={(target, result) => {
            setMoving(false);
            const notes = result.boxDropped ? ' — the box assignment did not carry over' : '';
            toast(`Moved to ${target.name}${notes}`);
            if (result.photosDropped > 0) {
              toastError(
                `${result.photosMoved} of ${result.photosTotal} photos moved — the ${
                  result.photosDropped === 1 ? 'missing one was' : 'missing ones were'
                } never downloaded on this device`,
              );
            }
            navigate(`/inv/${target.docId}/i/${result.itemId}`, { replace: true });
          }}
        />
      ) : null}

      {sharing ? (
        <ShareModal
          docId={docId}
          target={{ kind: 'item', itemId: sheet.id }}
          title="Share item"
          onClose={() => setSharing(false)}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmModal
          title="Delete item"
          body="This removes the item from the inventory on every synced device."
          confirmLabel="Delete"
          destructive
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            inv.deleteItem(sheet.id);
            toast('Item deleted');
            navigate(`/inv/${docId}`, { replace: true });
          }}
        />
      ) : null}
    </>
  );
}
