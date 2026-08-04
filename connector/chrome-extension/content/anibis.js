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
 * until then.
 *
 * The category menu itself is automated in prepare(): the available options
 * are scraped from the live DOM level by level (li[role="menuitem"], the
 * submenu replaces the list in place with a leading "Retour" row, verified
 * live 2026-08) and matched against the item's free-text category using
 * accent-insensitive tokens plus the CATEGORY_SYNONYMS table below. When no
 * option matches confidently, the menu is closed again and the manual flow
 * (waiting hint) takes over — a wrong category is worse than no category.
 *
 * Photos: the upload area exists before a category is picked; it is a hidden
 * <input type="file" aria-label="Photos" multiple accept="image/...">. The
 * "0/5 photos" counter in the page text tells us how many more it accepts.
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

  /* ---------------------------------------------------------------- */
  /* Category auto-pick                                                 */
  /* ---------------------------------------------------------------- */

  /** Lowercase, strip accents, collapse punctuation ("Déco & Accessoires" -> "deco accessoires"). */
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Free-text app categories (EN/FR/DE) -> Anibis category path. Each path
   * segment is fuzzy-matched (normalized containment) against the scraped
   * menu labels of that level, so a site rename like "Jardin & Outils" ->
   * "Jardin, Outils & Machines" keeps working. First matching entry wins.
   * Keys match whole tokens of the item's category (plural-insensitive).
   */
  const CATEGORY_SYNONYMS = [
    { keys: ['lighting', 'light', 'lamp', 'lampe', 'luminaire', 'leuchte', 'lustre', 'eclairage', 'beleuchtung', 'lampadaire'], path: ['maison', 'luminaires'] },
    { keys: ['furniture', 'meuble', 'mobilier', 'moebel', 'mobel', 'sofa', 'canape', 'armoire', 'table', 'chaise', 'fauteuil', 'etagere', 'commode', 'kommode', 'schrank', 'regal'], path: ['maison', 'mobilier'] },
    { keys: ['appliance', 'electromenager', 'kitchen', 'cuisine', 'ustensile', 'haushalt', 'frigo', 'fridge', 'aspirateur', 'vacuum'], path: ['maison', 'electromenager'] },
    { keys: ['deco', 'decor', 'decoration', 'dekoration', 'vase', 'tapis', 'carpet', 'rug', 'coussin', 'rideau'], path: ['maison', 'deco'] },
    { keys: ['electronic', 'electronique', 'elektronik', 'informatique', 'computer', 'ordinateur', 'laptop', 'notebook', 'macbook', 'imac', 'pc', 'tablet', 'tablette', 'ipad', 'imprimante', 'printer', 'drucker', 'ecran', 'monitor', 'screen', 'clavier', 'keyboard', 'souris', 'router', 'routeur', 'serveur', 'server', 'nas', 'disque', 'ssd'], path: ['informatique'] },
    { keys: ['phone', 'telephone', 'telephonie', 'telefon', 'smartphone', 'iphone', 'natel', 'handy', 'gps', 'navigation'], path: ['telephonie'] },
    { keys: ['tv', 'television', 'fernseher', 'audio', 'hifi', 'stereo', 'speaker', 'enceinte', 'lautsprecher', 'soundbar', 'casque', 'headphone', 'kopfhorer', 'ampli', 'amplifier', 'amplificateur', 'platine', 'turntable', 'beamer', 'projecteur', 'projector'], path: ['tv audio'] },
    { keys: ['photo', 'camera', 'video', 'objectif', 'lens', 'drone', 'gopro', 'reflex'], path: ['photo video'] },
    { keys: ['tool', 'outil', 'outillage', 'werkzeug', 'garden', 'jardin', 'garten', 'perceuse', 'drill', 'bohrmaschine', 'tondeuse', 'scie', 'saw', 'marteau', 'hammer', 'echelle', 'ladder', 'visseuse', 'ponceuse'], path: ['jardin outils'] },
    { keys: ['toy', 'jouet', 'spielzeug', 'lego', 'playmobil', 'puzzle', 'modelisme', 'jeu', 'game', 'spiel', 'peluche'], path: ['jouets'] },
    { keys: ['book', 'livre', 'buch', 'bucher', 'bd', 'comic', 'manga', 'roman', 'magazine', 'revue'], path: ['livres'] },
    { keys: ['music', 'musique', 'musik', 'instrument', 'guitare', 'guitar', 'gitarre', 'piano', 'synthesizer', 'vinyle', 'vinyl', 'schallplatte'], path: ['musique'] },
    { keys: ['sport', 'outdoor', 'fitness', 'velo', 'bike', 'bicycle', 'fahrrad', 'vtt', 'trottinette', 'skateboard', 'ski', 'snowboard', 'camping', 'tente', 'tent', 'zelt', 'randonnee', 'tennis', 'golf'], path: ['sport'] },
    { keys: ['clothing', 'clothes', 'vetement', 'kleider', 'kleidung', 'fashion', 'shoe', 'chaussure', 'schuhe', 'basket', 'sneaker', 'veste', 'jacket', 'jacke', 'manteau', 'pantalon', 'robe', 'dress', 'pull', 'shirt', 'tshirt', 'jeans', 'sac', 'bag', 'tasche', 'montre', 'watch', 'uhr', 'bijou', 'jewelry', 'schmuck'], path: ['vetements'] },
    { keys: ['baby', 'bebe', 'enfant', 'kind', 'kid', 'poussette', 'kinderwagen', 'stroller'], path: ['bebe enfant'] },
    { keys: ['animal', 'animaux', 'pet', 'tier', 'chien', 'dog', 'hund', 'chat', 'katze', 'aquarium'], path: ['animaux'] },
    { keys: ['car', 'auto', 'voiture', 'vehicule', 'moto', 'motorrad', 'scooter', 'roller', 'pneu', 'tire', 'reifen', 'remorque'], path: ['vehicules'] },
    { keys: ['art', 'antique', 'antiquite', 'antiquitat', 'tableau', 'painting', 'gemalde', 'sculpture'], path: ['art antiquites'] },
    { keys: ['collection', 'collectible', 'sammeln', 'timbre', 'stamp', 'briefmarke', 'piece', 'coin', 'munze'], path: ['objets de collection'] },
    { keys: ['office', 'bureau', 'buro', 'commerce'], path: ['bureau commerce'] },
    { keys: ['film', 'movie', 'dvd', 'bluray'], path: ['films'] },
    { keys: ['ticket', 'billet', 'bon', 'voucher', 'gutschein'], path: ['billetterie'] },
  ];

  /** Whole-token match, tolerant of trailing plural "s" ("lamps" ~ "lamp"). */
  function tokenMatches(token, key) {
    return token === key || token === `${key}s` || `${token}s` === key;
  }

  function synonymsPath(catNorm) {
    const tokens = catNorm.split(' ');
    for (const entry of CATEGORY_SYNONYMS) {
      if (entry.keys.some((k) => tokens.some((t) => tokenMatches(t, k)))) return entry.path;
    }
    return null;
  }

  /** 3 = exact, 2 = one label contains the other. Below 2 is "not confident". */
  function matchScore(labelNorm, targetNorm) {
    if (!labelNorm || !targetNorm) return 0;
    if (labelNorm === targetNorm) return 3;
    if (labelNorm.includes(targetNorm) || targetNorm.includes(labelNorm)) return 2;
    return 0;
  }

  /** Words too generic to identify a category on their own (second pass). */
  const STOPWORDS = new Set([
    'et', 'de', 'des', 'du', 'la', 'le', 'les', 'un', 'une', 'pour', 'sans', 'avec',
    'and', 'the', 'for', 'with', 'und', 'mit', 'fur',
    'autre', 'autres', 'divers', 'other', 'misc', 'stuff', 'via',
  ]);

  function significantWords(s) {
    return s.split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  }

  const BACK_RE = /^(retour|zuruck|indietro|back)$/;

  /** MUI keeps closed menus mounted with visibility:hidden (which still has
   * geometry), so checkVisibility — not getBoundingClientRect — is required
   * to tell a really-open menu from a stale closed one (verified live). */
  function visibleMenuItems() {
    return [...document.querySelectorAll('li[role="menuitem"]')].filter((li) =>
      typeof li.checkVisibility === 'function'
        ? li.checkVisibility({ visibilityProperty: true, opacityProperty: true })
        : li.getBoundingClientRect().width > 0,
    );
  }

  function menuSignature(items) {
    return items.map((li) => norm(li.textContent)).join('|');
  }

  function bestOption(items, targetNorm) {
    // Pass 1: exact / containment.
    let best = null;
    let bestScore = 0;
    for (const li of items) {
      const label = norm(li.textContent);
      if (BACK_RE.test(label)) continue;
      const s = matchScore(label, targetNorm);
      if (s > bestScore) {
        best = li;
        bestScore = s;
      }
    }
    if (bestScore >= 2) return best;
    // Pass 2, fuzzier but safe: a significant whole word of the target
    // matches a significant word of a label ("ordinateur portable" ~
    // "Ordinateurs portables") — only when EXACTLY ONE option matches, so
    // an ambiguous word can never pick a wrong category.
    const targetWords = significantWords(targetNorm);
    if (targetWords.length === 0) return null;
    const hits = [];
    for (const li of items) {
      const label = norm(li.textContent);
      if (BACK_RE.test(label)) continue;
      const labelWords = significantWords(label);
      if (targetWords.some((t) => labelWords.some((l) => tokenMatches(t, l)))) hits.push(li);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  /** MUI menus listen for real mouse events; .click() alone also works but
   * mousedown/up first is closer to a human interaction. */
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function categoryOpener() {
    return (
      [...document.querySelectorAll('button')].find((b) =>
        /choisir une cat|kategorie|scegli.*categor|choose.*categor/i.test(b.textContent || ''),
      ) || null
    );
  }

  function closeMenu() {
    const items = visibleMenuItems();
    if (items.length === 0) return;
    items[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    const backdrop = document.querySelector('.MuiBackdrop-root');
    if (backdrop) backdrop.click();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(cond, timeoutMs, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = cond();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  /** The category path picked by prepare(); makes buildFields skip the manual
   * category hint. */
  let autoPickedPath = null;
  /** Why the auto-pick stood down: 'no-category' | 'no-match' | 'no-menu'.
   * Drives the waiting hint so the fallback never looks like a silent bug. */
  let autoPickFail = null;

  /**
   * Click through the cascading category menu, matching each level's scraped
   * options against the synonyms path (or the raw category text). Returns the
   * human-readable path on success, null when unsure (menu closed again).
   */
  async function autoPickCategory(item) {
    const catNorm = norm(item.category);
    if (!catNorm) {
      autoPickFail = 'no-category';
      return null;
    }
    // The SPA may still be rendering when the fill starts (pending flow).
    const opener = await waitFor(() => site.formReady() || categoryOpener(), 10_000, 300);
    if (site.formReady()) return null; // already picked
    if (!opener) {
      autoPickFail = 'no-menu';
      return null;
    }
    const path = synonymsPath(catNorm);

    realClick(opener);
    if (!(await waitFor(() => visibleMenuItems().length > 0, 5_000))) {
      autoPickFail = 'no-menu';
      return null;
    }

    const picked = [];
    for (let depth = 0; depth < 5; depth++) {
      const items = visibleMenuItems();
      const beforeSig = menuSignature(items);
      // Segment of the synonyms path for this level, else the raw category
      // text (covers items whose category literally names an Anibis option).
      const target = path && depth < path.length ? path[depth] : catNorm;
      let choice = bestOption(items, target);
      if (!choice && target !== catNorm) choice = bestOption(items, catNorm);
      if (!choice) {
        closeMenu();
        autoPickFail = 'no-match';
        return null;
      }
      picked.push((choice.textContent || '').trim());
      realClick(choice);
      const outcome = await waitFor(() => {
        if (site.formReady()) return 'done';
        const now = visibleMenuItems();
        return now.length > 0 && menuSignature(now) !== beforeSig ? 'descended' : null;
      }, 6_000);
      if (outcome === 'done') {
        autoPickedPath = picked.join(' › ');
        return autoPickedPath;
      }
      if (!outcome) {
        closeMenu();
        autoPickFail = 'no-menu';
        return null;
      }
    }
    closeMenu();
    autoPickFail = 'no-match';
    return null;
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
      // Category: auto-picked in prepare() when the item's category maps
      // confidently onto the menu (that run adds its own overlay row); the
      // manual hint below only appears when the auto-pick stood down.
      ...(autoPickedPath
        ? []
        : [
            {
              key: 'category',
              label: 'Category',
              manualOnly: true,
              value: () => item.category || null,
              note: () =>
                autoPickFail === 'no-match' && item.category
                  ? `No Anibis category matched “${item.category}” — pick the closest one in the form.`
                  : null,
            },
          ]),
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
    // Shown while the fill waits for the category to be picked manually.
    // Says WHY the auto-pick didn't happen so the fallback never reads as
    // "the extension did nothing".
    waitHint: (item) => {
      if (autoPickFail === 'no-match' && item.category) {
        return (
          `Pas de catégorie Anibis correspondant à « ${item.category} » — choisissez-la ` +
          `manuellement, les champs se rempliront automatiquement ensuite. / ` +
          `No Anibis category matches “${item.category}” — pick one manually and the ` +
          `fields will fill automatically right after.`
        );
      }
      if (autoPickFail === 'no-category') {
        return (
          `L'objet n'a pas de catégorie dans Peerventory — choisissez-en une manuellement, ` +
          `les champs se rempliront automatiquement ensuite. / ` +
          `This item has no category in Peerventory — pick one manually and the fields ` +
          `will fill automatically right after.`
        );
      }
      return (
        'Choisissez une catégorie — les champs (titre, prix, description) se rempliront ' +
        'automatiquement. / Choose a category and the fields will fill themselves.'
      );
    },
    // Automated category pick; [] on failure = fall back to the waiting hint.
    prepare: async (item) => {
      const path = await autoPickCategory(item);
      if (!path) return [];
      return [
        {
          key: 'category',
          label: 'Category',
          status: 'filled',
          value: path,
          // The pick is a heuristic — surface it so the user double-checks.
          note: `Auto-picked: ${path} — verify before publishing.`,
        },
      ];
    },
    // Hidden <input type="file" aria-label="Photos"> behind the dropzone.
    photoInput: () =>
      document.querySelector('input[type="file"][accept*="image"]') ||
      document.querySelector('input[type="file"]'),
    // "0/5 photos" (free tier; 15 with a subscription) in the page text.
    maxPhotos: () => {
      const m = (document.body.innerText || '').match(/(\d+)\s*\/\s*(\d+)\s*photos/i);
      return m ? Math.max(0, Number(m[2]) - Number(m[1])) : 5;
    },
    buildFields,
  };

  // Exposed for the local test fixtures (which have no chrome.runtime).
  window.__pvSiteAnibis = site;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    pv.initSite(site);
  }
})();
