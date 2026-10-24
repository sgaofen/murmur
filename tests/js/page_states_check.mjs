// Checks app/src/utils/pageStates.ts: a failed request never shows up as
// "no data yet" (#48 review items 5 and 6).
// Run by tests/test_page_states_frontend.py via `node --experimental-strip-types`
// (Node >= 22.6) or `bun`; by hand: `bun tests/js/page_states_check.mjs`.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { homeHasNoData, signalsOutcome } = await import(
  pathToFileURL(join(root, 'app', 'src', 'utils', 'pageStates.ts')).href);

const failures = [];
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${name}: ${g} != ${w}`);
};

// Home: the whole-page empty state.
const empty = { totalContacts: 0, topFriends: 0, friendsLoaded: true, friendsCount: 0, friendsError: null, search: '', tab: 'private' };
eq('home: really empty', homeHasNoData(empty), true);
eq('home: list failed → not "no data"', homeHasNoData({ ...empty, friendsError: new Error('API /api/friends: 500') }), false);
eq('home: list failed with a code', homeHasNoData({ ...empty, friendsError: { code: 'INTERNAL_ERROR' } }), false);
eq('home: list still loading', homeHasNoData({ ...empty, friendsLoaded: false }), false);
eq('home: has contacts', homeHasNoData({ ...empty, totalContacts: 3 }), false);
eq('home: has top friends', homeHasNoData({ ...empty, topFriends: 1 }), false);
eq('home: has friends', homeHasNoData({ ...empty, friendsCount: 2 }), false);
eq('home: searching', homeHasNoData({ ...empty, search: 'bob' }), false);
eq('home: group tab', homeHasNoData({ ...empty, tab: 'group' }), false);

// Offline signals table.
eq('signals: no friends at all', signalsOutcome(0, 0, 0), { kind: 'empty' });
eq('signals: every request failed', signalsOutcome(100, 0, 100), { kind: 'all-failed', failed: 100 });
eq('signals: one friend, failed', signalsOutcome(1, 0, 1), { kind: 'all-failed', failed: 1 });
eq('signals: some failed', signalsOutcome(100, 97, 3), { kind: 'rows', failed: 3 });
eq('signals: all fine', signalsOutcome(5, 5, 0), { kind: 'rows', failed: 0 });
eq('signals: cancelled mid-way, nothing failed', signalsOutcome(5, 0, 0), { kind: 'empty' });

for (const f of failures) console.log(f);
console.log(`pageStates: ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
