/**
 * Popup: onboarding (paste the profile share link once) then search across
 * all synced inventories with per-item "Sell on Anibis / Facebook" actions
 * that drive the existing content-script autofill.
 *
 * Sensitive material (tokens, E2E keys) stays in chrome.storage.local and is
 * only ever sent to the relay the profile link points at.
 */

import { LANG_NAMES, draftListing, isListingLang, maskKey, parseAiKeyInput } from './ai';
import { buildListingPayload, isListingPayload, itemTitle, matchesQuery, suggestPrice } from './listing';
import { connectedMessage, importProfileText } from './onboard';
import { createFetchQueue, fetchPhotoBlob } from './photos';
import { decodeQrImage } from './qr';
import {
  clearAll,
  getAiSettings,
  getCache,
  getProfile,
  putCachedInventory,
  setAiSettings,
  setPayload,
  setPendingFill,
  setStagedPhotos,
} from './storage';
import { syncInventory } from './sync';
import type {
  CacheMap,
  ExtItem,
  ListingPayload,
  Profile,
  ProfileHandle,
  StagedPhoto,
} from './types';

type SiteId = 'anibis' | 'facebook';

const SITES: Record<SiteId, { label: string; host: RegExp; createUrl: string }> = {
  anibis: {
    label: 'Anibis',
    host: /(^|\.)anibis\.ch$/,
    createUrl: 'https://www.anibis.ch/fr/listings/new',
  },
  facebook: {
    label: 'Facebook Marketplace',
    host: /(^|\.)facebook\.com$/,
    createUrl: 'https://www.facebook.com/marketplace/create/item',
  },
};

const AUTO_REFRESH_MS = 10 * 60_000;
const MAX_RESULTS = 50;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

let profile: Profile | null = null;
let cache: CacheMap = {};
let syncing = false;

const photoQueue = createFetchQueue(3);

/* ---------------------------------------------------------------- */
/* Small helpers                                                     */
/* ---------------------------------------------------------------- */

function setStatus(el: HTMLElement, text: string, kind?: 'ok' | 'err'): void {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function handleFor(docId: string): ProfileHandle | null {
  return profile?.handles.find((h) => h.docId === docId) ?? null;
}

/**
 * Active tab (any window) currently showing a supported marketplace,
 * discovered by pinging the content scripts (the popup has no "tabs"
 * permission, so tab URLs are not readable — the ping needs none).
 */
async function findMarketplaceTab(): Promise<{
  tabId: number;
  site: SiteId;
  listing: boolean;
} | null> {
  const tabs = await chrome.tabs.query({ active: true });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const res = (await chrome.tabs.sendMessage(tab.id, { type: 'PV_PING' })) as {
        site?: SiteId;
        listing?: boolean;
      } | null;
      if (res?.site && res.site in SITES) {
        return { tabId: tab.id, site: res.site, listing: Boolean(res.listing) };
      }
    } catch {
      // No content script in that tab: not a supported site.
    }
  }
  return null;
}

function money(item: ExtItem): string {
  if (item.valueCurrent) return `${item.valueCurrent.amount} ${item.valueCurrent.currency}`;
  if (item.valueNew) return `~${Math.round(item.valueNew.amount * 0.6)} ${item.valueNew.currency}`;
  return '';
}

/* ---------------------------------------------------------------- */
/* Onboarding view                                                   */
/* ---------------------------------------------------------------- */

function showOnboarding(): void {
  $('view-onboarding').hidden = false;
  $('view-main').hidden = true;
}

async function connectFromText(text: string): Promise<void> {
  const status = $('ob-status');
  const originInput = $<HTMLInputElement>('ob-origin');
  const result = await importProfileText(text, originInput.value.trim() || undefined);
  if (!result.ok) {
    if (result.reason === 'not-a-link') {
      setStatus(
        status,
        'Not a profile share link. In the app: Inventories → Backup / transfer → copy the link (or use the QR).',
        'err',
      );
    } else if (result.reason === 'link-token') {
      setStatus(
        status,
        'That is the device-link code — it carries no inventories. In the app: Inventories → Link / backup → "Copy full backup link".',
        'err',
      );
    } else if (result.reason === 'needs-origin') {
      $('ob-origin-row').hidden = false;
      setStatus(
        status,
        'That looks like a bare payload — also enter your server address (e.g. https://inv.example.com).',
        'err',
      );
    } else {
      setStatus(status, 'Could not read the profile payload (is the link complete?).', 'err');
    }
    return;
  }
  profile = result.profile;
  setStatus(status, connectedMessage(result), 'ok');
  await showMain();
  void refreshAll();
}

