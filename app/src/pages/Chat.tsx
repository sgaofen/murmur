/* 对话 (#/chat/<id>) — one conversation as an instrument log.
 *
 *   22 时间轴    messages per year (yearbook; groups: just the years), playhead
 *   23 跳到日期  a date field + a month calendar
 *   24 对话      the log: time · who · message, day rules, FIND bar (in-chat search)
 *   25 命中      hits for the FIND query in this chat, per year + list
 *   26 这一天    the day at the top of the log
 *   27 前后几天  three days either side
 *
 * The hash query picks where it opens:
 *   ?m=<cursor>&q=<keywords>   at one message (a search hit), keywords marked
 *   ?at=YYYY-MM-DD             at the first message of that day
 *   (nothing)                  at the newest message
 *   &from=search               back goes to 检索 instead of the friend page
 *   &back=<search query>       …and restores that search (words, mode, dates)
 * Moving between hits here rewrites m / q in place (history.replaceState), so
 * a reload or 「返回」 comes back to the same message.
 *
 * Counts in 26 / 27 and the calendar come from the messages loaded so far: a
 * day only gets an exact number once it is fully loaded, otherwise it shows
 * 「≥ n」 or 「—」. Data: GET /api/chat/messages (cli/chat_view.py),
 * /api/search (in-chat FIND), /api/friend/<id>/yearbook. Layout: ./Chat.css. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  chatCursorFor, errorCode, getChatPage, getYearbook, mediaUrl, searchMessages,
} from '../data/api';
import type { ChatPageInfo, ChatPageMessage, SearchHit, Yearbook } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import {
  Button, Dialog, EmptyState, ErrorState, Module, SegmentedControl, Skeleton, cx,
} from '../ui';
import { IconClose, IconPlay, IconRefresh } from '../ui/icons';
import { PageHeader } from '../shell/PageHeader';
import { displayName, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { usePageKeys } from '../utils/usePageKeys';
import { searchBackPath } from '../utils/searchLinks';
import {
  Highlight, IconArrowDown, IconCalendarJump, IconMessage, IconQuote, TypeIcon,
  dayFromTs, dayOf, formatDay, isStub, splitQuote, splitShare, splitTerms, typeLabel,
} from '../components/chatBits';
import './Chat.css';

const FIRST_PAGE = 80;
const PAGE = 60;
/** A gap longer than this starts a new group (the sender is named again). */
const GROUP_GAP_S = 5 * 60;
/** Show 「回到最新」 once this far (px) above the bottom. */
const AWAY_PX = 640;
/** In-chat FIND: hits per request (the backend caps at 200). */
const HIT_PAGE = 200;

export interface ChatPageProps {
  chatId: string;
  /** The hash's query part (see the header comment). */
  query: string;
  /** App-level navigation: go('search?q=…'), go('friend/<id>'). */
  navigate: (path: string) => void;
}

type ScrollIntent =
  | { kind: 'bottom' }
  | { kind: 'anchor'; id: string }
  | { kind: 'keep'; top: number; height: number };

type Pager = 'idle' | 'loading' | 'error';
type SenderFilter = 'all' | 'self' | 'other';

interface DayStat { n: number; self: number; other: number; first: string; last: string }
type Count = { kind: 'exact' | 'min' | 'unknown'; n: number };

// ——— small helpers ———

const WD_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function weekdayEn(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return y && m && d ? WD_EN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] : '';
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function clockSec(iso: string): string {
  return (iso || '').slice(11, 19);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 「朋友 PB」→ PB for the narrow who column; anything else stays whole. */
function code(name: string): string {
  const m = /^(?:朋友|群)\s*(\S{1,3})$/.exec(name);
  return m ? m[1] : name;
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return;
    }
    const fn = (e: MediaQueryListEvent) => setOn(e.matches);
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, [query]);
  return on;
}

function describeChat(info: ChatPageInfo): string {
  const parts = [info.is_group ? '群聊' : '私聊', `${info.count.toLocaleString()} 条消息`];
  if (info.first_ts != null && info.last_ts != null) {
    const a = dayFromTs(info.first_ts).slice(0, 7).replace('-', '.');
    const b = dayFromTs(info.last_ts).slice(0, 7).replace('-', '.');
    parts.push(a === b ? a : `${a} – ${b}`);
  }
  return parts.join(' · ');
}

// ——— page ———

