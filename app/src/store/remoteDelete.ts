/**
 * Explicit relay deletion (CONTRACTS.md "Relay data lifecycle"): an rw-token
 * holder can remove a doc — Yjs state, token record and blobs — from a relay
 * immediately via DELETE /api/docs/:docId. Used by the forget-inventory flow
 * ("Also delete from my relays"); relays a device cannot reach right now are
 * reported as failed and left to the relay's own lease GC, which deletes
 * anything untouched for the retention window anyway.
 */
import type { Id } from '../types';
import { mergeRelayLists, relayHttpUrl } from './relays';

export interface RelayDeleteResult {
  deleted: string[];
  failed: string[];
}

/**
 * Best-effort DELETE on every listed relay, in parallel. 204 counts as
 * deleted (the endpoint is idempotent: an already-unknown doc also answers
 * 204); anything else — unreachable, 403 from a relay that got different
 * tokens — counts as failed. Never throws.
 */
export async function deleteDocFromRelays(
  docId: Id,
  rwToken: string,
  origins: string[],
): Promise<RelayDeleteResult> {
  const targets = mergeRelayLists(origins);
  const deleted: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    targets.map(async (origin) => {
      try {
        const res = await fetch(`${relayHttpUrl(origin)}/docs/${docId}`, {
          method: 'DELETE',
          headers: { 'x-token': rwToken },
        });
        (res.status === 204 ? deleted : failed).push(origin);
      } catch {
        failed.push(origin);
      }
    }),
  );
  return { deleted, failed };
}
