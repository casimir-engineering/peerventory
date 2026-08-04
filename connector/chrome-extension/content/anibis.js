/**
 * Anibis.ch field map. Anibis is a Swiss classifieds site (FR/DE/IT UI);
 * every matcher therefore carries the three languages plus English. The
 * listing form lives under /fr/listings/new (verified live 2026-08; older
 * redesigns used /fr/publier, /de/inserieren — the page check stays loose:
 * any anibis page with a visible title/price form counts).
 *
 * The live form is a MUI/React SPA that reveals the detail fields (NPA,
 * shipping, price, title=name "subject", description=name "body") only after
 * a category is picked in a cascading menu — hence formReady(): the fill
 * engine waits for the title field and shows a "choose a category" hint
 * until then. The category itself stays manual.
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

  // Live form 2026-08: title is <input name="subject"> (label "Titre *").
  const TITLE_SPEC = {
    selectors: ['input[name="subject"]', 'input[name="title"]', 'input#title'],
    aria: /titre|titel|titolo|title/i,
    placeholder: /titre|titel|titolo|title/i,
    label: /^\s*(titre|titel|titolo|title)/i,
    name: /^(title|subject)$/i,
    kind: 'text',
  };

  function buildFields(item) {
    return [
      {
        key: 'title',
        label: 'Title',
        spec: TITLE_SPEC,
        value: () => item.title || null,
      },
      {
        // Live form 2026-08: <textarea name="body"> (label "Description *").
        key: 'description',
        label: 'Description',
        spec: {
          selectors: ['textarea[name="body"]', 'textarea[name="description"]', 'textarea'],
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
    // Loose on purpose: any anibis page where a listing form is (or will be)
    // visible. /listings/new is the current path; the field probe covers
    // future path changes.
    isListingPage: () =>
      /(^|\.)anibis\.ch$/.test(location.hostname) &&
      (/(listings\/new|publier|inserieren|pubblicare|create|insert)/i.test(location.pathname) ||
        Boolean(pv.findControl(TITLE_SPEC))),
    // The detail fields only exist once a category has been chosen in the
    // cascading menu; the fill engine polls this and hints the user.
    formReady: () => Boolean(pv.findControl(TITLE_SPEC)),
    waitHint:
      'Choisissez une catégorie — les champs (titre, prix, description) se rempliront automatiquement. / Choose a category and the fields will fill themselves.',
    buildFields,
  };

  // Exposed for the local test fixtures (which have no chrome.runtime).
  window.__pvSiteAnibis = site;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    pv.initSite(site);
  }
})();