export function ChatPage({ chatId, query, navigate }: ChatPageProps) {
  const privacy = usePrivacy();
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const fromSearch = params.get('from') === 'search';
  const q0 = params.get('q') || '';
  const startCursor = params.get('m') || undefined;
  const startDay = params.get('at') || undefined;

  const [info, setInfo] = useState<ChatPageInfo | null>(null);
  const [msgs, setMsgs] = useState<ChatPageMessage[]>([]);
  const [hasBefore, setHasBefore] = useState(false);
  const [hasAfter, setHasAfter] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  // A date jump lands on 「跳转位置」 even when we came from a search.
  const [targetByDate, setTargetByDate] = useState(!!startDay && !startCursor);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [older, setOlder] = useState<Pager>('idle');
  const [newer, setNewer] = useState<Pager>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [jumpDay, setJumpDay] = useState(startDay ?? '');
  const [preview, setPreview] = useState<ChatPageMessage | null>(null);
  const [away, setAway] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [calMonth, setCalMonth] = useState<string | null>(null);   // null = follow focusDay
  const [scrollNonce, setScrollNonce] = useState(0);
  const [yb, setYb] = useState<Yearbook | null>(null);

  // in-chat FIND
  const [findInput, setFindInput] = useState(q0);
  const [findQ, setFindQ] = useState(q0);
  const [sender, setSender] = useState<SenderFilter>('all');
  const [hits, setHits] = useState<SearchHit[] | null>(null);    // oldest first
  const [hitsTotal, setHitsTotal] = useState(0);
  const [hitsState, setHitsState] = useState<'idle' | 'loading' | 'ready' | 'error'>(splitTerms(q0).length ? 'loading' : 'idle');
  const [hitsError, setHitsError] = useState<unknown>(null);
  const [hitsMore, setHitsMore] = useState(false);
  const [hitCursor, setHitCursor] = useState<string | null>(q0 ? startCursor ?? null : null);
  const terms = useMemo(() => splitTerms(findQ), [findQ]);

  const compact = useMedia('(max-width: 1199px)');   // no left column: date form goes to the header
  const narrow = useMedia('(max-width: 640px)');     // header only has room for an icon

  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const reqRef = useRef(0);   // bumped by every full (re)load; late page responses are dropped
  const findReq = useRef(0);
  const intentRef = useRef<ScrollIntent | null>(null);
  const urlRef = useRef(new URLSearchParams(query));

  /** Keep m / q / at in the address so a reload lands on the same spot. */
  const syncUrl = useCallback((patch: Record<string, string | null>) => {
    const p = urlRef.current;
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    try {
      window.history.replaceState(window.history.state, '', `#/chat/${encodeURIComponent(chatId)}${qs ? `?${qs}` : ''}`);
    } catch { /* sandboxed — the address just doesn't follow */ }
  }, [chatId]);

  const load = useCallback(async (opts: { around?: string; at?: string } = {}) => {
    const req = ++reqRef.current;
    setPhase('loading');
    setError(null);
    setNote(null);
    setOlder('idle');
    setNewer('idle');
    setCalMonth(null);
    try {
      const r = await getChatPage(chatId, { around: opts.around, at: opts.at, limit: FIRST_PAGE });
      if (req !== reqRef.current) return;
      if (r.chat) setInfo(r.chat);
      setMsgs(r.messages);
      setHasBefore(!!r.has_more_before);
      setHasAfter(!!r.has_more_after);
      setTarget(r.anchor);
      setTargetByDate(!!opts.at);
      intentRef.current = r.anchor ? { kind: 'anchor', id: r.anchor } : { kind: 'bottom' };
      if (opts.at && r.anchor) {
        const hit = r.messages.find(m => m.id === r.anchor);
        const day = hit ? dayOf(hit.time) : '';
        if (day && day !== opts.at) {
          setNote(day < opts.at
            ? `${formatDay(opts.at)} 及之后没有消息，停在最后一条（${formatDay(day)}）。`
            : `${formatDay(opts.at)} 那天没有消息，已跳到之后最近的一天：${formatDay(day)}。`);
        }
      }
      setPhase('ready');
    } catch (e) {
      if (req !== reqRef.current) return;
      setError(e);
      setPhase('error');
    }
  }, [chatId]);

  useEffect(() => {
    void load({ around: startCursor, at: startDay });
  }, [load, startCursor, startDay]);

  // 22 时间轴: per-year numbers for private chats.
  const groupish = chatId.endsWith('@chatroom');
  useEffect(() => {
    if (groupish) return;
    let cancelled = false;
    getYearbook(chatId).then(d => { if (!cancelled) setYb(d); }).catch(() => { /* the rail falls back to plain years */ });
    return () => { cancelled = true; };
  }, [chatId, groupish]);

  const loadOlder = useCallback(async () => {
    if (phase !== 'ready' || !hasBefore || older === 'loading' || !msgs.length) return;
    const req = reqRef.current;
    setOlder('loading');
    try {
      const r = await getChatPage(chatId, { before: msgs[0].id, limit: PAGE });
      if (req !== reqRef.current) return;
      const el = scrollRef.current;
      // Measured when the page arrives (the user may have scrolled meanwhile).
      if (el) intentRef.current = { kind: 'keep', top: el.scrollTop, height: el.scrollHeight };
      setMsgs(prev => [...r.messages, ...prev]);
      setHasBefore(!!r.has_more_before);
      setOlder('idle');
    } catch {
      if (req === reqRef.current) setOlder('error');
    }
  }, [chatId, phase, hasBefore, older, msgs]);

  const loadNewer = useCallback(async () => {
    if (phase !== 'ready' || !hasAfter || newer === 'loading' || !msgs.length) return;
    const req = reqRef.current;
    setNewer('loading');
    try {
      const r = await getChatPage(chatId, { after: msgs[msgs.length - 1].id, limit: PAGE });
      if (req !== reqRef.current) return;
      setMsgs(prev => [...prev, ...r.messages]);
      setHasAfter(!!r.has_more_after);
      setNewer('idle');
    } catch {
      if (req === reqRef.current) setNewer('error');
    }
  }, [chatId, phase, hasAfter, newer, msgs]);

  // Which day is at the top of the log (26 / 27, the calendar, the playhead).
  const measureFocus = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // The day under the middle of the log (a jump centres its target there);
    // scrolled to the very end, the last day on screen.
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    const line = atEnd ? el.scrollTop + el.clientHeight - 24 : el.scrollTop + el.clientHeight / 2;
    let cur: string | null = null;
    const rules = el.querySelectorAll<HTMLElement>('[data-day]');
    for (const r of rules) {
      if (r.offsetTop <= line) cur = r.dataset.day || cur;
      else break;
    }
    if (!cur && rules.length) cur = rules[0].dataset.day || null;
    setFocusDay(prev => (prev === cur ? prev : cur));
  }, []);

  // Apply the pending scroll position right after the DOM changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const intent = intentRef.current;
    if (!el || !intent || phase !== 'ready') return;
    intentRef.current = null;
    if (intent.kind === 'bottom') {
      el.scrollTop = el.scrollHeight;
    } else if (intent.kind === 'keep') {
      el.scrollTop = intent.top + (el.scrollHeight - intent.height);
    } else {
      const node = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(intent.id)}"]`);
      if (node) {
        const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        el.scrollTop = Math.max(0, top - el.clientHeight / 2 + node.offsetHeight / 2);
      }
    }
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX);
    measureFocus();
  }, [msgs, phase, scrollNonce, measureFocus]);

  // Sentinels at both ends page in more history. Re-created whenever the list
  // changes so a sentinel that is still on screen after a page fires again.
  const olderFn = useRef(loadOlder);
  const newerFn = useRef(loadNewer);
  olderFn.current = loadOlder;
  newerFn.current = loadNewer;
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || phase !== 'ready' || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (e.target === topRef.current) void olderFn.current();
        else if (e.target === bottomRef.current) void newerFn.current();
      }
    }, { root, rootMargin: '480px 0px' });
    if (topRef.current) io.observe(topRef.current);
    if (bottomRef.current) io.observe(bottomRef.current);
    return () => io.disconnect();
  }, [phase, msgs, hasBefore, hasAfter]);

  const rafRef = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX;
    if (next !== away) setAway(next);
    if (!rafRef.current) {
      rafRef.current = window.requestAnimationFrame(() => { rafRef.current = 0; measureFocus(); });
    }
  };
  useEffect(() => () => { if (rafRef.current) window.cancelAnimationFrame(rafRef.current); }, []);

  const jumpLatest = () => {
    if (hasAfter) {
      setTarget(null);
      syncUrl({ m: null, at: null });
      void load({});
      return;
    }
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const jumpTo = (day: string) => {
    if (!day) return;
    setJumpDay(day);
    setJumpOpen(false);
    setHitCursor(null);
    syncUrl({ at: day, m: null });
    void load({ at: day });
  };

  const onJump = (e: FormEvent) => {
    e.preventDefault();
    jumpTo(jumpDay || focusDay || '');
  };

  // ——— FIND ———

  const runFind = useCallback(async (qq: string, snd: SenderFilter, offset = 0) => {
    const req = ++findReq.current;
    if (!splitTerms(qq).length) {
      setHits(null);
      setHitsTotal(0);
      setHitsState('idle');
      setHitsError(null);
      return;
    }
    if (offset === 0) {
      setHitsState('loading');
      setHitsError(null);
    } else {
      setHitsMore(true);
    }
    try {
      const r = await searchMessages({
        q: qq, chat: chatId, limit: HIT_PAGE, offset,
        sender: snd === 'all' ? undefined : snd === 'self' ? 'self' : chatId,
      });
      if (req !== findReq.current) return;
      setHits(prev => {
        const seen = new Set<string>();
        const all = [...(offset > 0 && prev ? prev : []), ...r.results].filter(h => {
          const k = chatCursorFor(h);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        return all.sort((a, b) => a.ts - b.ts || a.locator.local_id - b.locator.local_id);
      });
      setHitsTotal(r.total);
      setHitsState('ready');
    } catch (e) {
      if (req !== findReq.current) return;
      if (offset === 0) {
        setHits(null);
        setHitsError(e);
        setHitsState('error');
      }
    } finally {
      if (req === findReq.current) setHitsMore(false);
    }
  }, [chatId]);

  // Opened from a search hit: list that query's hits here too.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (ranInitial.current) return;
    ranInitial.current = true;
    if (splitTerms(q0).length) void runFind(q0, 'all');
  }, [q0, runFind]);

  const submitFind = (e?: FormEvent) => {
    e?.preventDefault();
    const qq = findInput.trim();
    setFindQ(qq);
    setHitCursor(null);
    syncUrl({ q: qq || null });
    void runFind(qq, sender);
  };

  const pickSender = (s: SenderFilter) => {
    setSender(s);
    if (findQ) void runFind(findQ, s);
  };

  const hitIdx = useMemo(
    () => (hits && hitCursor ? hits.findIndex(h => chatCursorFor(h) === hitCursor) : -1),
    [hits, hitCursor],
  );

  const goHit = useCallback((h: SearchHit) => {
    const c = chatCursorFor(h);
    setHitCursor(c);
    syncUrl({ m: c, q: findQ || null, at: null });
    if (msgs.some(m => m.id === c) && phase === 'ready') {
      setTarget(c);
      setTargetByDate(false);
      intentRef.current = { kind: 'anchor', id: c };
      setScrollNonce(n => n + 1);
    } else {
      void load({ around: c });
    }
  }, [findQ, load, msgs, phase, syncUrl]);

  const stepHit = useCallback((dir: 1 | -1) => {
    if (!hits || !hits.length) return;
    let i: number;
    if (hitIdx >= 0) i = hitIdx + dir;
    else {
      // Nothing picked yet: the next hit after (or before) what is on screen.
      const ref = focusDay ?? '';
      i = dir === 1 ? hits.findIndex(h => dayOf(h.time) >= ref) : hits.length - 1;
      if (i < 0) i = hits.length - 1;
    }
    if (i < 0 || i >= hits.length) return;
    goHit(hits[i]);
  }, [hits, hitIdx, focusDay, goHit]);

  usePageKeys({
    '/': () => findRef.current?.focus(),
    n: () => stepHit(1),
    p: () => stepHit(-1),
  }, phase !== 'error' && !preview);

  // ——— derived ———

  const isGroup = info ? info.is_group : groupish;
  const back = fromSearch
    ? { label: '检索', onClick: () => navigate(searchBackPath(params)) }
    : isGroup
      ? { label: '年代记', onClick: () => navigate('') }
      : { label: '档案', onClick: () => navigate(`friend/${chatId}`) };

  const name = displayName(chatId, info?.name ?? null);
  const minDay = info?.first_ts != null ? dayFromTs(info.first_ts) : undefined;
  const maxDay = info?.last_ts != null ? dayFromTs(info.last_ts) : undefined;
  // Module 24's header repeats count and range, so a crowded strip keeps only the kind.
  const subtitle = info ? (compact ? (info.is_group ? '群聊' : '私聊') : describeChat(info)) : undefined;
  const canJump = !!info && info.count > 0;

  const dayStats = useMemo(() => {
    const map = new Map<string, DayStat>();
    for (const m of msgs) {
      if (m.type === 'system' || m.type === 'revoke') continue;
      const d = dayOf(m.time);
      const s = map.get(d) || { n: 0, self: 0, other: 0, first: m.time, last: m.time };
      s.n += 1;
      if (m.from_id === 'self') s.self += 1;
      else s.other += 1;
      s.last = m.time;
      map.set(d, s);
    }
    return map;
  }, [msgs]);
  const firstLoaded = msgs.length ? dayOf(msgs[0].time) : null;
  const lastLoaded = msgs.length ? dayOf(msgs[msgs.length - 1].time) : null;

  const countFor = useCallback((day: string): Count => {
    if (!firstLoaded || !lastLoaded) return { kind: 'unknown', n: 0 };
    if ((minDay && day < minDay) || (maxDay && day > maxDay)) return { kind: 'exact', n: 0 };
    const n = dayStats.get(day)?.n ?? 0;
    const startOk = day > firstLoaded || !hasBefore;
    const endOk = day < lastLoaded || !hasAfter;
    if (day < firstLoaded) return hasBefore ? { kind: 'unknown', n: 0 } : { kind: 'exact', n: 0 };
    if (day > lastLoaded) return hasAfter ? { kind: 'unknown', n: 0 } : { kind: 'exact', n: 0 };
    return startOk && endOk ? { kind: 'exact', n } : { kind: 'min', n };
  }, [dayStats, firstLoaded, lastLoaded, hasBefore, hasAfter, minDay, maxDay]);

  const shownMonth = calMonth ?? (focusDay ? focusDay.slice(0, 7) : maxDay?.slice(0, 7) ?? null);
  const otherCode = code(name);

  const jumpForm = (
    <form className="ct-jump" onSubmit={onJump} aria-label="跳到日期">
      <label className="ui-field ct-jump__field">
        <span className="ui-field__prompt">DATE</span>
        <input
          type="date"
          className="chat-jump__input"
          value={jumpDay || focusDay || ''}
          min={minDay}
          max={maxDay}
          onChange={(e) => setJumpDay(e.target.value)}
          aria-label="日期"
        />
      </label>
      <Button size="sm" type="submit" disabled={!jumpDay && !focusDay} kbd={compact && !narrow ? undefined : '↵'}>跳转</Button>
    </form>
  );

  const header = (
    <PageHeader back={back} title={!info ? '对话' : `对话 · ${name}`} subtitle={subtitle}>
      {canJump && compact && !narrow && jumpForm}
      {canJump && narrow && (
        <button
          type="button"
          className={cx('ui-icon-btn', jumpOpen && 'is-on')}
          aria-label="跳到日期"
          aria-expanded={jumpOpen}
          title="跳到日期"
          onClick={() => setJumpOpen(o => !o)}
        >
          <IconCalendarJump size={17} />
        </button>
      )}
      {fromSearch && !isGroup && (
        <Button size="sm" variant="secondary" onClick={() => navigate(`friend/${chatId}`)} title={`打开 ${name} 的档案`}>{compact ? '档案' : `${name} 的档案`}</Button>
      )}
    </PageHeader>
  );

  if (phase === 'error') {
    return (
      <div className="ct-page ct-page--state">
        {header}
        <ChatError error={error} onRetry={() => void load({ around: startCursor, at: startDay })} />
      </div>
    );
  }

  const ready = phase === 'ready';
  const countLine = info
    ? `${fmt(info.count)} MSG${minDay && maxDay ? ` · ${minDay} → ${maxDay}` : ''}`
    : undefined;

  return (
    <div className="ct-page app-fill">
      {header}
      <div className="ct-rack ui-rack">
        {/* ——— left: 22 时间轴 · 23 跳到日期 ——— */}
        <div className="ct-col ct-col--left">
          <Module id="22" title="时间轴" en={yb ? 'MSG / YEAR' : 'YEARS'} className="ct-m22" scroll>
            <Timeline
              yb={yb}
              minDay={minDay}
              maxDay={maxDay}
              focusYear={focusDay ? Number(focusDay.slice(0, 4)) : null}
              onPick={(day) => jumpTo(day)}
            />
          </Module>
          <Module id="23" title="跳到日期" en="GOTO" className="ct-m23">
            <div className="ct-goto">
              {canJump ? jumpForm : <div className="ct-note">没有可以跳转的日期。</div>}
              {canJump && shownMonth && (
                <MonthCal
                  month={shownMonth}
                  minDay={minDay}
                  maxDay={maxDay}
                  focusDay={focusDay}
                  countFor={countFor}
                  onMonth={setCalMonth}
                  onPick={jumpTo}
                />
              )}
            </div>
          </Module>
        </div>

        {/* ——— center: 24 对话 ——— */}
        <Module id="24" title={info ? `对话 · ${name}` : '对话'} en={countLine} className="ct-m24">
          <form className="ct-find" onSubmit={submitFind} role="search" aria-label="在这段对话里查找">
            <label className="ui-field ct-find__field">
              <span className="ui-field__prompt">FIND</span>
              <input
                ref={findRef}
                type="search"
                value={findInput}
                onChange={(e) => setFindInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && findInput) { e.stopPropagation(); setFindInput(''); }
                }}
                placeholder="在这段对话里找 · 按 / 聚焦"
                aria-label="在这段对话里查找"
              />
              {hitsState === 'loading' && <span className="ui-spinner ct-find__spin" aria-hidden="true" />}
              {hitsState === 'ready' && findQ && (
                <span className="ct-find__hit" aria-live="polite">
                  HIT <b>{hitIdx >= 0 ? String(hitIdx + 1).padStart(3, '0') : '—'}</b> / {fmt(hitsTotal)}
                </span>
              )}
            </label>
            <span className="ct-find__step">
              <button type="button" className="ui-icon-btn ct-find__btn" onClick={() => stepHit(-1)}
                disabled={!hits?.length} title="上一个命中 (P)" aria-label="上一个命中">↑</button>
              <button type="button" className="ui-icon-btn ct-find__btn" onClick={() => stepHit(1)}
                disabled={!hits?.length} title="下一个命中 (N)" aria-label="下一个命中">↓</button>
            </span>
            <SegmentedControl
              label="谁说的"
              size="sm"
              value={sender}
              onChange={(v) => pickSender(v as SenderFilter)}
              options={isGroup
                ? [{ value: 'all', label: '全部' }, { value: 'self', label: '你' }]
                : [{ value: 'all', label: '全部' }, { value: 'other', label: otherCode }, { value: 'self', label: '你' }]}
            />
          </form>
          {canJump && narrow && jumpOpen && <div className="ct-jumpbar">{jumpForm}</div>}
          {note && ready && (
            <div className="ct-notebar" role="status">
              <span className="ui-label">NOTE</span>
              <span className="ct-notebar__t">{note}</span>
              <button type="button" className="ui-icon-btn" aria-label="知道了" title="知道了" onClick={() => setNote(null)}>
                <IconClose size={13} />
              </button>
            </div>
          )}
          <div className="ct-scroll" ref={scrollRef} onScroll={onScroll}>
            {phase === 'loading' && <ChatSkeleton />}
            {ready && msgs.length === 0 && (
              <EmptyState
                layout="inline"
                icon={<IconMessage size={22} />}
                label="NO MESSAGES"
                title="这里还没有消息"
                description="这个会话在已解密的数据里没有消息记录。新消息要等下一次「更新数据」后才会出现。"
              />
            )}
            {ready && msgs.length > 0 && (
              <>
                <div ref={topRef} className="ct-edge">
                  {hasBefore ? (
                    older === 'error' ? (
                      <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} onClick={() => void loadOlder()}>
                        更早的消息没加载出来，重试
                      </Button>
                    ) : (
                      <span className="ct-edge__loading"><span className="ui-spinner" aria-hidden="true" />加载更早的消息…</span>
                    )
                  ) : (
                    <span className="ct-edge__start">BEGIN · 聊天从这里开始</span>
                  )}
                </div>
                <MessageList
                  msgs={msgs}
                  isGroup={!!info?.is_group}
                  target={target}
                  targetLabel={terms.length && !targetByDate ? '搜索命中' : '跳转位置'}
                  terms={terms}
                  onPreview={setPreview}
                  countFor={countFor}
                  privacy={privacy}
                />
                <div ref={bottomRef} className="ct-edge ct-edge--bottom">
                  {hasAfter ? (newer === 'error' ? (
                    <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} onClick={() => void loadNewer()}>
                      后面的消息没加载出来，重试
                    </Button>
                  ) : (
                    <span className="ct-edge__loading"><span className="ui-spinner" aria-hidden="true" />加载后面的消息…</span>
                  )) : <span className="ct-edge__start">END · 最新一条</span>}
                </div>
              </>
            )}
          </div>
          {ready && (away || hasAfter) && (
            <Button className="ct-latest" size="sm" icon={<IconArrowDown size={14} />} onClick={jumpLatest}>
              回到最新
            </Button>
          )}
        </Module>

        {/* ——— right: 25 命中 · 26 这一天 · 27 前后几天 ——— */}
        <div className="ct-col ct-col--right">
          <Module
            id="25" title="命中" className="ct-m25"
            en={findQ ? `「${maskText(findQ)}」` : 'FIND'}
            right={hitsState === 'ready' ? `HITS ${fmt(hitsTotal)}` : undefined}
          >
            <HitsPanel
              state={hitsState}
              error={hitsError}
              query={findQ}
              sender={sender}
              hits={hits}
              total={hitsTotal}
              current={hitIdx}
              more={hitsMore}
              otherName={name}
              onPick={goHit}
              onMore={() => void runFind(findQ, sender, hits?.length ?? 0)}
              onRetry={() => void runFind(findQ, sender)}
              onOpenSearch={() => navigate(`search?q=${encodeURIComponent(findQ)}`)}
            />
          </Module>
          <Module
            id="26" title="这一天" className="ct-m26"
            en={focusDay ? `${focusDay} ${weekdayEn(focusDay)}` : 'DAY'}
          >
            <DayPanel day={focusDay} stat={focusDay ? dayStats.get(focusDay) : undefined}
              count={focusDay ? countFor(focusDay) : null} isGroup={isGroup} otherCode={otherCode} />
          </Module>
          <Module id="27" title="前后几天" en="NEIGHBORS · MSG" className="ct-m27">
            <Neighbors day={focusDay} countFor={countFor} minDay={minDay} maxDay={maxDay} onPick={jumpTo} />
          </Module>
        </div>
      </div>
      <MediaPreview msg={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

// ——— 22 时间轴 ———

function Timeline({ yb, minDay, maxDay, focusYear, onPick }: {
  yb: Yearbook | null; minDay?: string; maxDay?: string; focusYear: number | null; onPick: (day: string) => void;
}) {
  const rows = useMemo(() => {
    if (yb && yb.years.length) {
      return yb.years.map(y => ({ year: y.year, n: y.msg_count as number | null, day: y.first_date || `${y.year}-01-01` }));
    }
    if (!minDay || !maxDay) return [];
    const out: { year: number; n: number | null; day: string }[] = [];
    for (let y = Number(minDay.slice(0, 4)); y <= Number(maxDay.slice(0, 4)); y++) {
      out.push({ year: y, n: null, day: y === Number(minDay.slice(0, 4)) ? minDay : `${y}-01-01` });
    }
    return out;
  }, [yb, minDay, maxDay]);
  if (!rows.length) {
    return <div className="ct-tl ct-tl--skel" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} height={12} width={`${40 + (i * 23) % 50}%`} />)}</div>;
  }
  const max = Math.max(1, ...rows.map(r => r.n ?? 0));
  const plain = rows.every(r => r.n == null);
  return (
    <ol className={cx('ct-tl', plain && 'ct-tl--plain')} aria-label="按年份跳转">
      {rows.map(r => {
        const on = r.year === focusYear;
        return (
          <li key={r.year}>
            <button type="button" className={cx('ct-tl__row', on && 'is-on')} onClick={() => onPick(r.day)}
              title={`跳到 ${r.day}`} aria-current={on ? 'true' : undefined}>
              <span className="ct-tl__y">{r.year}</span>
              {!plain && <span className="ct-tl__bar">{r.n != null && <i style={{ width: `${Math.max(1, (r.n / max) * 100)}%` }} />}</span>}
              <span className="ct-tl__n">{r.n != null ? fmt(r.n) : plain && !r.day.endsWith('-01-01') ? `${r.day.slice(5)} 起` : ''}</span>
            </button>
          </li>
        );
      })}
      {plain && <li className="ct-tl__note">没有逐年统计，点年份跳到那一年的第一天。</li>}
    </ol>
  );
}

