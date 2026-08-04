/**
 * Popup logic: hold one listing payload in chrome.storage.local and ask the
 * content script of the active tab to fill the visible listing form with it.
 * Nothing here talks to any server; the payload never leaves the browser.
 */

'use strict';

const PAYLOAD_KEY = 'pv:payload';

const $ = (id) => document.getElementById(id);

function parsePayload(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'Not valid JSON. Use “Copy for extension” in the Peerventory app.' };
  }
  if (!raw || raw.v !== 1 || raw.source !== 'peerventory' || !raw.item || !raw.item.title) {
    return { error: 'Not a Peerventory listing payload (expected v1, source "peerventory").' };
  }
  return { payload: raw };
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text || '';
  el.className = kind || '';
}

function showSummary(payload) {
  const box = $('summary');
  if (!payload) {
    box.style.display = 'none';
    return;
  }
  const it = payload.item;
  $('summary-title').textContent = it.title;
  $('summary-price').textContent =
    it.priceAmount > 0 ? `${it.priceAmount} ${it.priceCurrency || ''}` : 'No price set';
  $('summary-photos').textContent = payload.photosNote || '';
  box.style.display = 'block';
}

async function loadStored() {
  const data = await chrome.storage.local.get(PAYLOAD_KEY);
  const payload = data[PAYLOAD_KEY];
  if (payload) {
    $('payload').value = JSON.stringify(payload, null, 2);
    showSummary(payload);
  }
}

async function save(text) {
  const { payload, error } = parsePayload(text);
  if (error) {
    setStatus(error, 'err');
    showSummary(null);
    return false;
  }
  await chrome.storage.local.set({ [PAYLOAD_KEY]: payload });
  showSummary(payload);
  setStatus('Payload saved. Open the listing form and click “Fill this page”.', 'ok');
  return true;
}

$('read-clipboard').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    $('payload').value = text;
    await save(text);
  } catch {
    setStatus('Clipboard read was blocked — paste into the box instead.', 'err');
  }
});

$('save').addEventListener('click', () => void save($('payload').value));

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove(PAYLOAD_KEY);
  $('payload').value = '';
  showSummary(null);
  setStatus('Cleared.');
});

$('fill').addEventListener('click', async () => {
  // Auto-save whatever is in the box first, so paste → Fill is one click.
  const text = $('payload').value.trim();
  if (text && !(await save(text))) return;
  if (!text) {
    const stored = await chrome.storage.local.get(PAYLOAD_KEY);
    if (!stored[PAYLOAD_KEY]) {
      setStatus('No payload yet — paste it or use “Read clipboard”.', 'err');
      return;
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    setStatus('No active tab found.', 'err');
    return;
  }
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'PV_FILL' });
  } catch {
    setStatus(
      'This page has no Peerventory filler. Open the Anibis publish form or facebook.com/marketplace/create, then try again (reload the page if it was already open when the extension was installed).',
      'err',
    );
    return;
  }
  if (!res) {
    setStatus('No response from the page — reload it and try again.', 'err');
  } else if (res.ok) {
    const filled = res.results.filter((r) => r.status === 'filled').length;
    const manual = res.results.filter(
      (r) => r.status === 'manual' || r.status === 'notfound',
    ).length;
    setStatus(
      `${res.site}: ${filled} field${filled === 1 ? '' : 's'} filled, ${manual} to finish by hand — see the overlay on the page.`,
      'ok',
    );
  } else if (res.error === 'not-listing-page') {
    setStatus(`This is ${res.site}, but not the listing creation form.`, 'err');
  } else if (res.error === 'no-payload') {
    setStatus('No payload saved — paste it above first.', 'err');
  } else {
    setStatus(`Fill failed: ${res.error}`, 'err');
  }
});

void loadStored();
