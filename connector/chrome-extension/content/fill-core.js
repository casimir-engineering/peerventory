/**
 * Peerventory fill engine, shared by every site script (loaded first in each
 * content_scripts entry; site scripts read window.__pv).
 *
 * Design constraints:
 *  - Anibis and Facebook redesign their forms regularly, so nothing here
 *    hardcodes brittle class names. Site scripts describe each field with a
 *    list of strategies (CSS selector, aria-label, placeholder, <label> text,
 *    name attribute) that are tried in order; updating a broken map means
 *    editing one regex in content/<site>.js.
 *  - Both sites use React-controlled inputs: assigning .value directly is
 *    reverted on the next render, so values are written through the native
 *    prototype setter and followed by real 'input'/'change' events.
 *  - No remote code, no analytics, no data leaves the page. The payload is
 *    read from chrome.storage.local where the popup put it.
 */

(() => {
  'use strict';
  if (window.__pv) return; // already injected (SPA re-injection guard)

  const PAYLOAD_KEY = 'pv:payload';
  /** Decrypted photos staged by the popup (base64) for automatic attachment. */
  const PHOTOS_KEY = 'pv:photos';

  /* ---------------------------------------------------------------- */
  /* Element discovery                                                  */
  /* ---------------------------------------------------------------- */

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function editable(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    return (
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (tag === 'INPUT' &&
        !['hidden', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(el.type)) ||
      el.isContentEditable
    );
  }

  /** Controls that belong to a <label> (htmlFor or wrapped). */
  function controlOfLabel(label) {
    if (label.htmlFor) {
      const el = document.getElementById(label.htmlFor);
      if (el) return el;
    }
    return label.querySelector('input, textarea, select, [contenteditable="true"]');
  }

  /**
   * spec: {
   *   selectors?: string[],      // exact CSS, tried first
   *   aria?: RegExp,             // aria-label on the control
   *   placeholder?: RegExp,
   *   label?: RegExp,            // text of an associated <label>
   *   name?: RegExp,             // name/id attribute
   *   kind?: 'text'|'multiline'|'select'  // narrows candidates
   * }
   */
  function findControl(spec) {
    const matchKind = (el) => {
      if (!spec.kind) return true;
      if (spec.kind === 'select') return el.tagName === 'SELECT';
      if (spec.kind === 'multiline') return el.tagName === 'TEXTAREA' || el.isContentEditable;
      return el.tagName === 'INPUT';
    };
    const ok = (el) => el && editable(el) && visible(el) && matchKind(el);

    for (const sel of spec.selectors || []) {
      try {
        for (const el of document.querySelectorAll(sel)) if (ok(el)) return el;
      } catch {
        /* invalid selector in a map edit; skip */
      }
    }
    const candidates = document.querySelectorAll(
      'input, textarea, select, [contenteditable="true"]',
    );
    if (spec.aria) {
      for (const el of candidates) {
        const aria = el.getAttribute('aria-label') || '';
        if (aria && spec.aria.test(aria) && ok(el)) return el;
      }
      // aria-labelledby indirection (Facebook uses it in places)
      for (const el of candidates) {
        const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        const text = ids
          .map((id) => (document.getElementById(id) || {}).textContent || '')
          .join(' ')
          .trim();
        if (text && spec.aria.test(text) && ok(el)) return el;
      }
    }
    if (spec.placeholder) {
      for (const el of candidates) {
        const ph = el.getAttribute('placeholder') || '';
        if (ph && spec.placeholder.test(ph) && ok(el)) return el;
      }
    }
    if (spec.label) {
      for (const label of document.querySelectorAll('label')) {
        const text = (label.textContent || '').trim();
        if (!text || !spec.label.test(text)) continue;
        const el = controlOfLabel(label);
        if (ok(el)) return el;
      }
    }
    if (spec.name) {
      for (const el of candidates) {
        if ((spec.name.test(el.name || '') || spec.name.test(el.id || '')) && ok(el)) return el;
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Value writing (React-safe)                                         */
  /* ---------------------------------------------------------------- */

  function setNativeValue(el, value) {
    const proto =
      el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setContentEditable(el, value) {
    el.focus();
    // execCommand still works in Chrome and is the only way to make most
    // rich-text editors (Lexical/Draft on Facebook) register the text.
    const selected = window.getSelection();
    if (selected) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selected.removeAllRanges();
      selected.addRange(range);
    }
    let okCmd = false;
    try {
      okCmd = document.execCommand('insertText', false, String(value));
    } catch {
      okCmd = false;
    }
    if (!okCmd) {
      el.textContent = String(value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value) }));
    }
    el.blur();
  }

  function fillControl(el, value) {
    el.focus();
    if (el.tagName === 'SELECT') {
      const want = String(value).trim().toLowerCase();
      const opt = [...el.options].find(
        (o) =>
          o.value.toLowerCase() === want ||
          (o.textContent || '').trim().toLowerCase().includes(want),
      );
      if (!opt) return false;
      setNativeValue(el, opt.value);
      return true;
    }
    if (el.isContentEditable) {
      setContentEditable(el, value);
      return true;
    }
    setNativeValue(el, value);
    el.blur();
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Field map runner                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * fields: array of {
   *   key, label,                 // for the report/overlay
   *   spec,                       // findControl() spec — omit for manualOnly
   *   value(payloadItem) -> string|number|null,   // null = skip field
   *   manualOnly?: true,          // never auto-filled, value shown as a hint
   *   note?(payloadItem) -> string|null
   * }
   * Returns [{ key, label, status: 'filled'|'manual'|'notfound'|'skipped', value, note }]
   */
  function fillFields(fields, payloadItem) {
    const results = [];
    for (const field of fields) {
      const value = field.value(payloadItem);
      const note = field.note ? field.note(payloadItem) : null;
      if (value === null || value === undefined || value === '') {
        results.push({ key: field.key, label: field.label, status: 'skipped', value: '', note });
        continue;
      }
      if (field.manualOnly) {
        results.push({ key: field.key, label: field.label, status: 'manual', value, note });
        continue;
      }
      const el = findControl(field.spec || {});
      if (!el) {
        results.push({ key: field.key, label: field.label, status: 'notfound', value, note });
        continue;
      }
      const okFill = fillControl(el, value);
      results.push({
        key: field.key,
        label: field.label,
        status: okFill ? 'filled' : 'manual',
        value,
        note,
      });
    }
    return results;
  }

  /* ---------------------------------------------------------------- */
  /* Photo attachment                                                   */
  /* ---------------------------------------------------------------- */

  /** Staged photos older than this are ignored (a stale "Sell" click must
   * never attach the wrong item's photos to a later listing). */
  const PHOTOS_MAX_AGE_MS = 10 * 60 * 1000;

  function b64ToFile(photo, index) {
    const bin = atob(photo.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], photo.name || `photo-${index + 1}.jpg`, {
      type: photo.type || 'image/jpeg',
    });
  }

  /** File inputs are almost always visually hidden behind a styled dropzone,
   * so unlike findControl this does NOT require visibility. */
  function defaultPhotoInput() {
    return (
      document.querySelector('input[type="file"][accept*="image"]') ||
      document.querySelector('input[type="file"]')
    );
  }

  /**
   * Attach the photos the popup staged in chrome.storage.local to the form's
   * file input (or, failing that, drop them on site.dropZone()). Returns a
   * result row for the overlay, or null when nothing is staged.
   */
  async function attachStagedPhotos(site) {
    let staged;
    try {
      staged = (await chrome.storage.local.get(PHOTOS_KEY))[PHOTOS_KEY];
    } catch {
      return null;
    }
    if (!staged || !Array.isArray(staged.photos) || staged.photos.length === 0) return null;
    if (typeof staged.at !== 'number' || Date.now() - staged.at > PHOTOS_MAX_AGE_MS) return null;
    const row = (status, note) => ({
      key: 'photos',
      label: `Photos (${staged.photos.length})`,
      status,
      value: `${staged.photos.length} photo(s)`,
      note: note || null,
    });
    // Re-running the fill (second popup click, pending retry) must not upload
    // the same photos twice.
    if (window.__pvPhotosAttachedAt === staged.at) {
      return row('filled', 'Already attached on this page.');
    }
    // SPA pages render the upload area late; poll briefly before giving up.
    const findInput = site.photoInput || defaultPhotoInput;
    let input = findInput();
    for (const deadline = Date.now() + 8000; !input && Date.now() < deadline; input = findInput()) {
      await new Promise((r) => setTimeout(r, 300));
    }
    const dt = new DataTransfer();
    const max = site.maxPhotos ? site.maxPhotos() : Infinity;
    if (max <= 0) return row('manual', 'The photo area is full — remove a photo or attach by hand.');
    const use = staged.photos.slice(0, max);
    use.forEach((p, i) => dt.items.add(b64ToFile(p, i)));

    if (input && !input.disabled) {
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const zone = site.dropZone ? site.dropZone() : null;
      if (!zone) {
        return row(
          'notfound',
          'No photo upload field found — use "Photos" in the popup and drag the files in.',
        );
      }
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      }
    }
    window.__pvPhotosAttachedAt = staged.at;
    const cut = staged.photos.length - use.length;
    return row(
      'filled',
      cut > 0 ? `Only ${use.length} attached — the form takes ${max} more photo(s) max.` : null,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Status overlay                                                     */
  /* ---------------------------------------------------------------- */

  const OVERLAY_ID = 'pv-fill-overlay';

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  function showOverlay(siteLabel, results, payload) {
    const prior = document.getElementById(OVERLAY_ID);
    if (prior) prior.remove();

    const box = document.createElement('div');
    box.id = OVERLAY_ID;
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'max-width:340px', 'max-height:60vh', 'overflow:auto',
      'background:#1c1c1e', 'color:#f2f2f7', 'border-radius:12px',
      'box-shadow:0 8px 30px rgba(0,0,0,.45)', 'padding:14px 16px',
      'font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif',
    ].join(';');

    const icon = { filled: '✓', manual: '✎', notfound: '✗', skipped: '·' };
    const color = { filled: '#34c759', manual: '#ff9f0a', notfound: '#ff453a', skipped: '#8e8e93' };
    const explain = {
      filled: 'filled',
      manual: 'set manually',
      notfound: 'field not found — fill manually',
      skipped: 'no data',
    };

    const rows = results
      .map(
        (r) =>
          `<div style="margin:3px 0"><span style="color:${color[r.status]};font-weight:700">${icon[r.status]}</span> ` +
          `<b>${esc(r.label)}</b> — ${explain[r.status]}` +
          (r.status === 'manual' || r.status === 'notfound'
            ? `<div style="margin-left:18px;color:#d1d1d6">${esc(r.value)}</div>`
            : '') +
          (r.note ? `<div style="margin-left:18px;color:#ff9f0a">${esc(r.note)}</div>` : '') +
          `</div>`,
      )
      .join('');

    // Provenance: say whether the copy came from an AI or the template, so
    // the user knows how carefully to proof-read before publishing.
    const LANG_NAMES = { fr: 'French', de: 'German', it: 'Italian', en: 'English' };
    const langName = LANG_NAMES[payload.item.language] || payload.item.language || '';
    const provenance = payload.item.aiDrafted
      ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #3a3a3c;color:#bf5af2">` +
        `🤖 AI-drafted${langName ? ` in ${esc(langName)}` : ''} — review before publishing.</div>`
      : payload.item.language
        ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #3a3a3c;color:#8e8e93">` +
          `Template fill${langName ? ` (${esc(langName)})` : ''} — link an AI in the popup for smarter copy.</div>`
        : '';

    // The photos line: covered by its own result row when the fill attached
    // (or tried to attach) staged photos; otherwise fall back to the payload's
    // manual instructions.
    const photosRow = results.find((r) => r.key === 'photos');
    const footer = photosRow
      ? ''
      : `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #3a3a3c;color:#d1d1d6">` +
        `📷 ${esc(payload.photosNote || 'Drag the downloaded photos into the photo area of the form.')}</div>`;

    box.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">` +
      `<b>Peerventory → ${esc(siteLabel)}</b>` +
      `<button id="pv-overlay-close" style="all:unset;cursor:pointer;color:#8e8e93;font-size:16px;padding:2px 6px">✕</button></div>` +
      rows +
      provenance +
      footer;

    document.documentElement.appendChild(box);
    box.querySelector('#pv-overlay-close').addEventListener('click', () => box.remove());
  }

  /** Small variant of the overlay shown while waiting for the form to appear
   * (e.g. Anibis only renders the fields after a category is picked). */
  function showWaitingHint(siteLabel, hint) {
    const prior = document.getElementById(OVERLAY_ID);
    if (prior) prior.remove();
    const box = document.createElement('div');
    box.id = OVERLAY_ID;
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'max-width:340px', 'background:#1c1c1e', 'color:#f2f2f7', 'border-radius:12px',
      'box-shadow:0 8px 30px rgba(0,0,0,.45)', 'padding:14px 16px',
      'font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif',
    ].join(';');
    box.innerHTML =
      `<b>Peerventory → ${esc(siteLabel)}</b>` +
      `<div style="margin-top:6px;color:#ff9f0a">✎ ${esc(hint)}</div>`;
    document.documentElement.appendChild(box);
  }

  /* ---------------------------------------------------------------- */
  /* Site bootstrap                                                     */
  /* ---------------------------------------------------------------- */

  function validPayload(raw) {
    return (
      raw &&
      raw.v === 1 &&
      raw.source === 'peerventory' &&
      raw.item &&
      typeof raw.item.title === 'string'
    );
  }

  /** How long runFill waits for site.formReady(). A manual step like the
   * Anibis category pick can gate the fields, and a human browsing the
   * category menu easily takes minutes — a short timeout here made the fill
   * report "field not found" while the user was still choosing, which read
   * as a hard failure. */
  const FORM_READY_TIMEOUT_MS = 10 * 60_000;

  /** One fill run: payload from storage -> fields -> overlay -> result object. */
  async function runFill(site) {
    if (!site.isListingPage()) {
      return { ok: false, error: 'not-listing-page', site: site.label };
    }
    const data = await chrome.storage.local.get(PAYLOAD_KEY);
    const payload = data[PAYLOAD_KEY];
    if (!validPayload(payload)) {
      return { ok: false, error: 'no-payload', site: site.label };
    }
    // Site-specific automated preparation (e.g. Anibis: click through the
    // category menu). Returns result rows for the overlay; on failure it
    // returns [] and the manual flow below (waiting hint) takes over.
    let prepRows = [];
    if (site.prepare) {
      try {
        prepRows = (await site.prepare(payload.item)) || [];
      } catch {
        prepRows = [];
      }
    }
    // Photos attach before the formReady wait: the upload area may exist
    // before the category-gated fields do (it does on Anibis), and uploading
    // can proceed while the user picks a category manually.
    let photosRow = null;
    try {
      photosRow = await attachStagedPhotos(site);
    } catch (err) {
      photosRow = {
        key: 'photos',
        label: 'Photos',
        status: 'notfound',
        value: '',
        note: `Attach failed (${err}) — use "Photos" in the popup instead.`,
      };
    }
    let formTimedOut = false;
    if (site.formReady && !site.formReady()) {
      // waitHint may be a function so sites can explain WHY the manual step
      // is needed (e.g. which category text failed to match).
      const hint =
        (typeof site.waitHint === 'function' ? site.waitHint(payload.item) : site.waitHint) ||
        'Waiting for the listing form to appear…';
      showWaitingHint(site.label, hint);
      const deadline = Date.now() + FORM_READY_TIMEOUT_MS;
      while (Date.now() < deadline && !site.formReady()) {
        await new Promise((r) => setTimeout(r, 500));
      }
      formTimedOut = !site.formReady();
    }
    try {
      const results = [...prepRows, ...fillFields(site.buildFields(payload.item), payload.item)];
      if (photosRow) results.push(photosRow);
      if (formTimedOut) {
        // Don't let a wall of "field not found" look like a bug: say what
        // actually happened and how to recover.
        results.unshift({
          key: 'form',
          label: 'Listing form',
          status: 'notfound',
          value: '',
          note: 'The form fields never appeared (category not picked?). Pick a category, then click Sell again in the popup.',
        });
      }
      showOverlay(site.label, results, payload);
      return { ok: true, site: site.label, results };
    } catch (err) {
      return { ok: false, error: String(err), site: site.label };
    }
  }

  /* One-shot autofill for a tab the popup just opened ("Sell on X" with no
   * marketplace tab active): the popup stores `pv:pending`, this polls until
   * the listing form exists (SPA pages render it late), fills once, and
   * clears the flag. Stale flags (> 2 min) are ignored so an old click never
   * fills an unrelated page. */
  const PENDING_KEY = 'pv:pending';
  const PENDING_MAX_AGE_MS = 2 * 60 * 1000;
  const PENDING_POLLS = 30;

  async function checkPendingFill(site) {
    const data = await chrome.storage.local.get(PENDING_KEY);
    const pending = data[PENDING_KEY];
    if (!pending || pending.site !== site.id) return;
    if (typeof pending.at !== 'number' || Date.now() - pending.at > PENDING_MAX_AGE_MS) {
      await chrome.storage.local.remove(PENDING_KEY);
      return;
    }
    for (let i = 0; i < PENDING_POLLS; i++) {
      if (site.isListingPage()) {
        await chrome.storage.local.remove(PENDING_KEY);
        await runFill(site);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /**
   * site: {
   *   id, label,
   *   isListingPage() -> bool,
   *   buildFields(payloadItem) -> fields,
   *   formReady?() -> bool,   // fields exist (a manual step may gate them)
   *   waitHint?: string | (payloadItem) -> string,  // shown while waiting
   *                           // for formReady(); function form can explain
   *                           // why the manual step is needed
   *   prepare?(payloadItem) -> Promise<resultRows>, // automated pre-step
   *                           // (e.g. Anibis category menu); [] = do it manually
   *   photoInput?() -> input[type=file] | null,  // where staged photos go
   *   maxPhotos?() -> number, // photos the form still accepts
   *   dropZone?() -> Element | null  // fallback drop target if no input
   * }
   * Wires the popup's PV_FILL message (and the pending-autofill flag) to the
   * fill run for this site.
   */
  function initSite(site) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      // The popup has no "tabs" permission, so it discovers which supported
      // site the active tab shows by pinging its content script.
      if (msg.type === 'PV_PING') {
        sendResponse({ site: site.id, label: site.label, listing: site.isListingPage() });
        return false;
      }
      if (msg.type !== 'PV_FILL') return false;
      runFill(site).then(sendResponse);
      return true; // async sendResponse
    });
    checkPendingFill(site).catch(() => {});
  }

  window.__pv = {
    findControl,
    setNativeValue,
    fillControl,
    fillFields,
    attachStagedPhotos,
    showOverlay,
    initSite,
    runFill,
    validPayload,
    PAYLOAD_KEY,
    PHOTOS_KEY,
  };
})();
