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

    box.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">` +
      `<b>Peerventory → ${esc(siteLabel)}</b>` +
      `<button id="pv-overlay-close" style="all:unset;cursor:pointer;color:#8e8e93;font-size:16px;padding:2px 6px">✕</button></div>` +
      rows +
      `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #3a3a3c;color:#d1d1d6">` +
      `📷 ${esc(payload.photosNote || 'Drag the downloaded photos into the photo area of the form.')}</div>`;

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

  /** How long runFill waits for site.formReady() (a manual step like the
   * Anibis category pick can gate the fields). */
  const FORM_READY_TIMEOUT_MS = 90_000;

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
    if (site.formReady && !site.formReady()) {
      showWaitingHint(site.label, site.waitHint || 'Waiting for the listing form to appear…');
      const deadline = Date.now() + FORM_READY_TIMEOUT_MS;
      while (Date.now() < deadline && !site.formReady()) {
        await new Promise((r) => setTimeout(r, 500));
      }
      // On timeout, fall through: the fields report "not found" honestly.
    }
    try {
      const results = fillFields(site.buildFields(payload.item), payload.item);
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
   *   waitHint?: string       // shown while waiting for formReady()
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
    showOverlay,
    initSite,
    runFill,
    validPayload,
    PAYLOAD_KEY,
  };
})();
