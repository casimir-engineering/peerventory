/**
 * Account-level relay list: pure merge planners between the device-local
 * relay list (localStorage, per-device enable/disable) and the profile doc's
 * Y.Map('relays') (shared by every device of the account).
 *
 * Semantics (see CONTRACTS.md "Account relay list"):
 * - Entries are keyed by normalized origin. A live entry means "this account
 *   uses this relay"; `removed: true` is a tombstone ("this account removed
 *   it") so a device that still has the relay locally does not resurrect it.
 * - Adding a relay on any device pushes a live entry (reviving a tombstone —
 *   an explicit add is a newer intent than an old removal).
 * - Removing a relay on any device pushes a tombstone; other devices drop it
 *   from their local list, EXCEPT their own pinned default origin (the origin
 *   the app itself is configured against stays).
 * - enable/disable is per-device only and never syncs (reachability differs
 *   per device: a LAN relay may be phone-only).
 *
 * Kept dependency-free (no localStorage/window at module scope) so the merge
 * logic is unit-testable under plain node (scripts/relays-merge.ts).
 */

/** Wire shape of one entry in the profile doc's Y.Map('relays'). */
export interface AccountRelayEntry {
  /** Normalized http(s) origin. */
  u: string;
  /** epoch ms of the last write (informational; Y.Map resolves conflicts). */
  at: number;
  /** Tombstone: the relay was removed from the account on some device. */
  removed?: boolean;
}

export interface LocalRelayEntry {
  url: string;
  enabled: boolean;
}

/**
 * Doc -> local list. Returns the origins to add to and remove from the
 * device-local list. `pendingAdds` are adds made on THIS device that have not
 * been pushed yet: a stale tombstone must not undo them.
 */
export function planRelayApply(
  docEntries: Iterable<AccountRelayEntry>,
  local: readonly LocalRelayEntry[],
  pinnedOrigin: string,
  pendingAdds: ReadonlySet<string>,
): { add: string[]; remove: string[] } {
  const localSet = new Set(local.map((l) => l.url));
  const add: string[] = [];
  const remove: string[] = [];
  for (const entry of docEntries) {
    if (!entry || typeof entry.u !== 'string' || !entry.u) continue;
    if (entry.removed) {
      if (localSet.has(entry.u) && entry.u !== pinnedOrigin && !pendingAdds.has(entry.u)) {
        remove.push(entry.u);
      }
    } else if (!localSet.has(entry.u)) {
      add.push(entry.u);
    }
  }
  return { add, remove };
}

/**
 * Local list -> doc. Returns the entries to write into the map. The first
 * push after migration simply unions the whole local list into the doc
 * (every local origin without a live doc entry gets one). Tombstoned origins
 * are only re-pushed when explicitly re-added on this device.
 */
export function planRelayPush(
  local: readonly LocalRelayEntry[],
  docEntries: ReadonlyMap<string, AccountRelayEntry>,
  pendingAdds: ReadonlySet<string>,
  pendingRemovals: ReadonlySet<string>,
  now: number,
): AccountRelayEntry[] {
  const ops: AccountRelayEntry[] = [];
  for (const l of local) {
    if (pendingRemovals.has(l.url)) continue;
    const cur = docEntries.get(l.url);
    if (cur && !cur.removed) continue;
    if (cur?.removed && !pendingAdds.has(l.url)) continue; // tombstone wins; apply() drops it locally
    ops.push({ u: l.url, at: now });
  }
  for (const url of pendingRemovals) {
    const cur = docEntries.get(url);
    if (cur?.removed) continue;
    // Tombstone even origins the doc never saw: another device may still
    // carry the origin locally and would re-push it otherwise.
    ops.push({ u: url, at: now, removed: true });
  }
  return ops;
}
