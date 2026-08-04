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
 *
 * Photos staged by the popup are attached through the create form's hidden
 * <input type="file"> via DataTransfer (the standard mechanism); the fill
 * engine caps at maxPhotos (Marketplace item listings take 10).
 *
 * Verified live (logged-in facebook.com, 2026-08): title and price are
 * label-wrapped inputs (<label>Titre<input></label>, no aria/placeholder),
 * photos attach through the hidden image file input, and the Description
 * textarea only MOUNTS after the collapsed "More details" ("Plus de
 * détails") section is expanded — prepare() below clicks that disclosure.
 * Category ("Catégorie") and condition ("État") are custom dropdowns and
 * stay manual on purpose.
 */

(() => {
  'use strict';
  const pv = window.__pv;
  if (!pv || window.__pvFacebook) return;
  window.__pvFacebook = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const TITLE_SPEC = {
    aria: /^(title|titre|titel|titolo)$/i,
    label: /^\s*(title|titre|titel|titolo)\s*$/i,
    placeholder: /^(title|titre|titel|titolo)$/i,
    kind: 'text',
  };

  const DESC_SPEC = {
    aria: /^(description|beschreibung|descrizione)$/i,
    label: /^\s*(description|beschreibung|descrizione)\s*$/i,
    kind: 'multiline',
  };

  /** The collapsed disclosure hiding the Description field (live 2026-08:
   * a div[role=button] whose text starts with the localized section name;
   * the subtitle text is concatenated after it, hence the ^ anchor only). */
  function moreDetailsToggle() {
    return (
      [...document.querySelectorAll('[role="button"]')].find((el) =>
        /^(more details|plus de d[ée]tails|weitere (angaben|details)|altri dettagli)/i.test(
          (el.textContent || '').trim(),
        ),
      ) || null
    );
  }

  function buildFields(item) {
    return [
      {
        key: 'title',
        label: 'Title',
        spec: TITLE_SPEC,
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
        spec: DESC_SPEC,
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
    id: 'facebook',
    label: 'Facebook Marketplace',
    isListingPage: () =>
      /(^|\.)facebook\.com$/.test(location.hostname) &&
      location.pathname.startsWith('/marketplace/create'),
    // The SPA renders the form well after document_idle; wait for the title
    // field instead of misreporting every field as "not found".
    formReady: () => Boolean(pv.findControl(TITLE_SPEC)),
    waitHint: 'Waiting for the Marketplace form to load — if it never does, reload and click Sell again.',
    // The Description textarea only mounts once the collapsed "More details"
    // section is expanded (verified live 2026-08). Expand it here so the
    // description can fill; on any failure the description row just reports
    // "not found" and stays manual, like before.
    prepare: async (item) => {
      if (!item.description) return [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (pv.findControl(DESC_SPEC)) return []; // already mounted
        const toggle = moreDetailsToggle();
        if (toggle) {
          try {
            toggle.scrollIntoView({ block: 'center' });
          } catch {
            /* scroll is best-effort */
          }
          toggle.click();
          const mountBy = Date.now() + 5_000;
          while (Date.now() < mountBy && !pv.findControl(DESC_SPEC)) await sleep(250);
          return [];
        }
        await sleep(400);
      }
      return [];
    },
    // The create form's photo input accepts image/* (and video); hidden
    // behind the "Add photos" tile. Verified live 2026-08.
    photoInput: () =>
      document.querySelector('input[type="file"][accept*="image"]') ||
      document.querySelector('input[type="file"]'),
    maxPhotos: () => 10,
    buildFields,
  };

  // Exposed for the local test fixtures (which have no chrome.runtime).
  window.__pvSiteFacebook = site;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    pv.initSite(site);
  }
})();
