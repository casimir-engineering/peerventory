import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  analyzeItemPhotos,
  effectiveOwnerName,
  getLastCurrency,
  rememberInput,
  rememberPlace,
  setLastCurrency,
  suggestInputs,
} from '../../services';
import type { AiSuggestions } from '../../services';
import { useInventory } from '../../store';
import type { ItemDraft, ItemPatch, UseInventoryResult } from '../../store/contract';
import type {
  AcquisitionMethod,
  Box,
  Dimensions,
  Id,
  Item,
  LocationEntry,
  MoneyValue,
  PhotoRole,
  Weight,
} from '../../types';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, LoadingPage } from '../components/Common';
import {
  SizePicker,
  WeightPicker,
  sizeClassForMm,
  weightClassForGrams,
} from '../components/ClassPickers';
import {
  AiReviewModal,
  Field,
  MoneyInput,
  PlaceInput,
  Stepper,
  Toggle,
  parseAmountInput,
} from '../components/Fields';
import type { AiFieldKey } from '../components/Fields';
import { ConfirmModal, Modal } from '../components/Modal';
import { SmartCombo } from '../components/SmartCombo';
import { OcrScanner } from '../components/OcrScanner';
import { PhotoAddSplit, PhotoAddTiles, PhotoPickerButton, ROLE_LABEL } from '../components/Photos';
import { useToast } from '../components/Toast';
import { TwoStepDeleteButton } from '../components/TwoStepDelete';
import { countryComboOptions } from '../lib/countries';
import { formatCoords, parseTags } from '../lib/format';
import { matchSerial } from '../lib/serial';
import { getLocationWithPlace } from '../lib/geo';
import { downscaleImage } from '../lib/image';
import { registerNavigationGuard } from '../lib/navGuard';
import '../entry.css';

interface PendingPhoto {
  key: string;
  blob: Blob;
  url: string;
  role: PhotoRole;
}

/** Prefilled for new items; the user can change or clear it before saving. */
const DEFAULT_CONDITION = 'Used - good condition';

const CONDITION_PRESETS = [
  'New (sealed)',
  'Like new',
  'Used - very good condition',
  DEFAULT_CONDITION,
  'Used - acceptable',
  'For parts / not working',
];

/** Ids of the collapsible optional sections, as stored in meta.fieldPrefs. */
const SECTION_CATEGORY_TAGS = 'categoryTags';
const SECTION_CUSTOMS = 'customs';

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
 * Single-screen capture flow. Everything above "Customs details" is what gets
 * filled while holding a phone in one hand; the rest can wait until the desk.
 */
