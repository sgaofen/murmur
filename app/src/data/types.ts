export type TagKind = 'orange' | 'amber' | 'sage' | 'ink' | 'faint';

export interface AIReportRef {
  available: boolean;
  path: string;     // e.g. "friends/01_kevin.md"
  size: number;
  mtime: number;
  short: string;    // first ~600 chars of body for preview
}

export interface Friend {
  id: string;            // wxid
  name: string;          // display name (remark or nickname)
  count: number;         // total messages
  last: string;          // human-readable last activity
  tag: string;           // auto label
  tagKind: TagKind;
  hue: number;           // for avatar gradient
  glyph: string;         // 1-2 char monogram
  knew: string;          // 认识 X 年
  bond: string;          // one-line characterisation
  isGroup?: boolean;
  aiReport?: AIReportRef;
}

export interface MonthlyHeat {
  months: string[];      // ['1月', '2月', ...]
  values: number[];      // 0..1 normalized
  peakLabel: string;
  peakCount: number;
  troughLabel: string;
  troughCount: number;
}

export interface FriendStats {
  totalSelf: number;
  totalOther: number;
  selfPct: number;
  spanDays: number;
  longestSilenceDays: number;
  longestSilenceFrom: string;
  topPhrase: string;
  topPhraseCount: number;
  initSelf: number;
  initOther: number;
  fastReplies: number;
  busiestHourLabel: string;
  busiestHourSub: string;
  lateNightPct: number;
  medianReplyHuman: string;
}

export interface Moment {
  date: string;
  from: string;
  text: string;
}

export interface HomeSummary {
  totalContacts: number;
  closeFriends: number;
  daysSinceFirst: number;
  topFriends: Friend[];
  heat: MonthlyHeat;
}