// ——— 23 月历 ———

const DOW_ZH = ['一', '二', '三', '四', '五', '六', '日'];

function MonthCal({ month, minDay, maxDay, focusDay, countFor, onMonth, onPick }: {
  month: string; minDay?: string; maxDay?: string; focusDay: string | null;
  countFor: (day: string) => Count; onMonth: (m: string) => void; onPick: (day: string) => void;
}) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;   // Monday first
  const cells = Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const counts = cells.map(d => countFor(d));
  const max = Math.max(1, ...counts.map(c => (c.kind === 'exact' ? c.n : 0)));
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const canPrev = !minDay || prev >= minDay.slice(0, 7);
  const canNext = !maxDay || next <= maxDay.slice(0, 7);
  return (
    <div className="ct-cal">
      <div className="ct-cal__head">
        <span className="ct-cal__m">{month}</span>
        <span className="ct-cal__nav">
          <button type="button" className="ui-icon-btn" disabled={!canPrev} onClick={() => onMonth(prev)} aria-label="上个月">‹</button>
          <button type="button" className="ui-icon-btn" disabled={!canNext} onClick={() => onMonth(next)} aria-label="下个月">›</button>
        </span>
      </div>
      <div className="ct-cal__grid" role="grid" aria-label={`${month} 月历`}>
        {DOW_ZH.map(d => <span key={d} className="ct-cal__dow" role="columnheader">{d}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={`l${i}`} />)}
        {cells.map((d, i) => {
          const c = counts[i];
          const out = (minDay && d < minDay) || (maxDay && d > maxDay);
          const lvl = c.kind === 'exact' && c.n > 0 ? Math.min(4, 1 + Math.floor((c.n / max) * 3.999)) : 0;
          const label = out ? '不在聊天范围内' : c.kind === 'exact' ? `${c.n} 条` : c.kind === 'min' ? `至少 ${c.n} 条（还没全部载入）` : '还没载入';
          return (
            <button
              key={d} type="button" role="gridcell"
              className={cx('ct-cal__d', `l${lvl}`, c.kind === 'unknown' && 'is-unknown', c.kind === 'exact' && c.n === 0 && 'is-zero',
                d === focusDay && 'is-on')}
              disabled={!!out}
              onClick={() => onPick(d)}
              title={`${d} · ${label}`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      <div className="ct-cal__key">深浅 = 已载入当天的消息数 · 虚框 = 还没载入</div>
    </div>
  );
}

// ——— 25 命中 ———

function HitsPanel({ state, error, query, sender, hits, total, current, more, otherName, onPick, onMore, onRetry, onOpenSearch }: {
  state: 'idle' | 'loading' | 'ready' | 'error'; error: unknown; query: string; sender: SenderFilter;
  hits: SearchHit[] | null; total: number; current: number; more: boolean; otherName: string;
  onPick: (h: SearchHit) => void; onMore: () => void; onRetry: () => void; onOpenSearch: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-hit="${current}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  if (state === 'idle') {
    return (
      <div className="ct-note">
        在中间的 <b>FIND</b> 里输入关键词，只在这段对话里找；命中会按年份排开，点一条就跳过去。
      </div>
    );
  }
  if (state === 'loading') {
    return (
      <div className="ct-hits" aria-busy="true" aria-label="正在查找">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="ct-hit is-skel"><Skeleton width={64} height={10} /><Skeleton width={`${50 + (i * 13) % 40}%`} height={11} /></div>
        ))}
      </div>
    );
  }
  if (state === 'error') {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    return (
      <div className="ct-note">
        <div className="ct-note__err"><span className="ui-led ui-led--error" /> 没能在这段对话里查找。</div>
        <div className="ct-note__raw">{maskText(raw).slice(0, 160)}</div>
        <div className="ct-note__acts">
          <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={onRetry}>重试</Button>
          <Button size="sm" variant="ghost" onClick={onOpenSearch}>去检索页看索引</Button>
        </div>
      </div>
    );
  }
  const list = hits ?? [];
  if (!list.length) {
    return (
      <div className="ct-note">
        {sender === 'all' ? '这段对话' : sender === 'self' ? '你说的话' : `${otherName} 说的话`}里没有「{maskText(query)}」。
      </div>
    );
  }
  const byYear = new Map<number, number>();
  for (const h of list) {
    const y = Number(h.time.slice(0, 4));
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  const years = [...byYear.entries()].sort((a, b) => a[0] - b[0]);
  const yMax = Math.max(1, ...years.map(y => y[1]));
  const curYear = current >= 0 ? Number(list[current].time.slice(0, 4)) : null;
  const partial = list.length < total;
  return (
    <div className="ct-hitsbox">
      <div className="ct-dens">
        <div className="ui-label">DENSITY<b>{partial ? `每年命中 · 已载入 ${fmt(list.length)} / ${fmt(total)}` : '每年命中次数'}</b></div>
        <div className="ct-dens__bars" role="img" aria-label={years.map(([y, n]) => `${y} 年 ${n} 条`).join('，')}>
          {years.map(([y, n]) => (
            <div key={y} className={cx('ct-dens__col', y === curYear && 'is-on')} title={`${y} · ${n}`}>
              <i style={{ height: `${(n / yMax) * 100}%` }} />
              <span>&apos;{String(y).slice(2)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="ct-hits" ref={listRef}>
        {list.map((h, i) => {
          const self = h.sender === 'self';
          return (
            <button key={chatCursorFor(h)} type="button" data-hit={i}
              className={cx('ct-hit', i === current && 'is-on')} onClick={() => onPick(h)}>
              <span className="ct-hit__d">{h.time.slice(0, 10)}</span>
              <span className={cx('ct-hit__w', self && 'is-you')}>{self ? '你' : code(displayName(h.sender, h.sender_name))}</span>
              <span className="ct-hit__s">
                {h.segments?.length
                  ? h.segments.map((s, k) => (s.hit ? <mark key={k} className="chat-mark">{maskText(s.text)}</mark> : <span key={k}>{maskText(s.text)}</span>))
                  : maskText(h.snippet)}
              </span>
            </button>
          );
        })}
        {partial && (
          <div className="ct-hits__more">
            <Button size="sm" variant="ghost" loading={more} onClick={onMore}>
              {more ? '加载中…' : `再载入更早的命中（还有 ${fmt(total - list.length)} 条）`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ——— 26 这一天 · 27 前后几天 ———

function DayPanel({ day, stat, count, isGroup, otherCode }: {
  day: string | null; stat?: DayStat; count: Count | null; isGroup: boolean; otherCode: string;
}) {
  if (!day || !count) return <div className="ct-note">滚动对话时，这里显示正中间那一天。</div>;
  const exact = count.kind === 'exact';
  const pre = exact ? '' : '≥ ';
  return (
    <div className="ct-ro">
      <div>
        <div className="ui-label">MSG<b>消息</b></div>
        <div className="ct-ro__v">{stat ? `${pre}${fmt(stat.n)}` : exact ? '0' : '—'}</div>
      </div>
      <div>
        <div className="ui-label">{isGroup ? 'SPLIT' : `YOU / ${otherCode}`}<b>{isGroup ? '你 / 其他人' : '你 / 对方'}</b></div>
        <div className="ct-ro__v">{stat ? `${pre}${stat.self} / ${stat.other}` : '—'}</div>
      </div>
      <div>
        <div className="ui-label">FIRST<b>首条</b></div>
        <div className="ct-ro__v">{stat && (exact || count.kind === 'min') ? `${exact ? '' : '~'}${stat.first.slice(11, 16)}` : '—'}</div>
      </div>
      <div>
        <div className="ui-label">LAST<b>末条</b></div>
        <div className="ct-ro__v">{stat && (exact || count.kind === 'min') ? `${exact ? '' : '~'}${stat.last.slice(11, 16)}` : '—'}</div>
      </div>
      {!exact && <div className="ct-ro__note">这一天还没全部载入，数字只算了已经载入的部分。</div>}
    </div>
  );
}

function Neighbors({ day, countFor, minDay, maxDay, onPick }: {
  day: string | null; countFor: (day: string) => Count; minDay?: string; maxDay?: string; onPick: (day: string) => void;
}) {
  if (!day) return <div className="ct-note">—</div>;
  const days = [-3, -2, -1, 0, 1, 2, 3].map(n => addDays(day, n));
  const counts = days.map(d => countFor(d));
  const max = Math.max(1, ...counts.map(c => c.n));
  return (
    <div className="ct-nb">
      {days.map((d, i) => {
        const c = counts[i];
        const out = (minDay && d < minDay) || (maxDay && d > maxDay);
        return (
          <button key={d} type="button" className={cx('ct-nb__row', d === day && 'is-on', c.kind !== 'exact' && 'is-partial')}
            disabled={!!out} onClick={() => onPick(d)} title={`跳到 ${d}`}>
            <span className="ct-nb__d">{d.slice(5)} {weekdayEn(d)}</span>
            <span className="ct-nb__bar">{c.kind !== 'unknown' && c.n > 0 && <i style={{ width: `${(c.n / max) * 100}%` }} />}</span>
            <span className="ct-nb__n">{out ? '' : c.kind === 'exact' ? c.n : c.kind === 'min' ? `≥${c.n}` : '—'}</span>
          </button>
        );
      })}
    </div>
  );
}

// ——— 24 log ———

interface ListProps {
  msgs: ChatPageMessage[];
  isGroup: boolean;
  target: string | null;
  targetLabel: string;
  terms: string[];
  onPreview: (m: ChatPageMessage) => void;
  countFor: (day: string) => Count;
  /** Only here so a privacy toggle re-renders the memoized list. */
  privacy: boolean;
}

const isSystem = (m: ChatPageMessage) => m.type === 'system' || m.type === 'revoke';

const MessageList = memo(function MessageList({ msgs, isGroup, target, targetLabel, terms, onPreview, countFor }: ListProps) {
  const rows: ReactNode[] = [];
  let prev: ChatPageMessage | null = null;
  for (const m of msgs) {
    const day = dayOf(m.time);
    const newDay = !prev || dayOf(prev.time) !== day;
    if (newDay) {
      const c = countFor(day);
      rows.push(
        <div key={`d-${day}-${m.id}`} className="ct-day" role="separator" data-day={day}>
          <b>{day}</b>
          <span>{weekdayEn(day)}</span>
          {c.kind !== 'unknown' && c.n > 0 && <span>· {c.kind === 'exact' ? '' : '≥ '}{c.n} MSG</span>}
        </div>,
      );
    }
    if (isSystem(m)) {
      rows.push(
        <div key={m.id} data-mid={m.id} className={cx('ct-sys', m.id === target && 'is-target')}>
          <span className="ct-sys__t">{clockSec(m.time)}</span>
          <span className="ct-sys__m">
            {isStub(m.text, m.type) ? typeLabel(m.type) : <Highlight text={maskText(m.text)} terms={terms} />}
          </span>
        </div>,
      );
    } else {
      const startsGroup = newDay || !prev || isSystem(prev) || prev.from_id !== m.from_id || m.ts - prev.ts > GROUP_GAP_S;
      rows.push(
        <MessageRow
          key={m.id}
          m={m}
          startsGroup={startsGroup}
          flag={m.id === target ? targetLabel : null}
          terms={terms}
          onPreview={onPreview}
        />,
      );
    }
    prev = m;
  }
  return <div className={cx('ct-log', isGroup && 'ct-log--group')}>{rows}</div>;
});

function MessageRow({ m, startsGroup, flag, terms, onPreview }: {
  m: ChatPageMessage; startsGroup: boolean; flag: string | null;
  terms: string[]; onPreview: (m: ChatPageMessage) => void;
}) {
  const self = m.from_id === 'self';
  const name = displayName(m.from_id, m.from);
  const who = self ? '你' : code(name);
  const media = m.media && m.media.url ? m.media : null;
  return (
    <div
      data-mid={m.id}
      className={cx('ct-row', self && 'is-self', startsGroup && 'is-start', flag && 'is-target', media && 'is-media')}
    >
      <time className="ct-row__t" dateTime={m.time}>{clockSec(m.time)}</time>
      <span className="ct-row__w" title={self ? '你' : name}>{startsGroup ? who : ''}</span>
      <div className="ct-row__m">
        <MessageBody m={m} terms={terms} onPreview={onPreview} />
      </div>
      {flag && <span className="ct-row__flag">{flag}</span>}
    </div>
  );
}

function MessageBody({ m, terms, onPreview }: { m: ChatPageMessage; terms: string[]; onPreview: (m: ChatPageMessage) => void }) {
  if (m.media) return <MediaThumb m={m} onPreview={onPreview} />;
  const text = m.text || '';
  if (m.type === 'share') {
    const quote = splitQuote(text);
    if (quote) {
      return (
        <>
          <div className="ct-quote">
            <IconQuote size={12} />
            <span>
              {quote.who && <span className="ct-quote__who">{maskText(quote.who)}：</span>}
              {maskText(quote.quoted)}
            </span>
          </div>
          {quote.reply && <div className="ct-text"><Highlight text={maskText(quote.reply)} terms={terms} /></div>}
        </>
      );
    }
    const share = splitShare(text);
    if (share) {
      return (
        <div className="ct-share">
          <span className="ct-type"><TypeIcon type="share" size={12} />{share.label}</span>
          <span className="ct-share__body"><Highlight text={maskText(share.body)} terms={terms} /></span>
        </div>
      );
    }
  }
  if (m.type !== 'text' && isStub(text, m.type)) return <TypeTag type={m.type} />;
  return <div className="ct-text"><Highlight text={maskText(text)} terms={terms} /></div>;
}

function TypeTag({ type, note }: { type: string; note?: string }) {
  return (
    <span className="ct-type">
      <TypeIcon type={type} size={12} />
      {typeLabel(type)}
      {note && <span className="ct-type__note">· {note}</span>}
    </span>
  );
}

function MediaThumb({ m, onPreview }: { m: ChatPageMessage; onPreview: (m: ChatPageMessage) => void }) {
  const privacy = usePrivacy();
  const [failed, setFailed] = useState(false);
  const media = m.media!;
  if (!media.url) return <TypeTag type={media.kind} note="本机没有这个文件" />;
  if (failed) return <TypeTag type={media.kind} note="加载失败" />;
  const src = mediaUrl(media.url);
  const label = media.kind === 'image' ? '查看图片' : '播放视频';
  return (
    <button
      type="button"
      className={cx('ct-media', `ct-media--${media.kind}`, privacy && 'is-private')}
      onClick={() => onPreview(m)}
      aria-label={label}
      title={privacy ? `${label}（隐私模式下缩略图已模糊）` : label}
    >
      {media.kind === 'image' ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <>
          <video src={src} muted playsInline preload="metadata" onError={() => setFailed(true)} />
          <span className="ct-media__play"><IconPlay size={16} /></span>
        </>
      )}
      <span className="ct-media__k">{media.kind === 'image' ? 'IMG' : 'VID'}</span>
    </button>
  );
}

function MediaPreview({ msg, onClose }: { msg: ChatPageMessage | null; onClose: () => void }) {
  const media = msg?.media && msg.media.url ? msg.media : null;
  return (
    <Dialog
      open={!!media}
      onClose={onClose}
      size="lg"
      eyebrow={media?.kind === 'video' ? 'VIDEO' : 'IMAGE'}
      title={media?.kind === 'video' ? '视频' : '图片'}
      description={msg ? `${msg.from_id === 'self' ? '你' : displayName(msg.from_id, msg.from)} · ${formatDay(dayOf(msg.time))} ${clockSec(msg.time)}` : undefined}
      className="ct-preview-dialog"
    >
      {media && msg && (
        <div className="ct-preview">
          {media.kind === 'image'
            ? <img src={mediaUrl(media.url!)} alt="" />
            : <video src={mediaUrl(media.url!)} controls autoPlay playsInline />}
        </div>
      )}
    </Dialog>
  );
}

// ——— states ———

function ChatSkeleton() {
  const widths = [46, 30, 62, 38, 24, 54, 36, 48, 28, 58, 40, 33];
  return (
    <div className="ct-log ct-log--skel" aria-busy="true" aria-label="正在加载聊天记录">
      <div className="ct-day"><Skeleton width={150} height={10} /></div>
      {widths.map((w, i) => (
        <div key={i} className="ct-row">
          <span className="ct-row__t"><Skeleton width={52} height={10} /></span>
          <span className="ct-row__w"><Skeleton width={20} height={10} /></span>
          <span className="ct-row__m"><Skeleton width={`${w}%`} height={13} /></span>
        </div>
      ))}
    </div>
  );
}

function ChatError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = errorCode(error);
  const entry = lookupError(code);
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return (
    <ErrorState
      layout="page"
      title={entry?.title ?? '聊天记录没能加载'}
      code={code ?? undefined}
      reason={entry?.reason ?? '读取这个会话的消息时出错了。'}
      fixes={entry ? [entry.fix] : ['点「重试」再读一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
      onRetry={onRetry}
      details={raw ? <pre>{maskText(raw)}</pre> : undefined}
    />
  );
}
