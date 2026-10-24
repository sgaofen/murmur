// Which empty / error state a page shows, as pure functions so the rules are
// tested (tests/js/page_states_check.mjs). The common bug these guard against
// (#48 review items 5 and 6): a request that failed showing up as "you have no
// data yet", which sends users off to re-decrypt when a retry would do.

export interface HomeEmptyInput {
  totalContacts: number;
  topFriends: number;
  friendsLoaded: boolean;
  friendsCount: number;
  /** The friend list request failed (its own ErrorState must stay visible). */
  friendsError: unknown;
  search: string;
  tab: string;
}

/** Home's whole-page "no chats yet" state: connected, nothing decrypted yet —
 * and the friend list actually loaded empty, not failed. */
export function homeHasNoData(s: HomeEmptyInput): boolean {
  return s.totalContacts === 0 && s.topFriends === 0
    && s.friendsLoaded && !s.friendsError && s.friendsCount === 0
    && !s.search && s.tab === 'private';
}

export type SignalsOutcome =
  | { kind: 'empty' }                           // truly no private friends
  | { kind: 'all-failed'; failed: number }      // every friend's details failed to load
  | { kind: 'rows'; failed: number };           // a table (maybe with some rows missing)

/** Offline-signals table after collecting: `targets` friends were asked for,
 * `collected` rows came back, `failed` requests threw. */
export function signalsOutcome(targets: number, collected: number, failed: number): SignalsOutcome {
  if (targets === 0) return { kind: 'empty' };
  if (collected === 0 && failed > 0) return { kind: 'all-failed', failed };
  if (collected === 0) return { kind: 'empty' };
  return { kind: 'rows', failed };
}
