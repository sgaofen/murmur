// Checks app/src/utils/searchLinks.ts: a chat opened from a search hit goes
// back to the same search — words, mode and dates (#46 review item 2).
// Run by tests/test_search_links_frontend.py via `node --experimental-strip-types`
// (Node >= 22.6) or `bun`; by hand: `bun tests/js/search_links_check.mjs`.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { searchQuery, searchBackPath } = await import(
  pathToFileURL(join(root, 'app', 'src', 'utils', 'searchLinks.ts')).href);

const failures = [];
const eq = (name, got, want) => { if (got !== want) failures.push(`${name}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`); };

// What the search page writes into its own URL and into `back`.
const back = searchQuery('火锅 周末', 'semantic', { from: '2024-01-01', to: '2024-06-30' });
eq('query', back, new URLSearchParams({ q: '火锅 周末', mode: 'semantic', from: '2024-01-01', to: '2024-06-30' }).toString());
eq('keyword mode is the default', searchQuery('a', 'keyword', { from: '', to: '' }), 'q=a');
eq('empty', searchQuery('', 'keyword', { from: '', to: '' }), '');

// The chat link the search page builds, and where 「返回」 goes from it.
const chat = new URLSearchParams({ m: '1:2:message_0.db', from: 'search', q: '火锅 周末', back });
eq('round trip', searchBackPath(chat), `search?${back}`);
const restored = new URLSearchParams(searchBackPath(chat).slice('search?'.length));
eq('restored q', restored.get('q'), '火锅 周末');
eq('restored mode', restored.get('mode'), 'semantic');
eq('restored from', restored.get('from'), '2024-01-01');
eq('restored to', restored.get('to'), '2024-06-30');

// Older links (no `back`) still keep the words; nothing → plain search page.
eq('legacy q only', searchBackPath(new URLSearchParams({ from: 'search', q: '晚安' })), 'search?q=%E6%99%9A%E5%AE%89');
eq('nothing', searchBackPath(new URLSearchParams({ from: 'search' })), 'search');
// Only the search page's own keys survive; unknown modes are dropped.
eq('filtered', searchBackPath(new URLSearchParams({ back: 'q=x&mode=evil&m=1:2:a.db&chat=y' })), 'search?q=x');

for (const f of failures) console.log(f);
console.log(`searchLinks: ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