async function connectFromImage(blob: Blob): Promise<void> {
  const status = $('ob-status');
  setStatus(status, 'Reading QR…');
  const text = await decodeQrImage(blob);
  if (!text) {
    setStatus(status, 'No QR code found in that image.', 'err');
    return;
  }
  $<HTMLTextAreaElement>('ob-link').value = text;
  await connectFromText(text);
}

function imageFromDataTransfer(dt: DataTransfer | null): Blob | null {
  if (!dt) return null;
  for (const file of Array.from(dt.files)) {
    if (file.type.startsWith('image/')) return file;
  }
  for (const item of Array.from(dt.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

function wireOnboarding(): void {
  $('ob-connect').addEventListener('click', () => {
    void connectFromText($<HTMLTextAreaElement>('ob-link').value);
  });
  $('ob-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      $<HTMLTextAreaElement>('ob-link').value = text;
      await connectFromText(text);
    } catch {
      setStatus($('ob-status'), 'Clipboard read was blocked — paste into the box instead.', 'err');
    }
  });

  // QR image: file picker, drag & drop anywhere on the onboarding view,
  // or pasting an image (all funnel into the same decode + import path).
  const qrInput = $<HTMLInputElement>('ob-qr');
  $('ob-qr-btn').addEventListener('click', () => qrInput.click());
  qrInput.addEventListener('change', () => {
    const file = qrInput.files?.[0];
    qrInput.value = '';
    if (file) void connectFromImage(file);
  });
  const view = $('view-onboarding');
  view.addEventListener('dragover', (e) => {
    e.preventDefault();
    view.classList.add('drop');
  });
  view.addEventListener('dragleave', () => view.classList.remove('drop'));
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    view.classList.remove('drop');
    const image = imageFromDataTransfer(e.dataTransfer);
    if (image) void connectFromImage(image);
    else if (e.dataTransfer?.getData('text')) void connectFromText(e.dataTransfer.getData('text'));
  });
  document.addEventListener('paste', (e) => {
    if (view.hidden) return;
    const image = imageFromDataTransfer(e.clipboardData);
    if (image) {
      e.preventDefault();
      void connectFromImage(image);
    }
  });

  // Live camera scanning needs a real tab (MV3 popups can't hold the camera
  // permission prompt); the scan page stores the profile itself.
  $('ob-camera').addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('scan.html') });
    window.close();
  });
}

/* ---------------------------------------------------------------- */
/* Sync                                                              */
/* ---------------------------------------------------------------- */

async function refreshAll(): Promise<void> {
  if (!profile || syncing) return;
  syncing = true;
  const status = $('status');
  const btn = $<HTMLButtonElement>('refresh');
  btn.disabled = true;
  let failed = 0;
  try {
    for (let i = 0; i < profile.handles.length; i++) {
      const handle = profile.handles[i];
      setStatus(status, `Syncing ${handle.name ?? handle.docId} (${i + 1}/${profile.handles.length})…`);
      try {
        const inv = await syncInventory(profile.origin, handle);
        cache[handle.docId] = inv;
        await putCachedInventory(inv);
      } catch (err) {
        failed++;
        const prev = cache[handle.docId];
        const entry = {
          docId: handle.docId,
          name: prev?.name ?? handle.name ?? handle.docId,
          syncedAt: prev?.syncedAt ?? 0,
          items: prev?.items ?? [],
          error: err instanceof Error ? err.message : String(err),
        };
        cache[handle.docId] = entry;
        await putCachedInventory(entry);
      }
      render();
    }
    setStatus(
      status,
      failed === 0
        ? `Synced ${profile.handles.length} inventor${profile.handles.length === 1 ? 'y' : 'ies'}.`
        : `Synced with ${failed} failure(s) — showing cached items where sync failed.`,
      failed === 0 ? 'ok' : 'err',
    );
  } finally {
    syncing = false;
    btn.disabled = false;
    renderCounts();
  }
}

/* ---------------------------------------------------------------- */
/* Selling                                                           */
/* ---------------------------------------------------------------- */

async function sendFill(tabId: number): Promise<
  { ok: boolean; error?: string; site?: string; results?: Array<{ status: string }> } | null
> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await chrome.tabs.sendMessage(tabId, { type: 'PV_FILL' })) as never;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return null;
}