export function NewItemPage() {
  const { docId = '' } = useParams();
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const inv: UseInventoryResult = useInventory(docId || null);

  const items: Item[] = inv.items ?? [];
  const boxes: Box[] = inv.boxes ?? [];
  const ownerTracking = Boolean(inv.meta?.ownerTrackingEnabled);
  const metaCurrency = inv.meta?.currency ?? 'USD';

  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [currency, setCurrency] = useState(() => getLastCurrency() ?? metaCurrency);
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [valueCurrent, setValueCurrent] = useState('');
  const [valueNew, setValueNew] = useState('');
  const [weight, setWeight] = useState<Weight | null>(null);
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [location, setLocation] = useState<LocationEntry | null>(null);
  const [locationSource, setLocationSource] = useState<'gps' | 'place' | null>(null);
  const [locationLabel, setLocationLabel] = useState('');
  const [owner, setOwner] = useState(() => effectiveOwnerName(docId) ?? '');
  const [ownerDisabled, setOwnerDisabled] = useState(false);

  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [vendor, setVendor] = useState('');
  const [boxId, setBoxId] = useState('');
  const [condition, setCondition] = useState(DEFAULT_CONDITION);
  const [lithiumBattery, setLithiumBattery] = useState(false);
  const [countryOfOrigin, setCountryOfOrigin] = useState('');
  const [acquisition, setAcquisition] = useState<'' | AcquisitionMethod>('');
  const [notes, setNotes] = useState('');
  // Not part of ItemDraft, so these are written with a patch right after create.
  const [brandModel, setBrandModel] = useState('');
  const [hsCode, setHsCode] = useState('');
  const [translations, setTranslations] = useState<Record<string, string> | null>(null);

  const [newBoxOpen, setNewBoxOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestions | null>(null);

  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const focusedOnce = useRef(false);
  const photosRef = useRef<PendingPhoto[]>([]);
  photosRef.current = photos;
  // A ref, not the state flag: two taps can land before React re-renders the
  // disabled button, and each one would otherwise create its own item.
  const savingRef = useRef(false);

  // Pending navigation waiting on the "Discard this item?" confirm; null when
  // the dialog is closed. Stores the action so back-link, Android back and
  // future exits all share one dialog.
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);

  // "Save and add another" deliberately keeps some fields (box, location,
  // category, country, acquisition, owner) for the next item. Those count as
  // dirty only when they differ from this baseline, so a save leaves the form
  // clean even though the sticky fields still hold values.
  const stickyBaseline = useRef({
    category: '',
    countryOfOrigin: '',
    acquisition: '' as '' | AcquisitionMethod,
    boxId: '',
    locationLabel: '',
    owner: owner.trim(),
    ownerDisabled: false,
  });

  const dirty =
    photos.length > 0 ||
    description.trim() !== '' ||
    quantity !== 1 ||
    valueCurrent.trim() !== '' ||
    valueNew.trim() !== '' ||
    weight !== null ||
    dimensions !== null ||
    tags.trim() !== '' ||
    serialNumber.trim() !== '' ||
    purchaseDate !== '' ||
    purchasePrice.trim() !== '' ||
    vendor.trim() !== '' ||
    // Prefilled default: neither the untouched default nor clearing it should
    // trip the "Discard this item?" guard on its own.
    (condition.trim() !== '' && condition.trim() !== DEFAULT_CONDITION) ||
    lithiumBattery ||
    notes.trim() !== '' ||
    brandModel.trim() !== '' ||
    hsCode.trim() !== '' ||
    translations !== null ||
    category.trim() !== stickyBaseline.current.category ||
    countryOfOrigin.trim() !== stickyBaseline.current.countryOfOrigin ||
    acquisition !== stickyBaseline.current.acquisition ||
    boxId !== stickyBaseline.current.boxId ||
    locationLabel.trim() !== stickyBaseline.current.locationLabel ||
    owner.trim() !== stickyBaseline.current.owner ||
    ownerDisabled !== stickyBaseline.current.ownerDisabled;

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Android system back: claim the action while dirty and ask first
  // (main.tsx runs this guard before walking history).
  useEffect(
    () =>
      registerNavigationGuard(() => {
        if (!dirtyRef.current || savingRef.current) return false;
        setLeaveAction(() => () => window.history.back());
        return true;
      }),
    [],
  );

  // Tab close / refresh on the web while dirty.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Which optional sections start expanded: exactly the ones ever filled in
  // this inventory (meta.fieldPrefs, synced). Captured once when the meta is
  // available so later meta updates don't force a <details> the user closed.
  const initialExpanded = useRef<Set<string> | null>(null);
  if (inv.loaded && initialExpanded.current === null) {
    initialExpanded.current = new Set(inv.meta?.fieldPrefs?.expanded ?? []);
  }

  // Ask for a fix as soon as the screen opens: by the time the photo and the
  // description are in, the coordinates are usually already there.
  useEffect(() => {
    let cancelled = false;
    void getLocationWithPlace().then((entry) => {
      if (cancelled || !entry) return;
      setLocation({ time: entry.time, lat: entry.lat, lon: entry.lon });
      setLocationSource('gps');
      const nearby = entry.label;
      // Auto-filled, not user-entered: move the dirty baseline along with it.
      if (nearby) {
        setLocationLabel((prev) => {
          if (prev.trim() !== '') return prev;
          stickyBaseline.current.locationLabel = nearby.trim();
          return nearby;
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currencyTouched) setCurrency(getLastCurrency() ?? metaCurrency);
  }, [metaCurrency, currencyTouched]);

  useEffect(() => {
    if (photos.length > 0 && !focusedOnce.current) {
      focusedOnce.current = true;
      descRef.current?.focus();
    }
  }, [photos.length]);

  useEffect(
    () => () => {
      for (const photo of photosRef.current) URL.revokeObjectURL(photo.url);
    },
    [],
  );

  const knownOwners = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      const last = item.ownerHistory?.[item.ownerHistory.length - 1]?.owner;
      if (last) set.add(last);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const knownCategories = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) if (item.category) set.add(item.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const knownCountries = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) if (item.countryOfOrigin) set.add(item.countryOfOrigin);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const knownVendors = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) if (item.purchase?.vendor) set.add(item.purchase.vendor);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const ownerOptions = useMemo(() => mergeSuggestions('owner', knownOwners), [knownOwners]);
  const categoryOptions = useMemo(
    () => mergeSuggestions('category', knownCategories),
    [knownCategories],
  );
  const countryOptions = useMemo(
    () => countryComboOptions(mergeSuggestions('country', knownCountries)),
    [knownCountries],
  );
  const vendorOptions = useMemo(() => mergeSuggestions('vendor', knownVendors), [knownVendors]);
  const categoryComboOptions = useMemo(
    () => categoryOptions.map((name) => ({ value: name, label: name })),
    [categoryOptions],
  );

  const conditionOptions = useMemo(() => {
    const out = [...CONDITION_PRESETS];
    for (const item of items) {
      const value = item.condition?.trim();
      if (value && !out.includes(value)) out.push(value);
    }
    return out.map((name) => ({ value: name, label: name }));
  }, [items]);

  /**
   * The raw capture is shown immediately — decoding it for display is the
   * browser's problem, and it is much better at it than we are. The downscale
   * runs behind that, and only swaps the blob the save will store.
   */
  const addPhotos = (files: File[], role: PhotoRole) => {
    const added: PendingPhoto[] = files.map((file, index) => ({
      key: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      blob: file,
      url: URL.createObjectURL(file),
      role,
    }));
    setPhotos((prev) => [...prev, ...added]);

    for (const photo of added) {
      void downscaleImage(photo.blob)
        .then((blob) => {
          // The preview keeps pointing at the raw capture (already painted,
          // and revoking it under a live <img> buys nothing); only the bytes
          // the save will store are swapped.
          if (blob !== photo.blob) {
            setPhotos((prev) => prev.map((p) => (p.key === photo.key ? { ...p, blob } : p)));
          }
        })
        .catch(() => toastError('That photo could not be read'));
    }
  };

  const removePhoto = (key: string) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((p) => p.key !== key);
    });
  };

  /** Blank, unparseable or negative input stores no value at all. */
  const money = (raw: string): MoneyValue | undefined => {
    const parsed = parseAmountInput(raw);
    if (parsed.value === null) return undefined;
    return { amount: parsed.value, currency: (parsed.currency ?? currency ?? metaCurrency).toUpperCase() };
  };

  const setValueField = (setter: (value: string) => void) => (amount: string, cur: string) => {
    setter(amount);
    if (cur !== currency) {
      setCurrency(cur);
      setCurrencyTouched(true);
    }
  };

  const runAutofill = async () => {
    if (aiBusy || photos.length === 0) return;
    setAiBusy(true);
    try {
      const blobs = photos.slice(0, 3).map((photo) => photo.blob);
      const suggestions = await analyzeItemPhotos(docId, blobs, {
        description: description.trim() || undefined,
        mainCurrency: metaCurrency,
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
        return description.trim() !== '';
      case 'category':
        return category.trim() !== '';
      case 'tags':
        return tags.trim() !== '';
      case 'brandModel':
        return brandModel.trim() !== '';
      case 'valueCurrent':
        return valueCurrent.trim() !== '';
      case 'valueNew':
        return valueNew.trim() !== '';
      case 'weightGrams':
        return typeof weight?.exactGrams === 'number';
      case 'dimensionsMm':
        return Boolean(dimensions?.exactMm);
      case 'lithiumBattery':
        return lithiumBattery;
      case 'countryOfOrigin':
        return countryOfOrigin.trim() !== '';
      case 'hsCode':
        return hsCode.trim() !== '';
      case 'condition':
        return condition.trim() !== '';
      case 'translations':
        return translations !== null;
    }
  };

  const applyAi = (suggestions: AiSuggestions, keys: Set<AiFieldKey>) => {
    const takeMoney = (value: MoneyValue | undefined, setter: (amount: string) => void) => {
      if (!value || !Number.isFinite(value.amount)) return;
      setter(String(value.amount));
      const code = (value.currency ?? '').trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(code) && code !== currency) {
        setCurrency(code);
        setCurrencyTouched(true);
      }
    };

    if (keys.has('description') && suggestions.description) {
      setDescription(suggestions.description.trim());
    }
    if (keys.has('category') && suggestions.category) setCategory(suggestions.category.trim());
    if (keys.has('tags') && suggestions.tags) setTags(suggestions.tags.join(', '));
    if (keys.has('brandModel') && suggestions.brandModel) {
      setBrandModel(suggestions.brandModel.trim());
    }
    if (keys.has('valueCurrent')) takeMoney(suggestions.valueCurrent, setValueCurrent);
    if (keys.has('valueNew')) takeMoney(suggestions.valueNew, setValueNew);
    if (keys.has('weightGrams') && typeof suggestions.weightGrams === 'number') {
      const grams = Math.round(suggestions.weightGrams);
      if (grams > 0) setWeight({ class: weightClassForGrams(grams), exactGrams: grams });
    }
    if (keys.has('dimensionsMm') && suggestions.dimensionsMm) {
      const mm = suggestions.dimensionsMm;
      if (mm.l > 0 && mm.w > 0 && mm.h > 0) {
        setDimensions({ class: sizeClassForMm(mm), exactMm: mm });
      }
    }
    if (keys.has('lithiumBattery') && typeof suggestions.lithiumBattery === 'boolean') {
      setLithiumBattery(suggestions.lithiumBattery);
    }
    if (keys.has('countryOfOrigin') && suggestions.countryOfOrigin) {
      setCountryOfOrigin(suggestions.countryOfOrigin.trim());
    }
    if (keys.has('hsCode') && suggestions.hsCode) setHsCode(suggestions.hsCode.trim());
    if (keys.has('condition') && suggestions.condition) setCondition(suggestions.condition.trim());
    if (keys.has('translations') && suggestions.translations) {
      setTranslations({ ...(translations ?? {}), ...suggestions.translations });
    }

    setAiSuggestions(null);
    toast(`Applied ${keys.size} suggestion${keys.size === 1 ? '' : 's'}`);
  };

  const canSave = Boolean(description.trim()) && weight !== null && dimensions !== null;

  const resetForNext = () => {
    for (const photo of photosRef.current) URL.revokeObjectURL(photo.url);
    setPhotos([]);
    setDescription('');
    setQuantity(1);
    setValueCurrent('');
    setValueNew('');
    setWeight(null);
    setDimensions(null);
    setTags('');
    setSerialNumber('');
    setPurchaseDate('');
    setPurchasePrice('');
    setVendor('');
    setCondition(DEFAULT_CONDITION);
    setLithiumBattery(false);
    setNotes('');
    setBrandModel('');
    setHsCode('');
    setTranslations(null);
    // The kept fields become the new clean baseline for the dirty check.
    stickyBaseline.current = {
      category: category.trim(),
      countryOfOrigin: countryOfOrigin.trim(),
      acquisition,
      boxId,
      locationLabel: locationLabel.trim(),
      owner: owner.trim(),
      ownerDisabled,
    };
    focusedOnce.current = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    descRef.current?.focus();
  };

  /** Everything here is a local convenience store; a failure must not surface. */
  const rememberEntries = (place: LocationEntry | undefined, savedCurrency?: string) => {
    try {
      // Prefer the currency actually written to the item: an inline code like
      // "150 cny" is parsed at save time and may never reach the currency state.
      const code = (savedCurrency || currency || metaCurrency).toUpperCase();
      if (/^[A-Z]{3}$/.test(code)) {
        setLastCurrency(code);
        rememberInput('currency', code);
      }
      if (category.trim()) rememberInput('category', category.trim());
      if (countryOfOrigin.trim()) rememberInput('country', countryOfOrigin.trim());
      if (vendor.trim()) rememberInput('vendor', vendor.trim());
      if (ownerTracking && !ownerDisabled && owner.trim()) rememberInput('owner', owner.trim());
      if (place?.label && typeof place.lat === 'number' && typeof place.lon === 'number') {
        rememberPlace(place.label, place.lat, place.lon);
      }
    } catch {
      /* remembering is never worth a failed save */
    }
  };

  /**
   * Optional-field memory, synced: once a section's fields are actually used
   * in this inventory, it joins meta.fieldPrefs.expanded (union only, never
   * pruned) and every device pre-expands it on the next item creation.
   */
  const rememberFieldPrefs = (draft: ItemDraft) => {
    try {
      if (inv.readonly) return;
      const used: string[] = [];
      if (draft.category || (draft.tags?.length ?? 0) > 0) used.push(SECTION_CATEGORY_TAGS);
      if (
        draft.serialNumber ||
        draft.purchase ||
        draft.boxId ||
        // The untouched default doesn't mean the user works with conditions,
        // so it alone must not pre-expand the customs section everywhere.
        (draft.condition && draft.condition !== DEFAULT_CONDITION) ||
        draft.lithiumBattery ||
        draft.countryOfOrigin ||
        draft.acquisition ||
        draft.notes ||
        draft.brandModel ||
        draft.hsCode ||
        draft.translations
      ) {
        used.push(SECTION_CUSTOMS);
      }
      const prev = inv.meta?.fieldPrefs?.expanded ?? [];
      const added = used.filter((id) => !prev.includes(id));
      if (added.length > 0) inv.updateMeta({ fieldPrefs: { expanded: [...prev, ...added] } });
    } catch {
      /* prefs are never worth a failed save */
    }
  };

  const save = async (mode: 'again' | 'open') => {
    if (!canSave || savingRef.current || !weight || !dimensions) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const initialLocation: LocationEntry | undefined = location
        ? { ...location, label: locationLabel.trim() || undefined }
        : locationLabel.trim()
          ? { time: Date.now(), label: locationLabel.trim() }
          : undefined;

      const purchase = {
        date: purchaseDate || undefined,
        price: money(purchasePrice),
        vendor: vendor.trim() || undefined,
      };
      const hasPurchase = Boolean(purchase.date || purchase.price || purchase.vendor);
      const trackOwner = ownerTracking && !ownerDisabled;

      const draft: ItemDraft = {
        description: description.trim(),
        weight,
        dimensions,
        quantity,
        category: category.trim() || undefined,
        tags: parseTags(tags),
        valueCurrent: money(valueCurrent),
        valueNew: money(valueNew),
        initialLocation,
        initialOwner: trackOwner && owner.trim() ? owner.trim() : undefined,
        ownerDisabled: ownerDisabled || undefined,
        serialNumber: serialNumber.trim() || undefined,
        purchase: hasPurchase ? purchase : undefined,
        boxId: boxId || undefined,
        condition: condition.trim() || undefined,
        lithiumBattery: lithiumBattery || undefined,
        countryOfOrigin: countryOfOrigin.trim() || undefined,
        acquisition: acquisition || undefined,
        notes: notes.trim() || undefined,
        brandModel: brandModel.trim() || undefined,
        hsCode: hsCode.trim() || undefined,
        translations:
          translations && Object.keys(translations).length > 0 ? translations : undefined,
      };

      const itemId: Id = inv.createItem(draft);

      rememberEntries(initialLocation, draft.valueCurrent?.currency ?? draft.valueNew?.currency);
      rememberFieldPrefs(draft);

      // The item exists from here on, so a failing photo must not read as a
      // failed save: that would invite a second tap and a duplicate item.
      let photoFailures = 0;
      for (const photo of photosRef.current) {
        try {
          await inv.addPhoto(itemId, photo.blob, photo.role);
        } catch {
          photoFailures += 1;
        }
      }
      if (photoFailures > 0) {
        toastError(
          `Item saved, but ${photoFailures} photo${photoFailures === 1 ? '' : 's'} could not be attached.`,
        );
      }

      if (mode === 'open') {
        toast('Item saved');
        navigate(`/inv/${docId}/i/${itemId}`, { replace: true });
      } else {
        resetForNext();
        toast('Item saved. Box and location kept for the next one.');
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Could not save the item');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (!inv.loaded) {
    return (
      <>
        <AppHeader title="New item" back={`/inv/${docId}`} />
        <main className="page narrow">
          <LoadingPage />
        </main>
      </>
    );
  }

  if (inv.readonly) {
    return (
      <>
        <AppHeader title="New item" back={`/inv/${docId}`} />
        <main className="page narrow">
          <EmptyState
            title="View-only access"
            body="This share link does not allow adding items."
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

  const coords = location ? formatCoords(location.lat, location.lon) : null;

  return (
    <>
      {/* display:contents keeps the header's sticky layout while letting a
          capture-phase handler intercept the back button (the only <button>
          this header renders) without modifying AppHeader itself. */}
      <div
        style={{ display: 'contents' }}
        onClickCapture={(e) => {
          if (!(e.target as HTMLElement).closest('button[aria-label="Back"]')) return;
          if (!dirtyRef.current || savingRef.current) return;
          e.preventDefault();
          e.stopPropagation();
          setLeaveAction(() => () => navigate(`/inv/${docId}`));
        }}
      >
        <AppHeader
          title="New item"
          subtitle={inv.meta?.name}
          back={`/inv/${docId}`}
          status={inv.syncStatus}
        />
      </div>

      <main className="page narrow">
        <div className="stack loose">
          {/* 1. Photos */}
          <section className="stack tight">
            <span className="section-title">Photos</span>
            <div className="gallery">
              {photos.map((photo) => (
                <div className="gallery-item" key={photo.key}>
                  <img src={photo.url} alt="" className="gallery-photo" />
                  {photo.role !== 'photo' ? (
                    <span className="role-badge">{ROLE_LABEL[photo.role]}</span>
                  ) : null}
                  <TwoStepDeleteButton
                    className="remove"
                    label="Remove photo"
                    disabled={saving}
                    onDelete={() => removePhoto(photo.key)}
                  >
                    ✕
                  </TwoStepDeleteButton>
                </div>
              ))}
              <PhotoAddTiles
                onAdd={(files) => void addPhotos(files, 'photo')}
                disabled={saving}
              />
            </div>
            <div className="row wrap">
              <PhotoPickerButton
                className="btn sm"
                onFiles={(files) => void addPhotos(files, 'photo')}
                multiple
                disabled={saving}
              >
                Add from gallery
              </PhotoPickerButton>
              <PhotoAddSplit
                label="Serial label"
                role="serial_label"
                onFiles={(files) => void addPhotos(files, 'serial_label')}
                disabled={saving}
              />
              <PhotoAddSplit
                label="Receipt"
                role="receipt"
                onFiles={(files) => void addPhotos(files, 'receipt')}
                disabled={saving}
              />
            </div>

            {photos.length > 0 ? (
              <div className="ai-bar">
                <button
                  type="button"
                  className="btn sm"
                  disabled={aiBusy || saving}
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

          {/* 2. Description and quantity */}
          <section className="stack">
            <Field label="Description" hint="What a customs officer should read first.">
              <textarea
                ref={descRef}
                className="textarea"
                value={description}
                placeholder="Oscilloscope, 4-channel, used"
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            <div className="row between">
              <span className="label">Quantity</span>
              <Stepper value={quantity} onChange={setQuantity} />
            </div>

            <MoneyInput
              label="Value now"
              amount={valueCurrent}
              currency={currency}
              mainCurrency={metaCurrency}
              hint="An amount can carry its code: 150 cny"
              onChange={setValueField(setValueCurrent)}
            />
            <MoneyInput
              label="Value when new"
              amount={valueNew}
              currency={currency}
              mainCurrency={metaCurrency}
              onChange={setValueField(setValueNew)}
            />
          </section>

          {/* 3. Weight class (mandatory) */}
          <section className="stack tight">
            <span className="section-title">Weight (required)</span>
            <WeightPicker value={weight} onChange={setWeight} />
          </section>

          {/* 4. Size class (mandatory) */}
          <section className="stack tight">
            <span className="section-title">Size (required)</span>
            <SizePicker value={dimensions} onChange={setDimensions} />
          </section>

          {/* 5. Location */}
          <section className="stack tight">
            <span className="section-title">Location</span>
            <div className="row wrap">
              {coords ? (
                <span className="chip accent">
                  {locationSource === 'place' ? 'Place picked' : 'GPS captured'} ({coords})
                </span>
              ) : (
                <span className="chip">No GPS fix</span>
              )}
              <button
                type="button"
                className="btn sm"
                onClick={async () => {
                  const entry = await getLocationWithPlace();
                  if (!entry) {
                    toastError('No position available');
                    return;
                  }
                  setLocation({ time: entry.time, lat: entry.lat, lon: entry.lon });
                  setLocationSource('gps');
                  const nearby = entry.label;
                  if (nearby && locationLabel.trim() === '') {
                    // Auto-filled place name, not typed: keep the form clean.
                    stickyBaseline.current.locationLabel = nearby.trim();
                    setLocationLabel(nearby);
                  }
                  toast('Position updated');
                }}
              >
                {coords ? 'Refresh position' : 'Try again'}
              </button>
            </div>
            <PlaceInput
              label="Place label"
              hint="Type to search for a place, or write anything. Free text is fine."
              value={locationLabel}
              placeholder="Home office shelf B"
              onChange={setLocationLabel}
              onPick={(hit) => {
                setLocationLabel(hit.label);
                setLocation({ time: Date.now(), lat: hit.lat, lon: hit.lon });
                setLocationSource('place');
              }}
            />
          </section>

          {/* 6. Owner */}
          {ownerTracking ? (
            <section className="stack tight">
              <span className="section-title">Owner</span>
              <input
                className="input"
                list="known-owners"
                value={owner}
                placeholder="Owner name"
                disabled={ownerDisabled}
                onChange={(e) => setOwner(e.target.value)}
              />
              <datalist id="known-owners">
                {ownerOptions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <Toggle
                label="Do not track owner for this item"
                checked={ownerDisabled}
                onChange={setOwnerDisabled}
              />
            </section>
          ) : null}

          {/* 7. Optional detail. Sections whose fields were ever filled in
              this inventory (meta.fieldPrefs, synced) start expanded; the
              constant `open` prop never fights the user's own toggling. */}
          <details
            className="disclosure"
            open={initialExpanded.current?.has(SECTION_CATEGORY_TAGS) || undefined}
          >
            <summary>Category and tags (optional)</summary>
            <div className="disclosure-body">
              <Field label="Category">
                <SmartCombo
                  value={category}
                  options={categoryComboOptions}
                  placeholder="Test equipment"
                  ariaLabel="Category"
                  onInput={setCategory}
                  onCommit={setCategory}
                />
              </Field>
              <Field label="Tags" hint="Comma separated">
                <input
                  className="input"
                  value={tags}
                  placeholder="fragile, lab"
                  onChange={(e) => setTags(e.target.value)}
                />
              </Field>
            </div>
          </details>

          <details
            className="disclosure"
            open={initialExpanded.current?.has(SECTION_CUSTOMS) || undefined}
          >
            <summary>Customs details (optional)</summary>
            <div className="disclosure-body">
              <div className="serial-row">
                <Field label="Serial number">
                  <input
                    className="input"
                    value={serialNumber}
                    placeholder="Serial number"
                    onChange={(e) => setSerialNumber(e.target.value)}
                  />
                </Field>
                <button type="button" className="btn ghost sm" onClick={() => setScanOpen(true)}>
                  Scan
                </button>
              </div>

              <Field label="Purchase date">
                <input
                  className="input"
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                />
              </Field>

              <MoneyInput
                label="Purchase price"
                amount={purchasePrice}
                currency={currency}
                mainCurrency={metaCurrency}
                onChange={setValueField(setPurchasePrice)}
              />

              <Field label="Vendor">
                <input
                  className="input"
                  list="known-vendors"
                  value={vendor}
                  placeholder="Where it was bought"
                  onChange={(e) => setVendor(e.target.value)}
                />
                <datalist id="known-vendors">
                  {vendorOptions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </Field>

              <Field label="Box">
                <div className="row">
                  <select
                    className="select grow"
                    value={boxId}
                    onChange={(e) => setBoxId(e.target.value)}
                  >
                    <option value="">No box</option>
                    {boxes.map((box) => (
                      <option key={box.id} value={box.id}>
                        {box.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn" onClick={() => setNewBoxOpen(true)}>
                    New box
                  </button>
                </div>
              </Field>

              <Field label="Condition">
                <SmartCombo
                  value={condition}
                  options={conditionOptions}
                  placeholder="Good, minor scratches"
                  ariaLabel="Condition"
                  onInput={setCondition}
                  onCommit={setCondition}
                />
              </Field>

              <Toggle
                label="Contains a lithium battery"
                description="Air freight and couriers ask for this."
                checked={lithiumBattery}
                onChange={setLithiumBattery}
              />

              <Field label="Country of origin">
                <SmartCombo
                  value={countryOfOrigin}
                  options={countryOptions}
                  placeholder="Germany"
                  ariaLabel="Country of origin"
                  onInput={setCountryOfOrigin}
                  onCommit={setCountryOfOrigin}
                />
              </Field>

              <Field label="Brand and model">
                <input
                  className="input"
                  value={brandModel}
                  placeholder="Rigol DS1054Z"
                  onChange={(e) => setBrandModel(e.target.value)}
                />
              </Field>

              <Field label="HS code">
                <input
                  className="input"
                  value={hsCode}
                  placeholder="9030.20"
                  onChange={(e) => setHsCode(e.target.value)}
                />
              </Field>

              <Field label="Acquisition">
                <select
                  className="select"
                  value={acquisition}
                  onChange={(e) => setAcquisition(e.target.value as '' | AcquisitionMethod)}
                >
                  <option value="">Not stated</option>
                  <option value="new">Bought new</option>
                  <option value="used">Bought used</option>
                  <option value="gift">Gift</option>
                </select>
              </Field>

              <Field label="Notes">
                <textarea
                  className="textarea"
                  value={notes}
                  placeholder="Anything a forwarder should know"
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>

              {translations && Object.keys(translations).length > 0 ? (
                <Field label="Translations">
                  <div className="stack tight">
                    {Object.entries(translations).map(([lang, text]) => (
                      <p key={lang} className="small">
                        <span className="muted">{lang}: </span>
                        {text}
                      </p>
                    ))}
                    <TwoStepDeleteButton
                      className="btn sm"
                      label="Remove translations"
                      armedLabel="Tap again to remove"
                      armedChildren="Tap again to remove"
                      onDelete={() => setTranslations(null)}
                    >
                      Remove translations
                    </TwoStepDeleteButton>
                  </div>
                </Field>
              ) : null}
            </div>
          </details>

          {!canSave ? (
            <p className="banner plain">
              Description, weight and size are required before an item can be saved.
            </p>
          ) : null}
        </div>
      </main>

      <div className="bottom-bar">
        <div className="inner">
          <button
            type="button"
            className="btn primary"
            disabled={!canSave || saving}
            onClick={() => void save('again')}
          >
            {saving ? 'Saving' : 'Save and add another'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canSave || saving}
            onClick={() => void save('open')}
          >
            Save and open
          </button>
        </div>
      </div>

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
              setSerialNumber(text);
              setScanOpen(false);
              toast('Serial captured');
            }}
          />
        </Modal>
      ) : null}

      {leaveAction ? (
        <ConfirmModal
          title="Discard this item?"
          body="This item has not been saved. Leaving now discards the photos and details you entered."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={leaveAction}
          onClose={() => setLeaveAction(null)}
        />
      ) : null}

      {newBoxOpen ? (
        <NewBoxModal
          onClose={() => setNewBoxOpen(false)}
          onCreate={(label) => {
            const id = inv.createBox(label);
            setBoxId(id);
            setNewBoxOpen(false);
            toast('Box created');
          }}
        />
      ) : null}
    </>
  );
}

function NewBoxModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (label: string) => void;
}) {
  const [label, setLabel] = useState('');
  // Held Enter repeats the keydown, and the modal only unmounts on the next
  // render, so without this every repeat would create another box.
  const submitted = useRef(false);

  const submit = () => {
    if (submitted.current || !label.trim()) return;
    submitted.current = true;
    onCreate(label.trim());
  };

  return (
    <Modal
      title="New box"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={!label.trim()}
            onClick={submit}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Box label" hint="For example: Carton 3">
        <input
          className="input lg"
          autoFocus
          value={label}
          placeholder="Box label"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </Field>
    </Modal>
  );
}
