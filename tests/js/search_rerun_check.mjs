// Checks app/src/utils/searchRerun.ts: when the index finishes building, the
// search page re-runs the half-built search on screen — but never over a newer
// search the user already sent (#48 review item 1).
// Run by tests/test_search_rerun_frontend.py via `node --experimental-strip-types`
// (Node >= 22.6) or `bun`; by hand: `bun tests/js/search_rerun_check.mjs`.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { rerunWhenReady, rerunOnLanding } = await import(
  pathToFileURL(join(root, 'app', 'src', 'utils', 'searchRerun.ts')).href);

const failures = [];
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${name}: ${g} != ${w}`);
};

const dates = { from: '', to: '' };
const shown = (req, q, partial) => ({ req, q, mode: 'keyword', dates, partial });

// Plain cases.
eq('nothing on screen', rerunWhenReady(null, 3), null);
eq('complete results are not re-run', rerunWhenReady(shown(1, 'A', false), 1), null);
eq('partial and latest → re-run', rerunWhenReady(shown(1, 'A', true), 1)?.q, 'A');
eq('newer request in flight → skip', rerunWhenReady(shown(1, 'A', true), 2), null);
eq('landing after the poll saw ready → re-run now', rerunOnLanding(shown(2, 'B', true), 'ready', false), true);
eq('landing while still building → wait for the poll', rerunOnLanding(shown(2, 'B', true), 'building', false), false);
eq('a re-run never re-runs itself', rerunOnLanding(shown(3, 'B', true), 'ready', true), false);
eq('complete landing → nothing', rerunOnLanding(shown(2, 'B', false), 'ready', false), false);

// A replay of Search.tsx's run() / rerunRef against a fake backend, so the
// race from the review is exercised end to end: A lands partial, the user
// sends B, the index becomes ready before B comes back.
function page() {
  const st = { reqRef: 0, last: null, indexState: 'building', input: '', results: null, sent: [], pending: new Map() };
  const run = (q, offset = 0, isRerun = false) => {
    const req = ++st.reqRef;
    if (offset > 0 && st.last) st.last = { ...st.last, req };
    st.sent.push(q);
    st.pending.set(req, { q, offset, isRerun });
    return req;
  };
  const land = (req, indexInResponse) => {
    const p = st.pending.get(req);
    st.pending.delete(req);
    if (req !== st.reqRef) return; // stale response dropped
    st.results = p.q;
    if (!p.offset) {
      const s = { req, q: p.q, mode: 'keyword', dates, partial: indexInResponse === 'building' };
      st.last = s;
      if (rerunOnLanding(s, st.indexState, p.isRerun)) rerun();
    }
  };
  const rerun = () => {
    const last = rerunWhenReady(st.last, st.reqRef);
    if (!last) return;
    st.last = { ...last, partial: false };
    run(last.q, 0, true);
  };
  const indexReady = () => { const was = st.indexState; st.indexState = 'ready'; if (was === 'building') rerun(); };
  const submit = (q) => { st.input = q; return run(q); };
  return { st, submit, land, indexReady, run };
}

{
  // The bug: B in flight when the index finishes.
  const p = page();
  const a = p.submit('A');
  p.land(a, 'building');
  const b = p.submit('B');
  p.indexReady();
  eq('race: A is not re-sent', p.st.sent, ['A', 'B']);
  p.land(b, 'ready');
  eq('race: box and results agree', [p.st.input, p.st.results], ['B', 'B']);
}
{
  // B itself ran partial and the poll saw ready first → B is re-run once.
  const p = page();
  const a = p.submit('A');
  p.land(a, 'building');
  const b = p.submit('B');
  p.indexReady();
  p.land(b, 'building');
  eq('late partial: B re-run', p.st.sent, ['A', 'B', 'B']);
  p.land(p.st.reqRef, 'building'); // even if the status still lags
  eq('late partial: no loop', p.st.sent, ['A', 'B', 'B']);
  eq('late partial: results', [p.st.input, p.st.results], ['B', 'B']);
}
{
  // The normal path from #46 still works: A partial, index ready → A again.
  const p = page();
  const a = p.submit('A');
  p.land(a, 'building');
  p.indexReady();
  eq('normal: A re-run', p.st.sent, ['A', 'A']);
  p.land(p.st.reqRef, 'ready');
  eq('normal: results', p.st.results, 'A');
}
{
  // 「加载更多」 on partial results keeps the search re-runnable.
  const p = page();
  const a = p.submit('A');
  p.land(a, 'building');
  p.run('A', 50);
  p.indexReady();
  eq('load more: A re-run from the top', p.st.sent, ['A', 'A', 'A']);
}

for (const f of failures) console.log(f);
console.log(`searchRerun: ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