/* Staged photos travel through chrome.storage.local as base64: Blobs cannot
 * cross that boundary, and runtime messaging is no option either because the
 * popup closes (killing its blob URLs and listeners) the moment the
 * marketplace tab opens. Size caps keep the storage write sane. */
const MAX_STAGED_PHOTOS = 10;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = fr.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Decrypt the item's photos and stage them for the content script; always
 * overwrites the previous staging so another item's photos never linger. */
async function stagePhotos(item: ExtItem): Promise<number> {
  const handle = handleFor(item.docId);
  if (!handle || !profile || item.photos.length === 0) {
    await setStagedPhotos(null);
    return 0;
  }
  const base = safeFilename(item.description || item.brandModel || 'item');
  const staged: StagedPhoto[] = [];
  let total = 0;
  for (const photo of item.photos.slice(0, MAX_STAGED_PHOTOS)) {
    const blob = await fetchPhotoBlob(profile.origin, handle, photo.hash);
    if (!blob || blob.size > MAX_PHOTO_BYTES || total + blob.size > MAX_TOTAL_BYTES) continue;
    total += blob.size;
    staged.push({
      name: `${base}-${staged.length + 1}.${extensionForMime(blob.type)}`,
      type: blob.type || 'image/jpeg',
      b64: await blobToB64(blob),
    });
  }
  await setStagedPhotos(staged.length > 0 ? { at: Date.now(), photos: staged } : null);
  return staged.length;
}

async function sellItem(item: ExtItem, site: SiteId): Promise<void> {
  const status = $('status');
  const ai = await getAiSettings();
  const payload = buildListingPayload(item, ai.lang);
  let aiNote = '';
  if (ai.key) {
    // AI draft with a hard timeout (in draftListing) — a Sell click must
    // never hang; on any failure the localized template above stands.
    setStatus(status, `AI drafting in ${LANG_NAMES[ai.lang]}…`);
    try {
      const draft = await draftListing(item, suggestPrice(item), ai.lang, ai.key);
      payload.item.title = draft.title;
      payload.item.description = draft.description;
      payload.item.aiDrafted = true;
      delete payload.item.descriptionTranslations;
      aiNote = ` AI-drafted in ${LANG_NAMES[ai.lang]}.`;
    } catch {
      aiNote = ' (AI draft failed — template used.)';
    }
  }
  await setPayload(payload);
  if (item.photos.length > 0) setStatus(status, `Decrypting ${item.photos.length} photo(s)…`);
  const staged = await stagePhotos(item);
  const photoNote = staged > 0 ? ` ${staged} photo(s) attach automatically.` : '';

  const active = await findMarketplaceTab();
  if (active && active.site === site) {
    const res = await sendFill(active.tabId);
    if (res?.ok) {
      const filled = res.results?.filter((r) => r.status === 'filled').length ?? 0;
      setStatus(status, `${SITES[site].label}: ${filled} field(s) filled — check the overlay on the page.${aiNote}`, 'ok');
      return;
    }
    if (res && res.error !== 'not-listing-page') {
      setStatus(status, `Fill failed: ${res.error ?? 'no response'} — reload the page and retry.`, 'err');
      return;
    }
    // Right site, wrong page (or content script not answering): open the form.
  }
  await setPendingFill(site);
  await chrome.tabs.create({ url: SITES[site].createUrl });
  setStatus(status, `Opened ${SITES[site].label} — the form fills itself once it loads.${photoNote}${aiNote}`, 'ok');
}

async function usePastedPayload(text: string): Promise<boolean> {
  const status = $('status');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    setStatus(status, 'Not valid JSON — use “Copy for extension” in the app’s Sell dialog.', 'err');
    return false;
  }
  if (!isListingPayload(raw)) {
    setStatus(status, 'Not a Peerventory listing payload (v1).', 'err');
    return false;
  }
  await setPayload(raw as ListingPayload);
  // A pasted payload carries no photo bytes — staged photos of a previously
  // sold item must not attach to this listing.
  await setStagedPhotos(null);
  setStatus(status, `Saved “${(raw as ListingPayload).item.title}” — use Fill this page below.`, 'ok');
  return true;
}

/* ---------------------------------------------------------------- */
/* Photos                                                            */
/* ---------------------------------------------------------------- */

function extensionForMime(mime: string): string {
  const base = (mime ?? '').toLowerCase().split(';', 1)[0].trim();
  if (base === 'image/png') return 'png';
  if (base === 'image/webp') return 'webp';
  return 'jpg';
}

function safeFilename(name: string): string {
  return (
    name.trim().split('\n')[0].replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) ||
    'item'
  );
}

