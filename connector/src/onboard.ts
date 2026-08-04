/**
 * Shared profile-import path: every onboarding input (pasted link, uploaded /
 * dropped / clipboard QR image, camera scan) decodes to the same backup URL
 * text and funnels through importProfileText().
 */

import { buildProfile, parseProfileLink } from './backup';
import { getCache, putCachedInventory, setProfile } from './storage';
import type { Profile } from './types';

export type ImportResult =
  | { ok: true; profile: Profile; withKeys: number }
  | { ok: false; reason: 'not-a-link' | 'needs-origin' | 'bad-payload' };

export async function importProfileText(
  text: string,
  fallbackOrigin?: string,
): Promise<ImportResult> {
  const parsed = parseProfileLink(text);
  if (!parsed) return { ok: false, reason: 'not-a-link' };
  if (!parsed.origin && !fallbackOrigin) return { ok: false, reason: 'needs-origin' };
  const profile = buildProfile(text, fallbackOrigin);
  if (!profile) return { ok: false, reason: 'bad-payload' };

  await setProfile(profile);
  // Placeholder cache entries so the inventories show up before the first sync.
  const cache = await getCache();
  for (const h of profile.handles) {
    if (!cache[h.docId]) {
      await putCachedInventory({
        docId: h.docId,
        name: h.name ?? h.docId,
        syncedAt: 0,
        items: [],
      });
    }
  }
  return { ok: true, profile, withKeys: profile.handles.filter((h) => h.key).length };
}

export function connectedMessage(result: Extract<ImportResult, { ok: true }>): string {
  const n = result.profile.handles.length;
  return `Connected: ${n} inventor${n === 1 ? 'y' : 'ies'} (${result.withKeys} decryptable).`;
}
