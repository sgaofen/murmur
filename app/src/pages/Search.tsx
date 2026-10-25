/* 检索 (#/search?q=…) — modules 28–34 on the instrument rack.
 *
 *   28  query      the words, mode (关键词 / 按意思), FROM, RANGE, HITS / SESSIONS / TIME
 *   29  结果       hits grouped by conversation, newest first; 「加载更多」 pages on
 *   30  按会话     31 按年份   32 谁说的      (from a sample of the hits, see below)
 *   33  最近搜索   (this window only — never written to disk)
 *   34  索引       keyword index state, rebuild; semantic availability
 *
 * Keyword search: GET /api/search (cli/search_index.py). Semantic search
 * (cli/semantic_index.py) is offered only when /api/search/semantic/status
 * says it is ready; missing endpoint / not installed / turned off / still
 * preparing all fall back to keyword-only with a one-line note — never an error.
 *
 * The API has no per-session or per-year totals, so 30/31 count a sample: the
 * newest STATS_CAP hits (all of them when there are fewer, and then the
 * numbers are exact). 32 asks the index once more with sender=self, which is
 * exact. Every module says which it is.
 *
 * Styles: ./Search.css (prefix sr-); keyword marks use .chat-mark from ./Chat.css. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  SemanticUnavailableError, chatCursorFor, errorCode, getSearchStatus, getSemanticStatus,
  rebuildSearchIndex, searchMessages, searchSemantic,
} from '../data/api';
import type {
  SearchHit, SearchIndexStatus, SearchResponse, SemanticSearchHit, SemanticSearchResponse, SemanticStatus,
} from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { Button, EmptyState, ErrorState, Module, SegmentedControl, Skeleton, cx } from '../ui';
import { IconRefresh, IconSearch, IconSparkle } from '../ui/icons';
import { PageHeader } from '../shell/PageHeader';
import { displayName, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { usePageKeys } from '../utils/usePageKeys';
import { searchQuery } from '../utils/searchLinks';
import { rerunOnLanding, rerunWhenReady } from '../utils/searchRerun';
import type { ShownSearch } from '../utils/searchRerun';
import { TypeIcon, clockOf, dayOf, isStub, normType, typeLabel } from '../components/chatBits';
import './Chat.css';
import './Search.css';

const PAGE_SIZE = 50;
const SEMANTIC_PAGE = 20;
/** How many of the newest hits 30/31 count (the API pages at most 200). */
const STATS_CAP = 1000;
/** …and when the index has no tokenizer (LIKE scans), only one page. */
const STATS_CAP_LIKE = 200;
const GROUP_PREVIEW = 3;

type Mode = 'keyword' | 'semantic';
type Who = 'all' | 'self';
type Hit = SearchHit | SemanticSearchHit;
type Range = { from: string; to: string };

interface Results {
  key: number;    // request number of the first page
  q: string;
  mode: Mode;
  who: Who;
  dates: Range;
  hits: Hit[];
  total: number;
  match: SearchResponse['match'] | 'semantic';
  note: string;   // short-query note from the index, when relevant
  ms: number;     // first page, wall clock
}

export interface SearchPageProps {
  /** The hash's query part: q=<keywords>[&mode=semantic][&from=&to=][&who=self]. */
  query: string;
  navigate: (path: string) => void;
}

// ——— semantic availability ———

type SemanticView =
  | { usable: true; note: string | null }
  | { usable: false; note: string };

function semanticView(st: SemanticStatus | null, unreachable: boolean): SemanticView {
  if (unreachable || !st) {
    return { usable: false, note: '当前后端没有语义搜索功能，只用关键词搜索。' };
  }
  const idx = st.index;
  switch (st.state) {
    case 'ready':
      return { usable: true, note: idx?.stale ? '关键词索引重建过，语义索引会在下次更新时补上。' : null };
    case 'building':
      if (idx && idx.chunks > 0) return { usable: true, note: `语义索引正在更新（${Math.round(idx.percent)}%），结果可能不全。` };
      return { usable: false, note: `语义索引正在建立（${Math.round(idx?.percent ?? 0)}%），建好前先用关键词搜索。` };
    case 'not_installed':
      return { usable: false, note: '语义搜索（按意思找）是可选功能，需要另外安装依赖，现在只用关键词搜索。' };
    case 'disabled':
      return { usable: false, note: '语义搜索（按意思找）默认关闭，现在只用关键词搜索。' };
    case 'model_missing':
    case 'downloading':
      return { usable: false, note: '语义搜索还缺本机模型，准备好之前只用关键词搜索。' };
    case 'empty':
      return { usable: false, note: '语义索引还没建立，现在只用关键词搜索。' };
    default:
      return { usable: false, note: '语义搜索暂时不可用，现在只用关键词搜索。' };
  }
}

// ——— fetching ———

interface Fetched {
  hits: Hit[];
  total: number;
  match: Results['match'];
  note: string;
  index?: SearchIndexStatus;
}

async function fetchResults(q: string, m: Mode, offset: number, range: { from?: string; to?: string }, who: Who): Promise<Fetched> {
  const sender = who === 'self' ? 'self' : undefined;
  if (m === 'semantic') {
    const r: SemanticSearchResponse = await searchSemantic({ q, limit: SEMANTIC_PAGE, offset, sender, ...range });
    return { hits: r.results, total: r.total, match: 'semantic', note: '' };
  }
  const r: SearchResponse = await searchMessages({ q, limit: PAGE_SIZE, offset, sender, ...range });
  const note = r.match !== 'fts' ? (r.index?.short_query_note || '') : '';
  return { hits: r.results, total: r.total, match: r.match, note, index: r.index };
}

// ——— recent searches: module memory, gone when the window closes ———

interface Recent { q: string; mode: Mode; who: Who; dates: Range; total: number; at: number }
let RECENT: Recent[] = [];

function remember(r: Recent): Recent[] {
  RECENT = [r, ...RECENT.filter(x => !(x.q === r.q && x.mode === r.mode && x.who === r.who
    && x.dates.from === r.dates.from && x.dates.to === r.dates.to))].slice(0, 6);
  return RECENT;
}

// ——— small helpers ———

const fmt = (n: number) => n.toLocaleString('en-US');

function code(name: string): string {
  const m = /^(?:朋友|群)\s*(\S{1,3})$/.exec(name);
  return m ? m[1] : name;
}

