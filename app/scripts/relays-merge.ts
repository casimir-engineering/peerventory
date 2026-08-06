/**
 * Unit test for the account relay list merge planners (store/accountRelays.ts):
 * doc -> device apply (tombstones, pinned default, pending adds) and
 * device -> doc push (migration union, tombstone semantics, removals).
 *
 * Run: npm run test:store (vite-bundles to scripts/dist, runs under node).
 */
import assert from 'node:assert/strict';
import {
  planRelayApply,
  planRelayPush,
  type AccountRelayEntry,
  type LocalRelayEntry,
} from '../src/store/accountRelays';

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.info(`ok - ${label}`);
  } catch (error) {
    console.error(`FAIL - ${label}`);
    throw error;
  }
}

const NOW = 1_700_000_000_000;
const PINNED = 'https://default.example';

const local = (...urls: string[]): LocalRelayEntry[] =>
  urls.map((url) => ({ url, enabled: true }));

const docMap = (...entries: AccountRelayEntry[]): Map<string, AccountRelayEntry> =>
  new Map(entries.map((e) => [e.u, e]));

/* ---------- planRelayApply (doc -> device) ---------- */

check('apply: live doc entries missing locally are added', () => {
  const plan = planRelayApply(
    [{ u: 'https://a.example', at: 1 }, { u: PINNED, at: 1 }],
    local(PINNED),
    PINNED,
    new Set(),
  );
  assert.deepEqual(plan, { add: ['https://a.example'], remove: [] });
});

check('apply: tombstones remove local entries', () => {
  const plan = planRelayApply(
    [{ u: 'https://a.example', at: 2, removed: true }],
    local(PINNED, 'https://a.example'),
    PINNED,
    new Set(),
  );
  assert.deepEqual(plan, { add: [], remove: ['https://a.example'] });
});

check('apply: a tombstone never removes the pinned default origin', () => {
  const plan = planRelayApply(
    [{ u: PINNED, at: 2, removed: true }],
    local(PINNED),
    PINNED,
    new Set(),
  );
  assert.deepEqual(plan, { add: [], remove: [] });
});

check('apply: a stale tombstone does not undo a pending local add', () => {
  const plan = planRelayApply(
    [{ u: 'https://a.example', at: 2, removed: true }],
    local(PINNED, 'https://a.example'),
    PINNED,
    new Set(['https://a.example']),
  );
  assert.deepEqual(plan, { add: [], remove: [] });
});

check('apply: converged state is a no-op', () => {
  const plan = planRelayApply(
    [
      { u: PINNED, at: 1 },
      { u: 'https://a.example', at: 1 },
      { u: 'https://gone.example', at: 2, removed: true },
    ],
    local(PINNED, 'https://a.example'),
    PINNED,
    new Set(),
  );
  assert.deepEqual(plan, { add: [], remove: [] });
});

check('apply: malformed doc entries are ignored', () => {
  const junk = [
    null,
    { at: 1 },
    { u: '', at: 1 },
  ] as unknown as AccountRelayEntry[];
  const plan = planRelayApply(junk, local(PINNED), PINNED, new Set());
  assert.deepEqual(plan, { add: [], remove: [] });
});

/* ---------- planRelayPush (device -> doc) ---------- */

check('push: first run unions the whole local list into an empty doc (migration)', () => {
  const ops = planRelayPush(
    local(PINNED, 'https://a.example'),
    docMap(),
    new Set(),
    new Set(),
    NOW,
  );
  assert.deepEqual(ops, [
    { u: PINNED, at: NOW },
    { u: 'https://a.example', at: NOW },
  ]);
});

check('push: origins with a live doc entry are not re-pushed', () => {
  const ops = planRelayPush(
    local(PINNED),
    docMap({ u: PINNED, at: 1 }),
    new Set(),
    new Set(),
    NOW,
  );
  assert.deepEqual(ops, []);
});

check('push: a tombstoned origin is NOT resurrected by mere local presence', () => {
  const ops = planRelayPush(
    local(PINNED, 'https://a.example'),
    docMap({ u: PINNED, at: 1 }, { u: 'https://a.example', at: 2, removed: true }),
    new Set(),
    new Set(),
    NOW,
  );
  assert.deepEqual(ops, []);
});

check('push: an explicit re-add on this device revives a tombstone', () => {
  const ops = planRelayPush(
    local(PINNED, 'https://a.example'),
    docMap({ u: PINNED, at: 1 }, { u: 'https://a.example', at: 2, removed: true }),
    new Set(['https://a.example']),
    new Set(),
    NOW,
  );
  assert.deepEqual(ops, [{ u: 'https://a.example', at: NOW }]);
});

check('push: a pending removal writes a tombstone and wins over local presence', () => {
  const ops = planRelayPush(
    local(PINNED),
    docMap({ u: PINNED, at: 1 }, { u: 'https://a.example', at: 1 }),
    new Set(),
    new Set(['https://a.example']),
    NOW,
  );
  assert.deepEqual(ops, [{ u: 'https://a.example', at: NOW, removed: true }]);
});

check('push: removal of an origin the doc never saw still tombstones it', () => {
  const ops = planRelayPush(
    local(PINNED),
    docMap({ u: PINNED, at: 1 }),
    new Set(),
    new Set(['https://never.example']),
    NOW,
  );
  assert.deepEqual(ops, [{ u: 'https://never.example', at: NOW, removed: true }]);
});

check('push: already-tombstoned removals are not re-written', () => {
  const ops = planRelayPush(
    local(PINNED),
    docMap({ u: 'https://a.example', at: 2, removed: true }, { u: PINNED, at: 1 }),
    new Set(),
    new Set(['https://a.example']),
    NOW,
  );
  assert.deepEqual(ops, []);
});

/* ---------- convergence round-trip ---------- */

check('round-trip: two devices converge on add + remove', () => {
  // Device 1 (pinned default D) adds relay A; device 2 (same default) removes B.
  const doc = docMap({ u: PINNED, at: 1 }, { u: 'https://b.example', at: 1 });

  // Device 1 pushes its add.
  for (const op of planRelayPush(
    local(PINNED, 'https://a.example'),
    doc,
    new Set(['https://a.example']),
    new Set(),
    NOW,
  )) {
    doc.set(op.u, op);
  }
  // Device 2 pushes its removal.
  for (const op of planRelayPush(
    local(PINNED),
    doc,
    new Set(),
    new Set(['https://b.example']),
    NOW + 1,
  )) {
    doc.set(op.u, op);
  }

  // Both devices now apply the doc.
  const dev1 = planRelayApply(
    doc.values(),
    local(PINNED, 'https://a.example', 'https://b.example'),
    PINNED,
    new Set(),
  );
  assert.deepEqual(dev1, { add: [], remove: ['https://b.example'] });

  const dev2 = planRelayApply(doc.values(), local(PINNED), PINNED, new Set());
  assert.deepEqual(dev2, { add: ['https://a.example'], remove: [] });
});

console.info('relays-merge test passed');
