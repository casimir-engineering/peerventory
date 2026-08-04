/**
 * SmartCombo options for country of origin. The stored value stays what the
 * customs exports use today: the full English name as free text (the field is
 * non-strict), so the canonical value of every ISO option is its display name.
 */

import type { ComboOption } from './combo';

/** ISO 3166-1 alpha-2. */
const ISO_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO ' +
  'BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ ' +
  'DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP ' +
  'GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG ' +
  'KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML ' +
  'MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE ' +
  'PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL ' +
  'SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM ' +
  'US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

/** Common short forms that are not part of the DisplayNames label. */
const COUNTRY_ALIASES: Record<string, string[]> = {
  US: ['usa', 'america'],
  GB: ['uk', 'britain', 'england'],
  AE: ['uae'],
};

let isoCache: ComboOption[] | null = null;

function isoCountryOptions(): ComboOption[] {
  if (isoCache) return isoCache;
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    names = null;
  }
  isoCache = ISO_CODES.map((code) => {
    let name = code;
    try {
      name = names?.of(code) ?? code;
    } catch {
      name = code;
    }
    return {
      value: name,
      label: name,
      keywords: [code.toLowerCase(), ...(COUNTRY_ALIASES[code] ?? [])],
    };
  });
  return isoCache;
}

/**
 * History and already-used values first (they may be free text or codes),
 * then the full ISO list, deduped case-insensitively.
 */
export function countryComboOptions(preferredFirst: string[]): ComboOption[] {
  const iso = isoCountryOptions();
  const byName = new Map(iso.map((o) => [o.value.toLowerCase(), o]));
  const used = new Set<string>();
  const out: ComboOption[] = [];
  for (const raw of preferredFirst) {
    const clean = raw.trim();
    if (clean === '' || used.has(clean.toLowerCase())) continue;
    used.add(clean.toLowerCase());
    out.push(byName.get(clean.toLowerCase()) ?? { value: clean, label: clean });
  }
  for (const option of iso) {
    if (used.has(option.value.toLowerCase())) continue;
    out.push(option);
  }
  return out;
}