/** MM-DD HH:MM in this computer's time zone. */
function stamp(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ——— page ———

export function SearchPage({ query, navigate }: SearchPageProps) {
  void usePrivacy();
  const initial = useMemo(() => new URLSearchParams(query), [query]);
  const [input, setInput] = useState(initial.get('q') || '');
  const [mode, setMode] = useState<Mode>(initial.get('mode') === 'semantic' ? 'semantic' : 'keyword');
  const [who, setWho] = useState<Who>(initial.get('who') === 'self' ? 'self' : 'all');
  const [from, setFrom] = useState(initial.get('from') || '');
  const [to, setTo] = useState(initial.get('to') || '');

  const [index, setIndex] = useState<SearchIndexStatus | null>(null);
  const [indexError, setIndexError] = useState<unknown>(null);
  const [semantic, setSemantic] = useState<SemanticView | null>(null);

  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState<'idle' | 'search' | 'more'>('idle');
  const [searchError, setSearchError] = useState<unknown>(null);
  const [recent, setRecent] = useState<Recent[]>(RECENT);
  const reqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The search on screen, and whether it ran against a half-built index —
  // when the build finishes it is run again so the results are complete
  // (unless a newer search is already in flight: see utils/searchRerun.ts).
  const lastRef = useRef<ShownSearch<Mode> | null>(null);
  const indexStateRef = useRef<SearchIndexStatus['state'] | null>(null);
  const rerunRef = useRef<() => void>(() => {});
  const whoRef = useRef<Who>(who);
  whoRef.current = who;

  // Index status: also starts an incremental update when needed; poll while building.
  const [statusNonce, setStatusNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const st = await getSearchStatus();
        if (cancelled) return;
        const was = indexStateRef.current;
        indexStateRef.current = st.state;
        setIndex(st);
        setIndexError(null);
        if (st.state === 'building') timer = window.setTimeout(tick, 1500);
        else if (was === 'building' && st.state === 'ready') rerunRef.current();
      } catch (e) {
        if (!cancelled) setIndexError(e);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [statusNonce]);

  // Optional semantic mode: any failure here just means "keyword only".
  useEffect(() => {
    let cancelled = false;
    getSemanticStatus()
      .then(st => { if (!cancelled) setSemantic(semanticView(st, false)); })
      .catch(() => { if (!cancelled) setSemantic(semanticView(null, true)); });
    return () => { cancelled = true; };
  }, []);

  const semanticUsable = !!semantic?.usable;
  const effectiveMode: Mode = mode === 'semantic' && semanticUsable ? 'semantic' : 'keyword';

  const run = useCallback(async (q: string, m: Mode, offset: number, prev: Results | null, dates?: Range,
    isRerun = false, whoArg?: Who) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const req = ++reqRef.current;
    // 「加载更多」 continues the search on screen, so it stays the one to re-run.
    if (offset > 0 && lastRef.current) lastRef.current = { ...lastRef.current, req };
    setBusy(offset ? 'more' : 'search');
    setSearchError(null);
    const d = dates ?? { from, to };
    const w = whoArg ?? (offset > 0 && prev ? prev.who : whoRef.current);
    const range = { from: d.from || undefined, to: d.to || undefined };
    const t0 = performance.now();
    try {
      let out: Fetched;
      let usedMode = m;
      let append = offset > 0 && prev !== null;
      try {
        out = await fetchResults(trimmed, m, offset, range, w);
      } catch (e) {
        if (!(e instanceof SemanticUnavailableError)) throw e;
        // Became unavailable between the status check and now — drop to keyword.
        if (req !== reqRef.current) return;
        setSemantic(semanticView(e.status, false));
        setMode('keyword');
        usedMode = 'keyword';
        out = await fetchResults(trimmed, 'keyword', 0, range, w);
        append = false;
      }
      if (req !== reqRef.current) return;
      if (out.index) setIndex(out.index);
      if (append && prev) {
        setResults({ ...prev, hits: [...prev.hits, ...out.hits], total: out.total });
      } else {
        const next: Results = {
          key: req, q: trimmed, mode: usedMode, who: w, dates: d,
          hits: out.hits, total: out.total, match: out.match, note: out.note,
          ms: performance.now() - t0,
        };
        setResults(next);
        const building = (out.index?.state ?? indexStateRef.current) === 'building';
        const shown: ShownSearch<Mode> = { req, q: trimmed, mode: next.mode, dates: d, partial: building };
        lastRef.current = shown;
        if (!isRerun) setRecent(remember({ q: trimmed, mode: next.mode, who: w, dates: d, total: out.total, at: Date.now() / 1000 }));
        if (rerunOnLanding(shown, indexStateRef.current, isRerun)) rerunRef.current();
      }
    } catch (e) {
      if (req !== reqRef.current) return;
      setSearchError(e);
    }
    if (req === reqRef.current) setBusy('idle');
  }, [from, to]);

  // The index finished building under a search that ran against part of it:
  // run that search again (same words, mode and dates) so nothing is missing.
  rerunRef.current = () => {
    const last = rerunWhenReady(lastRef.current, reqRef.current);
    if (!last) return;
    lastRef.current = { ...last, partial: false };
    void run(last.q, last.mode, 0, null, last.dates, true);
  };

  // Keep the query in the URL (no history entry) so 「返回」 from a chat restores it.
  const keepInUrl = (q: string, m: Mode, d: Range = { from, to }, w: Who = who) => {
    const s = searchQuery(q, m, d, w);
    try {
      window.history.replaceState(window.history.state, '', `#/search${s ? '?' + s : ''}`);
    } catch {
      /* sandboxed history — the search still works */
    }
  };

  // Run the search that came in through the URL once the mode is known.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (ranInitial.current || semantic === null) return;
    ranInitial.current = true;
    const q = initial.get('q');
    if (q) void run(q, effectiveMode, 0, null);
  }, [semantic, initial, effectiveMode, run]);

  const onSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = input.trim();
    if (!q) {
      inputRef.current?.focus();
      return;
    }
    keepInUrl(q, effectiveMode);
    void run(q, effectiveMode, 0, null);
  };

  const onMode = (v: string) => {
    const m = v as Mode;
    setMode(m);
    const q = input.trim();
    if (q) {
      keepInUrl(q, m);
      void run(q, m, 0, null);
    }
  };

  const onWho = (v: string) => {
    const w = v as Who;
    setWho(w);
    const q = input.trim();
    if (q && (results || searchError)) {
      keepInUrl(q, effectiveMode, { from, to }, w);
      void run(q, effectiveMode, 0, null, undefined, false, w);
    }
  };

  // A new date range re-runs the search on screen (debounced: typing a year
  // into a date field fires a change per digit).
  const rangeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(rangeTimer.current), []);
  const onRange = (d: Range) => {
    setFrom(d.from);
    setTo(d.to);
    window.clearTimeout(rangeTimer.current);
    const q = input.trim();
    if (!q || (!results && !searchError)) return;
    rangeTimer.current = window.setTimeout(() => {
      keepInUrl(q, effectiveMode, d);
      void run(q, effectiveMode, 0, null, d);
    }, 400);
  };

  const onRecent = (r: Recent) => {
    setInput(r.q);
    setMode(r.mode);
    setWho(r.who);
    setFrom(r.dates.from);
    setTo(r.dates.to);
    const m: Mode = r.mode === 'semantic' && semanticUsable ? 'semantic' : 'keyword';
    keepInUrl(r.q, m, r.dates, r.who);
    void run(r.q, m, 0, null, r.dates, false, r.who);
  };

  // `back` carries the whole search (words, mode, dates, who) so the chat
  // page's 「返回」 lands on the same results, not just the same words.
  const backQuery = () => searchQuery(results?.q ?? input.trim(), results?.mode ?? effectiveMode,
    lastRef.current?.dates ?? { from, to }, results?.who ?? who);
  const openHit = (h: Hit, q: string) => {
    const p = new URLSearchParams({ m: chatCursorFor(h), from: 'search' });
    if (q) p.set('q', q);
    const back = backQuery();
    if (back) p.set('back', back);
    navigate(`chat/${encodeURIComponent(h.chat)}?${p}`);
  };
  // Every hit in one chat: the chat page's own FIND runs the same words there.
  const openChatFind = (chat: string, q: string) => {
    const p = new URLSearchParams({ q, from: 'search' });
    const back = backQuery();
    if (back) p.set('back', back);
    navigate(`chat/${encodeURIComponent(chat)}?${p}`);
  };

  const rebuild = async () => {
    try {
      const st = await rebuildSearchIndex();
      setIndex(st);
    } catch (e) {
      setIndexError(e);
    }
    setStatusNonce(n => n + 1);
  };

  usePageKeys({ '/': () => { inputRef.current?.focus(); inputRef.current?.select(); } });

  // ——— stats sample (modules 30–32) ———
  const stats = useStats(results, index?.mode === 'like');
  const groups = useMemo(() => (results ? groupHits(results.hits) : []), [results]);

  const noData = errorCode(indexError) === 'NO_DECRYPTED_DATA';
  const unreachable = !!indexError && !noData && !index;
  const hasHits = !!results && results.hits.length > 0 && !searchError;

  let body;
  if (noData) {
    body = (
      <EmptyState
        className="sr-state"
        label="NO DATA"
        icon={<IconSearch size={22} />}
        title="还没有可搜索的聊天记录"
        description="完成初始化（抓密钥并解密）之后，Murmur 会在本机建立搜索索引，之后就能在这里搜全部聊天。"
        actions={<Button variant="secondary" onClick={() => navigate('')}>回到首页</Button>}
      />
    );
  } else if (unreachable && !results) {
    body = <SearchError error={indexError} onRetry={() => setStatusNonce(n => n + 1)} />;
  } else if (searchError) {
    body = <SearchError error={searchError} onRetry={() => onSubmit()} />;
  } else if (busy === 'search' && !results) {
    body = <ResultsSkeleton />;
  } else if (results) {
    body = (
      <ResultList
        results={results}
        groups={groups}
        stats={stats}
        loadingMore={busy === 'more'}
        stale={busy === 'search'}
        onOpen={openHit}
        onOpenChat={openChatFind}
        onMore={() => void run(results.q, results.mode, results.hits.length, results)}
        semanticUsable={semanticUsable && results.mode === 'keyword'}
        onTrySemantic={() => onMode('semantic')}
        onClearFilters={(from || to || who !== 'all') ? () => {
          setWho('all');
          setFrom('');
          setTo('');
          keepInUrl(results.q, results.mode, { from: '', to: '' }, 'all');
          void run(results.q, results.mode, 0, null, { from: '', to: '' }, false, 'all');
        } : undefined}
      />
    );
  } else {
    body = <Idle />;
  }

  const sessions = stats.sample ? new Set(stats.sample.map(s => s.chat)).size : groups.length;
  const sessionsExact = stats.sample ? stats.complete : !!results && results.hits.length >= results.total;

  return (
    <div className="sr-page">
      <PageHeader title="检索" subtitle="全部聊天记录 · 索引只在本机" />
      <div className="sr-rack ui-rack">
        {/* ——— 28 query ——— */}
        <Module className="sr-q" aria-label="检索条件">
          <form className="sr-q__in" role="search" onSubmit={onSubmit}>
            <div className="ui-label"><span className="sr-q__id">28</span>QUERY<b>{effectiveMode === 'semantic' ? '按意思 · 全部会话' : '全部会话'}</b></div>
            <div className="sr-q__row">
              <span className="sr-q__prompt" aria-hidden="true">&gt;</span>
              <input
                ref={inputRef}
                className="sr-q__input"
                type="search"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={effectiveMode === 'semantic' ? '描述你想找的内容，比如「一起去看海的那次」' : '一句话、一个词，多个词用空格分开'}
                aria-label="搜索聊天记录"
                autoFocus
                enterKeyHint="search"
                spellCheck={false}
              />
              <Button size="sm" variant="primary" type="submit" kbd={busy === 'search' ? undefined : '↵'} loading={busy === 'search'}>检索</Button>
            </div>
          </form>
          <div className="sr-q__ro" aria-live="polite">
            <Readout en="HITS" zh="命中" v={results && !searchError ? fmt(results.total) : '—'} />
            <Readout en="SESSIONS" zh="会话" v={hasHits ? `${sessionsExact ? '' : '≥'}${fmt(sessions)}` : '—'} />
            <Readout en="TIME" zh="用时" v={results && !searchError ? (results.ms / 1000).toFixed(2) : '—'} unit={results && !searchError ? 'S' : undefined} />
          </div>
          <div className="sr-q__ctl">
            {semanticUsable && (
              <div className="sr-ctl">
                <span className="ui-label">MODE</span>
                <SegmentedControl
                  label="搜索方式"
                  size="sm"
                  value={effectiveMode}
                  onChange={onMode}
                  options={[
                    { value: 'keyword', label: '关键词' },
                    { value: 'semantic', label: '按意思', icon: <IconSparkle size={12} /> },
                  ]}
                />
              </div>
            )}
            <div className="sr-ctl">
              <span className="ui-label">FROM</span>
              <SegmentedControl
                label="谁说的"
                size="sm"
                value={who}
                onChange={onWho}
                options={[{ value: 'all', label: '所有人' }, { value: 'self', label: '你' }]}
              />
            </div>
            <div className="sr-ctl">
              <span className="ui-label">RANGE</span>
              <div className="sr-range" role="group" aria-label="时间范围">
                <label className="ui-field sr-range__f">
                  <input type="date" className="chat-jump__input" value={from} max={to || undefined}
                    onChange={(e) => onRange({ from: e.target.value, to })} aria-label="开始日期" />
                </label>
                <span className="sr-range__dash" aria-hidden="true">→</span>
                <label className="ui-field sr-range__f">
                  <input type="date" className="chat-jump__input" value={to} min={from || undefined}
                    onChange={(e) => onRange({ from, to: e.target.value })} aria-label="结束日期" />
                </label>
                {(from || to) && (
                  <Button size="sm" variant="ghost" onClick={() => onRange({ from: '', to: '' })}>清除</Button>
                )}
              </div>
            </div>
          </div>
        </Module>

        {/* ——— 29 results ——— */}
        <Module
          id="29" title="结果" className="sr-res"
          en={results?.mode === 'semantic' ? 'GROUPED BY SESSION · CLOSEST FIRST' : 'GROUPED BY SESSION · NEWEST FIRST'}
          right={hasHits ? (
            <span className="sr-res__r">
              {groups.length} GROUPS<i>·</i>LOADED {fmt(results!.hits.length)} / {fmt(results!.total)}
            </span>
          ) : undefined}
        >
          <IndexStrip index={index} onRebuild={rebuild} />
          {body}
        </Module>

        {/* ——— side ——— */}
        <div className="sr-side">
          <div className="sr-side__in">
            {hasHits && (
              <>
                <BySession stats={stats} results={results!} groups={groups} onOpenChat={openChatFind} />
                <ByYear stats={stats} semantic={results!.mode === 'semantic'} dates={{ from, to }} onPick={onRange} />
                <BySender stats={stats} results={results!} />
              </>
            )}
            <RecentModule recent={recent} onPick={onRecent} />
            <IndexModule
              index={index}
              indexError={unreachable ? indexError : null}
              noData={noData}
              semantic={semantic}
              onRebuild={rebuild}
              onRetry={() => setStatusNonce(n => n + 1)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Readout({ en, zh, v, unit }: { en: string; zh: string; v: string; unit?: string }) {
  return (
    <div className="sr-ro">
      <div className="ui-label">{en}<b>{zh}</b></div>
      <div className="ui-big sr-ro__v">{v}{unit && <small>{unit}</small>}</div>
    </div>
  );
}

// ——— stats sample ———

/** `year` comes from the hit's own `time` (China time, like every date the hits show). */
interface Sample { chat: string; name: string; isGroup: boolean; ts: number; year: number; month: number; self: boolean }

interface Stats {
  /** null until the first page is on screen. */
  sample: Sample[] | null;
  /** The sample is every hit, so 30/31 are exact. */
  complete: boolean;
  /** Hits counted (sample size) and what they were taken from. */
  counted: number;
  total: number;
  /** Exact count of your own hits (one extra request), null when unknown. */
  selfTotal: number | null;
  loading: boolean;
}

const toSample = (h: Hit): Sample => ({
  chat: h.chat, name: h.chat_name, isGroup: h.is_group, ts: h.ts,
  year: Number(h.time.slice(0, 4)), month: Number(h.time.slice(5, 7)), self: h.sender === 'self',
});

function useStats(results: Results | null, likeMode: boolean): Stats {
  const [fetched, setFetched] = useState<{ key: number; sample: Sample[]; selfTotal: number | null } | null>(null);
  const resRef = useRef(results);
  resRef.current = results;
  const key = results?.key ?? null;
  const mode = results?.mode ?? null;

  useEffect(() => {
    const r = resRef.current;
    if (key == null || !r || mode !== 'keyword' || !r.hits.length) return;
    let cancelled = false;
    const cap = Math.min(r.total, likeMode ? STATS_CAP_LIKE : STATS_CAP);
    const range = { from: r.dates.from || undefined, to: r.dates.to || undefined };
    const sender = r.who === 'self' ? 'self' : undefined;
    (async () => {
      let sample = r.hits.map(toSample);
      if (sample.length < cap) {
        const acc: Sample[] = [];
        for (let off = 0; off < cap; off += 200) {
          const page = await searchMessages({ q: r.q, limit: Math.min(200, cap - off), offset: off, sender, ...range });
          if (cancelled) return;
          acc.push(...page.results.map(toSample));
          if (page.results.length < Math.min(200, cap - off)) break;
        }
        sample = acc;
      }
      let selfTotal: number | null = r.who === 'self' ? r.total : null;
      if (r.who === 'all') {
        if (sample.length >= r.total) selfTotal = sample.filter(s => s.self).length;
        else {
          const mine = await searchMessages({ q: r.q, sender: 'self', limit: 1, ...range });
          if (cancelled) return;
          selfTotal = mine.total;
        }
      }
      if (!cancelled) setFetched({ key, sample, selfTotal });
    })().catch(() => { /* the modules fall back to the loaded hits */ });
    return () => { cancelled = true; };
  }, [key, mode, likeMode]);

  if (!results) return { sample: null, complete: false, counted: 0, total: 0, selfTotal: null, loading: false };
  const loaded = results.hits.map(toSample);
  if (fetched && fetched.key === results.key && fetched.sample.length >= loaded.length) {
    return {
      sample: fetched.sample, complete: fetched.sample.length >= results.total,
      counted: fetched.sample.length, total: results.total, selfTotal: fetched.selfTotal, loading: false,
    };
  }
  const complete = loaded.length >= results.total;
  return {
    sample: loaded, complete, counted: loaded.length, total: results.total,
    selfTotal: results.who === 'self' ? results.total : complete ? loaded.filter(s => s.self).length : null,
    loading: results.mode === 'keyword' && !complete,
  };
}

function sampleNote(stats: Stats, semantic: boolean): string {
  if (stats.complete) return `全部 ${fmt(stats.total)} 条`;
  if (semantic) return `最接近的 ${fmt(stats.counted)} 条`;
  return `${stats.loading ? '正在统计 · ' : ''}最新 ${fmt(stats.counted)} 条`;
}

// ——— results ———

interface Group {
  chat: string;
  name: string;
  isGroup: boolean;
  hits: Hit[];
}

function groupHits(hits: Hit[]): Group[] {
  const map = new Map<string, Group>();
  for (const h of hits) {
    let g = map.get(h.chat);
    if (!g) {
      g = { chat: h.chat, name: h.chat_name, isGroup: h.is_group, hits: [] };
      map.set(h.chat, g);
    }
    g.hits.push(h);
  }
  return [...map.values()];
}

const groupDomId = (chat: string) => `sr-g-${chat}`;

function filterWords(r: Results): string {
  const range = r.dates.from || r.dates.to;
  if (range && r.who === 'self') return '在这个时间范围里、你自己说的话中';
  if (range) return '在这个时间范围里';
  return '你自己说的话里';
}

function ResultList({ results, groups, stats, loadingMore, stale, onOpen, onOpenChat, onMore, semanticUsable, onTrySemantic, onClearFilters }: {
  results: Results;
  groups: Group[];
  stats: Stats;
  loadingMore: boolean;
  stale: boolean;
  onOpen: (h: Hit, q: string) => void;
  onOpenChat: (chat: string, q: string) => void;
  onMore: () => void;
  semanticUsable: boolean;
  onTrySemantic: () => void;
  onClearFilters?: () => void;
}) {
  // Per-chat counts and the time axis for the density strips, from the sample.
  const { perChat, span, topChat } = useMemo(() => {
    const per = new Map<string, Sample[]>();
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of stats.sample ?? []) {
      let a = per.get(s.chat);
      if (!a) { a = []; per.set(s.chat, a); }
      a.push(s);
      lo = Math.min(lo, s.ts);
      hi = Math.max(hi, s.ts);
    }
    let top: string | null = null;
    for (const [chat, a] of per) if (!top || a.length > (per.get(top)?.length ?? 0)) top = chat;
    return { perChat: per, span: Number.isFinite(lo) ? [lo, hi] as const : null, topChat: top };
  }, [stats.sample]);

  if (!results.hits.length) {
    const semantic = results.mode === 'semantic';
    return (
      <EmptyState
        className="sr-state"
        label="NO HITS"
        icon={<IconSearch size={22} />}
        title={`没有找到「${maskText(results.q)}」`}
        description={semantic
          ? '换一种说法试试，或者切回「关键词」找原话。'
          : onClearFilters
            ? `${filterWords(results)}没有命中。放宽条件，或者换个说法、少打几个字。`
            : '换个说法、少打几个字再试。'}
        actions={(semanticUsable || onClearFilters) ? (
          <>
            {onClearFilters && <Button variant="secondary" onClick={onClearFilters}>清掉条件再搜</Button>}
            {semanticUsable && <Button variant="secondary" icon={<IconSparkle size={14} />} onClick={onTrySemantic}>改用「按意思」搜索</Button>}
          </>
        ) : undefined}
      />
    );
  }
  const shown = results.hits.length;
  const rest = Math.max(0, results.total - shown);
  const semantic = results.mode === 'semantic';
  return (
    <div className={cx('sr-list', stale && 'is-stale')} aria-busy={stale || undefined}>
      {results.note && (
        <div className="sr-strip" role="note">
          <span className="ui-label">NOTE</span>
          <span className="sr-strip__t">{results.note}</span>
        </div>
      )}
      {groups.map((g, i) => (
        <ResultGroup
          key={g.chat}
          no={i + 1}
          group={g}
          q={results.q}
          semantic={semantic}
          known={perChat.get(g.chat) ?? null}
          exact={stats.complete}
          span={span}
          lead={g.chat === topChat}
          onOpen={onOpen}
          onOpenChat={onOpenChat}
        />
      ))}
      <div className="sr-end">
        <span className="sr-end__t">
          {rest > 0
            ? <>LOADED <b>{fmt(shown)}</b> / {fmt(results.total)}</>
            : <>END<i>·</i>{results.total === 1 ? '只有这一条' : `${fmt(results.total)} 条全部在这里`}</>}
        </span>
        {rest > 0 && (
          <Button size="sm" variant="secondary" loading={loadingMore} onClick={onMore}>
            再载入 {Math.min(rest, semantic ? SEMANTIC_PAGE : PAGE_SIZE)} 条
          </Button>
        )}
      </div>
    </div>
  );
}

function ResultGroup({ no, group, q, semantic, known, exact, span, lead, onOpen, onOpenChat }: {
  no: number; group: Group; q: string; semantic: boolean;
  known: Sample[] | null; exact: boolean; span: readonly [number, number] | null; lead: boolean;
  onOpen: (h: Hit, q: string) => void; onOpenChat: (chat: string, q: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = displayName(group.chat, group.name);
  const all = known ?? group.hits.map(toSample);
  const count = Math.max(all.length, group.hits.length);
  const years = all.map(s => s.year);
  const y0 = Math.min(...years);
  const y1 = Math.max(...years);
  const shownHits = open ? group.hits : group.hits.slice(0, GROUP_PREVIEW);
  const hidden = group.hits.length - shownHits.length;
  const beyond = !semantic && (count > group.hits.length || !exact);
  return (
    <section className="sr-g" id={groupDomId(group.chat)} aria-label={name}>
      <div className="sr-g__hd">
        <span className="sr-g__no">{String(no).padStart(2, '0')}</span>
        <span className="sr-g__name" title={name}>{name}</span>
        <span className="sr-g__kind">
          {group.isGroup ? 'GROUP' : 'DM'}<i>·</i>{y0 === y1 ? y0 : `${y0}–${y1}`}
        </span>
        <span className="sr-g__n" title={semantic ? '上面这些结果里属于这个会话的条数' : exact ? '这个会话里的命中数' : '最新的命中里属于这个会话的条数'}>
          {exact || semantic ? '' : '≥'}{fmt(count)}
        </span>
        <Density hits={all} span={span} lead={lead} />
      </div>
      <ul className="sr-hits">
        {shownHits.map(h => (
          <li key={`${h.locator.db}:${h.locator.local_id}:${h.ts}`}>
            <button type="button" className="sr-hit" onClick={() => onOpen(h, q)} title={`${dayOf(h.time)} ${clockOf(h.time)} · 打开这段聊天`}>
              <time className="sr-hit__d" dateTime={h.time}>{dayOf(h.time)}</time>
              <span className={cx('sr-hit__w', h.sender === 'self' && 'is-you')}>
                {h.sender === 'self' ? 'YOU' : code(displayName(h.sender, h.sender_name))}
              </span>
              <span className="sr-hit__s">
                {h.type !== 'text' && (
                  <span className="sr-hit__type"><TypeIcon type={normType(h.type, h.type_code)} size={12} />{typeLabel(normType(h.type, h.type_code))}</span>
                )}
                {semantic && 'chunk' in h ? <SemanticSnippet hit={h} /> : <Snippet hit={h} />}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {(hidden > 0 || open || beyond) && (
        <div className="sr-g__more">
          {hidden > 0 && (
            <button type="button" className="sr-g__btn" onClick={() => setOpen(true)} aria-expanded={false}>
              +{hidden} MORE<i>↵</i>展开
            </button>
          )}
          {open && group.hits.length > GROUP_PREVIEW && (
            <button type="button" className="sr-g__btn" onClick={() => setOpen(false)} aria-expanded>收起</button>
          )}
          {beyond && (
            <button type="button" className="sr-g__btn sr-g__btn--go" onClick={() => onOpenChat(group.chat, q)}>
              在对话里看全部命中 →
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Hits of one chat over the sample's time span, 13 bins. */
function Density({ hits, span, lead }: { hits: Sample[]; span: readonly [number, number] | null; lead: boolean }) {
  const BINS = 13;
  const bins = new Array<number>(BINS).fill(0);
  if (span) {
    const w = Math.max(1, span[1] - span[0]);
    for (const h of hits) bins[Math.min(BINS - 1, Math.floor(((h.ts - span[0]) / w) * BINS))]++;
  }
  const max = Math.max(1, ...bins);
  return (
    <span className={cx('sr-dens', lead && 'is-lead')} aria-hidden="true">
      {bins.map((n, i) => <i key={i} style={{ height: n ? `${Math.max(12, (n / max) * 100)}%` : undefined }} className={n ? undefined : 'is-zero'} />)}
    </span>
  );
}

/** "[image]"-style stubs read as 「[图片]」. */
function stubText(text: string, type: string, code?: number): string | null {
  return isStub(text, type) ? `[${typeLabel(normType(type, code))}]` : null;
}

function Snippet({ hit }: { hit: Hit }) {
  const stub = stubText(hit.snippet, hit.type, hit.type_code);
  if (stub) return <span className="sr-hit__text">{stub}</span>;
  const segs = hit.segments?.length ? hit.segments : [{ text: hit.snippet, hit: false }];
  return (
    <span className="sr-hit__text">
      {segs.map((s, i) => (s.hit
        ? <mark key={i} className="chat-mark">{maskText(s.text)}</mark>
        : <span key={i}>{maskText(s.text)}</span>))}
    </span>
  );
}

/** Semantic hits: the matched message plus one line of context either side. */
function SemanticSnippet({ hit }: { hit: SemanticSearchHit }) {
  const msgs = hit.chunk?.messages || [];
  const a = hit.chunk?.anchor_index ?? 0;
  const before = msgs[a - 1];
  const after = msgs[a + 1];
  const line = (m: (typeof msgs)[number]) =>
    `${m.sender === 'self' ? '你' : code(displayName(m.sender, m.sender_name))}：${stubText(m.text, m.type) ?? maskText(m.text)}`;
  return (
    <span className="sr-hit__ctxs">
      {before && <span className="sr-hit__ctx">{line(before)}</span>}
      <Snippet hit={hit} />
      {after && <span className="sr-hit__ctx">{line(after)}</span>}
    </span>
  );
}

// ——— 30 按会话 ———

function BySession({ stats, results, groups, onOpenChat }: {
  stats: Stats; results: Results; groups: Group[]; onOpenChat: (chat: string, q: string) => void;
}) {
  const rows = useMemo(() => {
    const per = new Map<string, { chat: string; name: string; n: number }>();
    for (const s of stats.sample ?? []) {
      const r = per.get(s.chat);
      if (r) r.n++;
      else per.set(s.chat, { chat: s.chat, name: s.name, n: 1 });
    }
    return [...per.values()].sort((a, b) => b.n - a.n);
  }, [stats.sample]);
  const top = rows.slice(0, 8);
  const max = Math.max(1, ...top.map(r => r.n));
  const loaded = new Set(groups.map(g => g.chat));
  const go = (chat: string) => {
    const el = loaded.has(chat) ? document.getElementById(groupDomId(chat)) : null;
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else onOpenChat(chat, results.q);
  };
  return (
    <Module id="30" title="按会话" en="BY SESSION" right={<span className="sr-side__r">{sampleNote(stats, results.mode === 'semantic')}</span>} className="sr-m30">
      <div className="sr-bars">
        {top.map((r, i) => {
          const name = displayName(r.chat, r.name);
          return (
            <button key={r.chat} type="button" className={cx('sr-bar', i === 0 && 'is-lead')} onClick={() => go(r.chat)}
              title={loaded.has(r.chat) ? `跳到「${name}」那一组` : `打开「${name}」并在对话里找`}>
              <span className="sr-bar__k">{name}</span>
              <span className="sr-bar__t"><i style={{ width: `${(r.n / max) * 100}%` }} /></span>
              <span className="sr-bar__n">{fmt(r.n)}</span>
            </button>
          );
        })}
      </div>
      {rows.length > top.length && <div className="sr-side__foot">另有 {rows.length - top.length} 个会话</div>}
    </Module>
  );
}

// ——— 31 按年份 ———

/** Years across the sample; a sample inside one year is shown by month instead. */
function ByYear({ stats, semantic, dates, onPick }: { stats: Stats; semantic: boolean; dates: Range; onPick: (d: Range) => void }) {
  const view = useMemo(() => {
    const perY = new Map<number, number>();
    for (const s of stats.sample ?? []) perY.set(s.year, (perY.get(s.year) ?? 0) + 1);
    if (!perY.size) return null;
    const lo = Math.min(...perY.keys());
    const hi = Math.max(...perY.keys());
    if (lo === hi) {
      const perM = new Array<number>(12).fill(0);
      for (const s of stats.sample ?? []) perM[s.month - 1]++;
      const mm = (m: number) => String(m).padStart(2, '0');
      const last = (m: number) => new Date(Date.UTC(lo, m, 0)).getUTCDate();
      return {
        byMonth: true, year: lo,
        bars: perM.map((n, i) => ({
          k: `${lo}-${mm(i + 1)}`, n, label: mm(i + 1), what: `${lo} 年 ${i + 1} 月`,
          range: { from: `${lo}-${mm(i + 1)}-01`, to: `${lo}-${mm(i + 1)}-${mm(last(i + 1))}` },
        })),
      };
    }
    const bars = [];
    for (let y = Math.max(lo, hi - 15); y <= hi; y++) {
      bars.push({ k: String(y), n: perY.get(y) ?? 0, label: `'${String(y).slice(2)}`, what: `${y} 年`, range: { from: `${y}-01-01`, to: `${y}-12-31` } });
    }
    return { byMonth: false, year: hi, bars };
  }, [stats.sample]);
  if (!view) return null;
  const max = Math.max(1, ...view.bars.map(b => b.n));
  const peak = view.bars.reduce((a, b) => (b.n > a.n ? b : a)).k;
  const picked = (r: Range) => dates.from === r.from && dates.to === r.to;
  const anyOn = view.bars.some(b => picked(b.range));
  const unit = view.byMonth ? '个月' : '一年';
  return (
    <Module
      id="31" title={view.byMonth ? '按月份' : '按年份'} en={view.byMonth ? `BY MONTH · ${view.year}` : 'BY YEAR'}
      right={<span className="sr-side__r">{sampleNote(stats, semantic)}</span>} className="sr-m31"
    >
      <div className={cx('sr-yrs', anyOn && 'has-on')} style={{ ['--yn' as string]: view.bars.length }}>
        {view.bars.map(b => {
          const on = picked(b.range);
          return (
            <button key={b.k} type="button" className={cx('sr-yr', b.k === peak && b.n > 0 && 'is-peak', on && 'is-on')}
              onClick={() => onPick(on ? { from: '', to: '' } : b.range)}
              title={on ? '取消这个时间范围' : `${b.what} · ${fmt(b.n)} 条 · 点一下只看这${unit}`}
              aria-pressed={on}>
              <span className="sr-yr__bar"><i style={{ height: b.n ? `${Math.max(3, (b.n / max) * 100)}%` : 0 }} /></span>
              <span className="sr-yr__l">{b.label}</span>
            </button>
          );
        })}
      </div>
      <div className="sr-side__foot">
        点{view.byMonth ? '月份' : '年份'}只看那{unit}{anyOn ? '，再点一次取消' : ''}{stats.complete ? '' : semantic ? '；只算了上面这些结果' : '；更早的命中没算进来'}。
      </div>
    </Module>
  );
}

// ——— 32 谁说的 ———

function BySender({ stats, results }: { stats: Stats; results: Results }) {
  const semantic = results.mode === 'semantic';
  if (results.who === 'self') {
    return (
      <Module id="32" title="谁说的" en="BY SENDER" className="sr-m32">
        <div className="sr-note">现在只搜你自己说的话：{fmt(results.total)} 条。把 FROM 换回「所有人」就能看到双方的比例。</div>
      </Module>
    );
  }
  // Keyword: the exact split over every hit. Semantic: the results shown.
  const base = semantic && !stats.complete ? stats.counted : results.total;
  const self = semantic && !stats.complete ? (stats.sample ?? []).filter(s => s.self).length : stats.selfTotal;
  if (self == null) {
    return (
      <Module id="32" title="谁说的" en="BY SENDER" className="sr-m32">
        <div className="sr-note"><span className="ui-spinner" aria-hidden="true" /> 正在数你说的那部分…</div>
      </Module>
    );
  }
  const other = Math.max(0, base - self);
  const pct = (n: number) => (base ? (n / base) * 100 : 0);
  return (
    <Module id="32" title="谁说的" en="BY SENDER" right={<span className="sr-side__r">{sampleNote(stats, semantic && !stats.complete)}</span>} className="sr-m32">
      <div className="sr-who">
        <div className="sr-who__row">
          <span className="ui-label">YOU<b>你</b></span>
          <span className="sr-who__v">{fmt(self)}<small>{pct(self).toFixed(1)}%</small></span>
        </div>
        <div className="sr-meter" aria-hidden="true">
          <i className="is-you" style={{ width: `${pct(self)}%` }} />
          <i style={{ flex: 1 }} />
        </div>
        <div className="sr-who__row">
          <span className="ui-label">OTHERS<b>其他人</b></span>
          <span className="sr-who__v">{fmt(other)}<small>{pct(other).toFixed(1)}%</small></span>
        </div>
      </div>
    </Module>
  );
}

// ——— 33 最近搜索 ———

function RecentModule({ recent, onPick }: { recent: Recent[]; onPick: (r: Recent) => void }) {
  return (
    <Module id="33" title="最近搜索" en="HISTORY" right={<span className="sr-side__r">只在这次打开期间</span>} className="sr-m33">
      {recent.length ? (
        <div className="sr-hist">
          {recent.map(r => (
            <button key={`${r.q}|${r.mode}|${r.who}|${r.dates.from}|${r.dates.to}`} type="button" className="sr-hist__row" onClick={() => onPick(r)}
              title={`再搜一次「${maskText(r.q)}」`}>
              <span className="sr-hist__at">{stamp(r.at)}</span>
              <span className="sr-hist__q">
                {maskText(r.q)}
                {r.mode === 'semantic' && <i>按意思</i>}
                {r.who === 'self' && <i>你</i>}
                {(r.dates.from || r.dates.to) && <i>{r.dates.from.slice(0, 7) || '…'}→{r.dates.to.slice(0, 7) || '…'}</i>}
              </span>
              <span className="sr-hist__n">{fmt(r.total)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="sr-note">还没有搜过。这里只记这次打开期间的搜索，关掉窗口就忘，不写进硬盘。</div>
      )}
    </Module>
  );
}

// ——— 34 索引 ———

function IndexModule({ index, indexError, noData, semantic, onRebuild, onRetry }: {
  index: SearchIndexStatus | null; indexError: unknown; noData: boolean; semantic: SemanticView | null;
  onRebuild: () => void; onRetry: () => void;
}) {
  let led = <span className="ui-led is-off" />;
  let state = '—';
  if (noData) state = '没有数据';
  else if (indexError) { led = <span className="ui-led ui-led--error" />; state = '连不上'; }
  else if (index) {
    switch (index.state) {
      case 'ready': led = <span className="ui-led" />; state = '就绪'; break;
      case 'building': led = <span className="ui-led is-pulse" />; state = `${index.indexed_messages ? '更新中' : '建立中'} ${Math.round(index.percent)}%`; break;
      case 'error': led = <span className="ui-led ui-led--error" />; state = '更新失败'; break;
      default: state = '还没建立';
    }
  }
  const when = index?.last_built_at ? stamp(index.last_built_at) : null;
  return (
    <Module id="34" title="索引" en="INDEX · LOCAL" className="sr-m34">
      <div className="sr-kv">
        <div className="sr-kv__row"><span className="ui-label">STATE<b>状态</b></span><span className="sr-kv__v">{led}{state}</span></div>
        {index && index.state !== 'empty' && (
          <>
            <div className="sr-kv__row"><span className="ui-label">MSG<b>已收录</b></span><span className="sr-kv__v">{fmt(index.indexed_messages)}</span></div>
            <div className="sr-kv__row"><span className="ui-label">SOURCES<b>数据库</b></span><span className="sr-kv__v">{fmt(index.sources)}</span></div>
            {when && <div className="sr-kv__row"><span className="ui-label">UPDATED<b>更新于</b></span><span className="sr-kv__v">{when}</span></div>}
            <div className="sr-kv__row">
              <span className="ui-label">ENGINE<b>方式</b></span>
              <span className="sr-kv__v">{index.mode === 'like' ? '逐条比对 · 较慢' : '分词索引'}</span>
            </div>
          </>
        )}
        <div className="sr-kv__row">
          <span className="ui-label">SEMANTIC<b>按意思</b></span>
          <span className="sr-kv__v">{semantic == null ? '…' : semantic.usable ? '可用' : '未启用'}</span>
        </div>
      </div>
      {index?.state === 'building' && (
        <div className="sr-prog" aria-label={`已完成 ${Math.round(index.percent)}%`}>
          <span className="sr-prog__t"><i style={{ width: `${Math.max(2, Math.min(100, index.percent))}%` }} /></span>
          <span className="sr-prog__n">{fmt(index.done)} / {fmt(index.total)}</span>
        </div>
      )}
      {index?.state === 'error' && index.last_error && <p className="sr-kv__err">{maskText(index.last_error)}</p>}
      {semantic?.note && <p className="sr-kv__note">{semantic.note}</p>}
      {index?.mode === 'like' && <p className="sr-kv__note">这台电脑的 SQLite 不支持分词索引，搜索会慢一些。</p>}
      <div className="sr-kv__acts">
        {indexError
          ? <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={onRetry}>重新连接</Button>
          : !noData && (
            <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={onRebuild}
              disabled={!index || index.state === 'building'}>
              重建索引
            </Button>
          )}
      </div>
    </Module>
  );
}

/** Building / failed index, on top of the results it affects. */
function IndexStrip({ index, onRebuild }: { index: SearchIndexStatus | null; onRebuild: () => void }) {
  if (!index) return null;
  if (index.state === 'building') {
    const first = !index.indexed_messages;
    return (
      <div className="sr-strip sr-strip--run" role="status">
        <span className="ui-led is-pulse" aria-hidden="true" />
        <span className="sr-strip__t">
          {first ? '正在建立搜索索引' : '正在更新搜索索引'} · {Math.round(index.percent)}%
          {first ? ' · 建好之前搜到的结果可能不全，建好后会自动重搜' : ''}
        </span>
        <span className="sr-strip__track" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, index.percent))}%` }} /></span>
      </div>
    );
  }
  if (index.state === 'error') {
    return (
      <div className="sr-strip sr-strip--err" role="alert">
        <span className="ui-led ui-led--error" aria-hidden="true" />
        <span className="sr-strip__t">搜索索引更新失败：{maskText(index.last_error || '未知错误')}。已有的索引还能用，但最近的消息可能搜不到。</span>
        <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={onRebuild}>重建索引</Button>
      </div>
    );
  }
  return null;
}

// ——— states ———

function Idle() {
  return (
    <div className="sr-idle">
      <EmptyState
        className="sr-state"
        label="READY"
        icon={<IconSearch size={22} />}
        title="在全部聊天里找一句话"
        description="私聊、群聊都会搜到；点一条结果，直接打开那段聊天、停在那一条。索引只在本机建立，不联网。"
      />
      <dl className="sr-tips">
        <div><dt>多个词</dt><dd>用空格分开，每个词都要出现</dd></div>
        <div><dt>FROM 你</dt><dd>只找你自己说过的话</dd></div>
        <div><dt>RANGE</dt><dd>限定日期；右边「按年份」也能点</dd></div>
        <div><dt>KEY /</dt><dd>随时回到输入框</dd></div>
      </dl>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="sr-list" aria-busy="true" aria-label="正在搜索">
      {[0, 1, 2].map(i => (
        <div key={i} className="sr-g sr-g--skel">
          <div className="sr-g__hd">
            <Skeleton width={14} height={10} />
            <Skeleton width={90 + i * 16} height={13} />
            <Skeleton width={96} height={10} />
          </div>
          {[0, 1, 2].map(j => (
            <div key={j} className="sr-skel-row">
              <Skeleton width={70} height={10} />
              <Skeleton width={26} height={10} />
              <Skeleton width={`${38 + ((i * 3 + j) * 17) % 40}%`} height={12} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SearchError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = errorCode(error);
  const entry = lookupError(code);
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return (
    <div className="sr-err">
      <ErrorState
        title={entry?.title ?? '搜索没能完成'}
        code={code ?? undefined}
        reason={entry?.reason ?? '搜索接口返回了错误。'}
        fixes={entry ? [entry.fix] : ['点「重试」再搜一次', '一直失败的话，在右边「索引」里点「重建索引」']}
        onRetry={onRetry}
        details={raw ? <pre>{maskText(raw)}</pre> : undefined}
      />
    </div>
  );
}
