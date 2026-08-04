/**
 * Anibis.ch field map. Anibis is a Swiss classifieds site (FR/DE/IT UI);
 * every matcher therefore carries the three languages plus English. The
 * listing form lives under /fr/publier, /de/inserieren (paths have changed
 * across redesigns, so the page check is deliberately loose: any anibis page
 * with a visible title/price form counts).
 *
 * When Anibis redesigns the form, update the regexes/selectors below — the
 * strategies are tried in order (selectors, aria, placeholder, label, name).
 */

(() => {
  'use strict';
  const pv = window.__pv;
  if (!pv || window.__pvAnibis) return;
  window.__pvAnibis = true;

  /** Anibis descriptions: prefer the translation matching the page language. */
  function descriptionFor(item) {
    const lang = (document.documentElement.lang || '').toLowerCase();
    const tr = item.descriptionTranslations || {};
    if (lang.startsWith('de') && tr.de) return tr.de;
    if (lang.startsWith('fr') && tr.fr) return tr.fr;
    return item.description || null;
  }

  function buildFields(item) {
    return [
      {
        key: 'title',
        label: 'Title',
        spec: {
          selectors: ['input[name="title"]', 'input[name="subject"]', 'input#title'],
          aria: /titre|titel|titolo|title/i,
          placeholder: /titre|titel|titolo|title/i,
          label: /^\s*(titre|titel|titolo|title)/i,
          name: /^(title|subject)$/i,
          kind: 'text',
        },
        value: () => item.title || null,
      },
      {
        key: 'description',
        label: 'Description',
        spec: {
          selectors: ['textarea[name="description"]', 'textarea[name="body"]', 'textarea'],
          aria: /description|beschreibung|descrizione/i,
          placeholder: /d[ée]cri|beschreib|descri/i,
          label: /^\s*(description|beschreibung|descrizione)/i,
          name: /^(description|body|text)$/i,
          kind: 'multiline',
        },
        value: () => descriptionFor(item),
      },
      {
        key: 'price',
        label: 'Price',
        spec: {
          selectors: ['input[name="price"]', 'input[name="priceAmount"]', 'input#price'],
          aria: /prix|preis|prezzo|price/i,
          placeholder: /prix|preis|prezzo|price|chf/i,
          label: /^\s*(prix|preis|prezzo|price)/i,
          name: /price/i,
          kind: 'text',
        },
        value: () => (item.priceAmount > 0 ? item.priceAmount : null),
        note: () =>
          item.priceCurrency && item.priceCurrency !== 'CHF'
            ? `Price is in ${item.priceCurrency} — Anibis lists in CHF, convert before publishing.`
            : null,
      },
      {
        // The Anibis category picker is a multi-step dialog, not a plain
        // control — automating it would break on every redesign.
        key: 'category',
        label: 'Category',
        manualOnly: true,
        value: () => item.category || null,
      },
      {
        key: 'condition',
        label: 'Condition',
        spec: {
          selectors: ['select[name="condition"]', 'select[name="state"]'],
          label: /^\s*([ée]tat|zustand|condizione|condition)/i,
          name: /condition|state/i,
          kind: 'select',
        },
        value: () => item.condition || null,
      },
    ];
  }

  const site = {
    id: 'anibis',
    label: 'Anibis',
    // Loose on purpose: any anibis page where a listing form is visible.
    isListingPage: () =>
      /(^|\.)anibis\.ch$/.test(location.hostname) &&
      (/(publier|inserieren|pubblicare|create|insert)/i.test(location.pathname) ||
        Boolean(pv.findControl({ name: /^(title|subject)$/i, kind: 'text' }))),
    buildFields,
  };

  // Exposed for the local test fixtures (which have no chrome.runtime).
  window.__pvSiteAnibis = site;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    pv.initSite(site);
  }
})();