async function downloadItemPhotos(item: ExtItem): Promise<void> {
  const status = $('status');
  const handle = handleFor(item.docId);
  if (!handle || !profile) return;
  setStatus(status, 'Fetching photos…');
  let saved = 0;
  for (const photo of item.photos) {
    const blob = await fetchPhotoBlob(profile.origin, handle, photo.hash);
    if (!blob) continue;
    saved++;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFilename(item.description || item.brandModel || 'item')}-${saved}.${extensionForMime(blob.type)}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    await new Promise((r) => setTimeout(r, 300));
  }
  setStatus(
    status,
    saved > 0
      ? `${saved} photo(s) downloaded — only needed if the automatic attach didn't work; drag them into the form.`
      : 'No photos could be fetched (offline or blob missing).',
    saved > 0 ? 'ok' : 'err',
  );
}

/* ---------------------------------------------------------------- */
/* Settings: listing language + "Link AI"                            */
/* ---------------------------------------------------------------- */

async function renderAiSettings(): Promise<void> {
  const ai = await getAiSettings();
  $<HTMLSelectElement>('lang').value = ai.lang;
  const linked = $('ai-linked');
  linked.hidden = !ai.key;
  if (ai.key) linked.textContent = `AI linked: ${maskKey(ai.key)} (Anthropic, direct from this browser).`;
  $<HTMLButtonElement>('ai-clear').hidden = !ai.key;
}

async function saveAiKeyText(text: string): Promise<void> {
  const status = $('ai-status');
  const key = parseAiKeyInput(text);
  if (!key) {
    setStatus(status, 'Not an API key — paste the sk-ant-… key or the app’s inv-ai: link.', 'err');
    return;
  }
  const ai = await getAiSettings();
  await setAiSettings({ ...ai, key });
  $<HTMLInputElement>('ai-key').value = '';
  setStatus(status, 'AI linked — Sell now drafts the listing text and picks categories.', 'ok');
  await renderAiSettings();
}

function wireSettings(): void {
  $('lang').addEventListener('change', async () => {
    const value = $<HTMLSelectElement>('lang').value;
    const ai = await getAiSettings();
    await setAiSettings({ ...ai, lang: isListingLang(value) ? value : 'fr' });
  });
  $('ai-save').addEventListener('click', () => {
    void saveAiKeyText($<HTMLInputElement>('ai-key').value);
  });
  const qrInput = $<HTMLInputElement>('ai-qr');
  $('ai-qr-btn').addEventListener('click', () => qrInput.click());
  qrInput.addEventListener('change', async () => {
    const file = qrInput.files?.[0];
    qrInput.value = '';
    if (!file) return;
    setStatus($('ai-status'), 'Reading QR…');
    const text = await decodeQrImage(file);
    if (!text) {
      setStatus($('ai-status'), 'No QR code found in that image.', 'err');
      return;
    }
    await saveAiKeyText(text);
  });
  $('ai-clear').addEventListener('click', async () => {
    const ai = await getAiSettings();
    delete ai.key;
    await setAiSettings(ai);
    setStatus($('ai-status'), 'AI unlinked — the template fill is used again.', 'ok');
    await renderAiSettings();
  });
}

/* ---------------------------------------------------------------- */
/* Main view rendering                                               */
/* ---------------------------------------------------------------- */

function renderCounts(): void {
  const inventories = Object.values(cache);
  const total = inventories.reduce((n, inv) => n + inv.items.length, 0);
  const withErrors = inventories.filter((inv) => inv.error).length;
  const parts = [`${total} item${total === 1 ? '' : 's'} in ${inventories.length} inventor${inventories.length === 1 ? 'y' : 'ies'}`];
  if (withErrors > 0) parts.push(`${withErrors} not synced`);
  $('counts').textContent = parts.join(' · ');
}

async function renderSiteBanner(): Promise<void> {
  const banner = $('site-banner');
  const active = await findMarketplaceTab();
  if (active) {
    banner.textContent = `${SITES[active.site].label} is open in your active tab — Sell fills it directly.`;
    banner.className = 'banner on';
  } else {
    banner.textContent = 'No marketplace tab detected — Sell opens the listing form for you.';
    banner.className = 'banner';
  }
}

