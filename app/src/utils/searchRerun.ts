// When the keyword index finishes building, the search page re-runs the
// search on screen if it ran against a half-built index (#46 review item 3).
// Only that search, and only while it is still the newest request: if the
// user has already sent another search that has not come back yet, re-running
// the old one would land last and leave the new words in the box over the old
// results (#48 review item 1).

export type SearchRange = { from: string; to: string };

/** The search whose first page is on screen. `req` is the request number it
 * was sent as (a 「加载更多」 for it moves `req` forward too). */
export interface ShownSearch<M extends string = string> {
  req: number;
  q: string;
  mode: M;
  dates: SearchRange;
  partial: boolean;
}

/** The index just went building → ready: the search to run again, or null.
 * `latestReq` is the newest request number handed out (`reqRef.current`). */
export function rerunWhenReady<S extends ShownSearch>(shown: S | null, latestReq: number): S | null {
  if (!shown || !shown.partial) return null;
  if (shown.req !== latestReq) return null; // a newer search is in flight — it wins
  return shown;
}

/** A first page just landed. It ran against a building index, but the status
 * poll already saw the build finish (so it will not fire again): re-run it now.
 * Never for a re-run itself, so a lagging status can't loop. */
export function rerunOnLanding(shown: ShownSearch, indexNow: string | null, wasRerun: boolean): boolean {
  return shown.partial && indexNow === 'ready' && !wasRerun;
}
