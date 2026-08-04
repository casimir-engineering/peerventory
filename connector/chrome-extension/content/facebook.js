/**
 * Facebook Marketplace field map (facebook.com/marketplace/create/item).
 *
 * Facebook is a single-page app, so the manifest injects this on all of
 * facebook.com and the fill only runs when the URL is a marketplace create
 * page at that moment. The form is fully React-controlled (values written
 * through native setters + input events, see fill-core.js) and its labels
 * are localized — matchers cover EN/FR/DE/IT.
 *
 * HONESTY NOTE (also in the README): Facebook actively detects automation.
 * This script performs a single assisted fill on a page the user opened and
 * is looking at — no navigation, no submission, no background activity — but
 * category/condition dropdowns and publishing are intentionally left to the
 * user.
 */

(() => {
  'use strict';
  const pv = window.__pv;
  if (!pv || window.__pvFacebook) return;
  window.__pvFacebook = true;

  function buildFields(item) {
    return [
      {
        key: 'title',
        label: 'Title',
        spec: {
          aria: /^(title|titre|titel|titolo)$/i,
          label: /^\s*(title|titre|titel|titolo)\s*$/i,
          placeholder: /^(title|titre|titel|titolo)$/i,
          kind: 'text',
        },
        value: () => item.title || null,
      },
      {
        key: 'price',
        label: 'Price',
        spec: {
          aria: /^(price|prix|preis|prezzo)$/i,
          label: /^\s*(price|prix|preis|prezzo)\s*$/i,
          placeholder: /^(price|prix|preis|prezzo)$/i,
          kind: 'text',
        },
        // FB wants a bare number in the account's own currency.
        value: () => (item.priceAmount > 0 ? String(Math.round(item.priceAmount)) : null),
        note: () =>
          item.priceCurrency
            ? `Amount assumes your Marketplace currency is ${item.priceCurrency} — adjust if not.`
            : null,
      },
      {
        key: 'description',
        label: 'Description',
        spec: {
          aria: /^(description|beschreibung|descrizione)$/i,
          label: /^\s*(description|beschreibung|descrizione)\s*$/i,
          kind: 'multiline',
        },
        value: () => item.description || null,
      },
      {
        // Category and condition are custom role=combobox dropdowns; clicking
        // through them is exactly the scripted interaction FB's anti-bot
        // heuristics look for, so they stay manual with the value as a hint.
        key: 'category',
        label: 'Category',
        manualOnly: true,
        value: () => item.category || null,
      },
      {
        key: 'condition',
        label: 'Condition',
        manualOnly: true,
        value: () => item.condition || null,
      },
    ];
  }

  const site = {
    label: 'Facebook Marketplace',
    isListingPage: () =>
      /(^|\.)facebook\.com$/.test(location.hostname) &&
      location.pathname.startsWith('/marketplace/create'),
    buildFields,
  };

  // Exposed for the local test fixtures (which have no chrome.runtime).
  window.__pvSiteFacebook = site;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    pv.initSite(site);
  }
})();
