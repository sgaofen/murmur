// Search ↔ chat links. The search page keeps its state in its own hash query
// (q / mode / from / to); a chat opened from a hit carries that whole query in
// `back`, so the chat page's 「返回」 lands on the same results — same words,
// same mode, same dates — instead of only the same words.

export type SearchMode = 'keyword' | 'semantic';

const KEYS = ['q', 'mode', 'from', 'to'] as const;

/** The search page's query string, e.g. `q=火锅&mode=semantic&from=2024-01-01`. */
export function searchQuery(q: string, mode: SearchMode, dates: { from: string; to: string }): string {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (mode === 'semantic') p.set('mode', 'semantic');
  if (dates.from) p.set('from', dates.from);
  if (dates.to) p.set('to', dates.to);
  return p.toString();
}

/** Where 「返回」 goes from a chat opened by a search hit: `search?<back>`.
 * Only the search page's own keys are kept. Links made before `back`
 * existed fall back to the chat's `q`. */
export function searchBackPath(chatParams: URLSearchParams): string {
  const back = chatParams.get('back');
  const src = new URLSearchParams(back ?? '');
  if (back === null && chatParams.get('q')) src.set('q', chatParams.get('q')!);
  const out = new URLSearchParams();
  for (const k of KEYS) {
    const v = src.get(k);
    if (!v || (k === 'mode' && v !== 'semantic')) continue;
    out.set(k, v);
  }
  const s = out.toString();
  return s ? `search?${s}` : 'search';
}