function itemRow(item: ExtItem, inventoryName: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'item';
  row.dataset.itemId = item.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  row.appendChild(thumb);
  const handle = handleFor(item.docId);
  if (item.photos.length > 0 && handle && profile) {
    const origin = profile.origin;
    photoQueue(async () => {
      const blob = await fetchPhotoBlob(origin, handle, item.photos[0].hash);
      if (!blob || !thumb.isConnected) return;
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
      thumb.replaceChildren(img);
    });
  }

  const body = document.createElement('div');
  body.className = 'body';
  const title = document.createElement('div');
  title.className = 't';
  title.textContent = itemTitle(item);
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [inventoryName, money(item), item.quantity > 1 ? `×${item.quantity}` : '']
    .filter(Boolean)
    .join(' · ');
  body.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const site of Object.keys(SITES) as SiteId[]) {
    const btn = document.createElement('button');
    btn.dataset.sell = site;
    btn.textContent = site === 'anibis' ? 'Sell on Anibis' : 'Sell on Facebook';
    btn.addEventListener('click', () => void sellItem(item, site));
    actions.appendChild(btn);
  }
  if (item.photos.length > 0) {
    const btn = document.createElement('button');
    btn.textContent = `Photos (${item.photos.length})`;
    btn.title =
      'Download decrypted photos as files (manual fallback — Sell attaches them automatically)';
    btn.addEventListener('click', () => void downloadItemPhotos(item));
    actions.appendChild(btn);
  }
  body.appendChild(actions);
  row.appendChild(body);
  return row;
}

function render(): void {
  const query = $<HTMLInputElement>('search').value;
  const results = $('results');
  const rows: Array<{ item: ExtItem; inventoryName: string }> = [];
  for (const inv of Object.values(cache)) {
    for (const item of inv.items) {
      if (matchesQuery(item, inv.name, query)) rows.push({ item, inventoryName: inv.name });
    }
  }
  rows.sort((a, b) => b.item.updatedAt - a.item.updatedAt);

  results.replaceChildren();
  for (const { item, inventoryName } of rows.slice(0, MAX_RESULTS)) {
    results.appendChild(itemRow(item, inventoryName));
  }
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query.trim()
      ? 'No items match.'
      : 'No items yet — hit Refresh to sync your inventories.';
    results.appendChild(empty);
  } else if (rows.length > MAX_RESULTS) {
    const more = document.createElement('div');
    more.className = 'empty';
    more.textContent = `${rows.length - MAX_RESULTS} more — refine the search.`;
    results.appendChild(more);
  }
  renderCounts();
}

async function showMain(): Promise<void> {
  $('view-onboarding').hidden = true;
  $('view-main').hidden = false;
  $('main-user').textContent = profile?.userName ? `${profile.userName}’s items` : 'Your items';
  cache = await getCache();
  render();
  void renderSiteBanner();
  void renderAiSettings();
  $<HTMLInputElement>('search').focus();
}

function wireMain(): void {
  $('search').addEventListener('input', render);
  $('refresh').addEventListener('click', () => void refreshAll());
  $('disconnect').addEventListener('click', async () => {
    if (!confirm('Forget this profile, all synced items, cached photos and the linked AI key on this browser?')) return;
    await clearAll();
    profile = null;
    cache = {};
    $<HTMLTextAreaElement>('ob-link').value = '';
    showOnboarding();
  });

  // Advanced: app-drafted payload (AI copy from the app's Sell dialog).
  $('payload-save').addEventListener('click', () => {
    void usePastedPayload($<HTMLTextAreaElement>('payload').value.trim());
  });
  $('fill-page').addEventListener('click', async () => {
    const text = $<HTMLTextAreaElement>('payload').value.trim();
    if (text && !(await usePastedPayload(text))) return;
    const active = await findMarketplaceTab();
    if (!active) {
      setStatus($('status'), 'Open the Anibis publish form or facebook.com/marketplace/create first.', 'err');
      return;
    }
    const res = await sendFill(active.tabId);
    if (res?.ok) {
      setStatus($('status'), `${SITES[active.site].label}: filled — see the overlay on the page.`, 'ok');
    } else {
      setStatus(
        $('status'),
        res?.error === 'not-listing-page'
          ? 'That tab is not on the listing creation form.'
          : `Fill failed: ${res?.error ?? 'no response — reload the page and retry.'}`,
        'err',
      );
    }
  });
}

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

async function init(): Promise<void> {
  wireOnboarding();
  wireMain();
  wireSettings();
  profile = await getProfile();
  if (!profile) {
    showOnboarding();
    return;
  }
  await showMain();
  const newest = Math.max(0, ...Object.values(cache).map((inv) => inv.syncedAt));
  if (Date.now() - newest > AUTO_REFRESH_MS) void refreshAll();
}

void init();
