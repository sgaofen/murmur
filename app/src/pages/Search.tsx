/* 搜索 (#/search?q=…) — keyword search over every chat (GET /api/search,
 * cli/search_index.py), results grouped by conversation with the matched
 * words marked; a hit opens the chat page at that message.
 *
 * Semantic search (cli/semantic_index.py) is an optional second mode: it is
 * offered only when /api/search/semantic/status says it is ready. Missing
 * endpoint / not installed / turned off / still preparing all fall back to
 * keyword-only with a one-line note — never an error.
 *
 * Built from ui/ primitives and tokens; layout in ./Search.css. */
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
import {
  Button, Callout, Card, Chip, EmptyState, ErrorState, SegmentedControl, Skeleton, SkeletonText, cx,
} from '../ui';
import { IconInfoCircle, IconRefresh, IconSearch, IconSparkle } from '../ui/icons';
import { PageHeader } from '../shell/PageHeader';
import { displayName, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { searchQuery } from '../utils/searchLinks';
import { TypeIcon, clockOf, dayOf, isStub, normType, typeLabel } from '../components/chatBits';
import './Chat.css';
import './Search.css';

const PAGE_SIZE = 50;
const SEMANTIC_PAGE = 20;

type Mode = 'keyword' | 'semantic';
type Hit = SearchHit | SemanticSearchHit;

interface Results {
  q: string;
  mode: Mode;
  hits: Hit[];
  total: number;
  match: SearchResponse['match'] | 'semantic';
  note: string;   // short-query note from the index, when relevant
}

export interface SearchPageProps {
  /** The hash's query part: q=<keywords>[&mode=semantic]. */
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
  results: Results;
  index?: SearchIndexStatus;
}

async function fetchResults(q: string, m: Mode, offset: number, range: { from?: string; to?: string }): Promise<Fetched> {
  if (m === 'semantic') {
    const r: SemanticSearchResponse = await searchSemantic({ q, limit: SEMANTIC_PAGE, offset, ...range });
    return { results: { q, mode: m, hits: r.results, total: r.total, match: 'semantic', note: '' } };
  }
  const r: SearchResponse = await searchMessages({ q, limit: PAGE_SIZE, offset, ...range });
  const note = r.match !== 'fts' ? (r.index?.short_query_note || '') : '';
  return { results: { q, mode: m, hits: r.results, total: r.total, match: r.match, note }, index: r.index };
}

// ——— page ———

type Range = { from: string; to: string };

export function SearchPage({ query, navigate }: SearchPageProps) {
  void usePrivacy();
  const initial = useMemo(() => new URLSearchParams(query), [query]);
  const [input, setInput] = useState(initial.get('q') || '');
  const [mode, setMode] = useState<Mode>(initial.get('mode') === 'semantic' ? 'semantic' : 'keyword');
  const [from, setFrom] = useState(initial.get('from') || '');
  const [to, setTo] = useState(initial.get('to') || '');

  const [index, setIndex] = useState<SearchIndexStatus | null>(null);
  const [indexError, setIndexError] = useState<unknown>(null);
  const [semantic, setSemantic] = useState<SemanticView | null>(null);

  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState<'idle' | 'search' | 'more'>('idle');
  const [searchError, setSearchError] = useState<unknown>(null);
  const reqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The search on screen, and whether it ran against a half-built index —
  // when the build finishes it is run again so the results are complete.
  const lastRef = useRef<{ q: string; mode: Mode; dates: Range; partial: boolean } | null>(null);
  const indexStateRef = useRef<SearchIndexStatus['state'] | null>(null);
  const rerunRef = useRef<() => void>(() => {});

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

  const run = useCallback(async (q: string, m: Mode, offset: number, prev: Results | null, dates?: Range) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const req = ++reqRef.current;
    setBusy(offset ? 'more' : 'search');
    setSearchError(null);
    const d = dates ?? { from, to };
    const range = { from: d.from || undefined, to: d.to || undefined };
    try {
      let out: Fetched;
      let append = offset > 0 && prev !== null;
      try {
        out = await fetchResults(trimmed, m, offset, range);
      } catch (e) {
        if (!(e instanceof SemanticUnavailableError)) throw e;
        // Became unavailable between the status check and now — drop to keyword.
        if (req !== reqRef.current) return;
        setSemantic(semanticView(e.status, false));
        setMode('keyword');
        out = await fetchResults(trimmed, 'keyword', 0, range);
        append = false;
      }
      if (req !== reqRef.current) return;
      if (out.index) setIndex(out.index);
      const next = out.results;
      setResults(append && prev ? { ...next, hits: [...prev.hits, ...next.hits] } : next);
      if (!append) {
        const building = (out.index?.state ?? indexStateRef.current) === 'building';
        lastRef.current = { q: trimmed, mode: next.mode, dates: d, partial: building };
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
    const last = lastRef.current;
    if (!last?.partial) return;
    lastRef.current = { ...last, partial: false };
    void run(last.q, last.mode, 0, null, last.dates);
  };

  // Keep the query in the URL (no history entry) so 「返回」 from a chat restores it.
  const remember = (q: string, m: Mode, d: Range = { from, to }) => {
    const s = searchQuery(q, m, d);
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
    remember(q, effectiveMode);
    void run(q, effectiveMode, 0, null);
  };

  const onMode = (v: string) => {
    const m = v as Mode;
    setMode(m);
    const q = input.trim();
    if (q) {
      remember(q, m);
      void run(q, m, 0, null);
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
      remember(q, effectiveMode, d);
      void run(q, effectiveMode, 0, null, d);
    }, 400);
  };

  // `back` carries the whole search (words, mode, dates) so the chat page's
  // 「返回」 lands on the same results, not just the same words.
  const openHit = (h: Hit, q: string) => {
    const p = new URLSearchParams({ m: chatCursorFor(h), from: 'search' });
    if (q) p.set('q', q);
    const back = searchQuery(q, results?.mode ?? effectiveMode, lastRef.current?.dates ?? { from, to });
    if (back) p.set('back', back);
    navigate(`chat/${encodeURIComponent(h.chat)}?${p}`);
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

  const noData = errorCode(indexError) === 'NO_DECRYPTED_DATA';
  const unreachable = !!indexError && !noData && !index;

  return (
    <div className="search">
      <PageHeader title="搜索" subtitle="全部聊天记录 · 索引只在本机" />

      <form className="search-bar" role="search" onSubmit={onSubmit}>
        <IconSearch size={18} className="search-bar__icon" />
        <input
          ref={inputRef}
          className="search-bar__input"
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={effectiveMode === 'semantic' ? '描述你想找的内容，比如「一起去看海的那次」' : '搜一句话、一个词，多个词用空格分开'}
          aria-label="搜索聊天记录"
          autoFocus
          enterKeyHint="search"
        />
        <Button variant="primary" type="submit" loading={busy === 'search'}>搜索</Button>
      </form>

      <div className="search-tools">
        {semanticUsable && (
          <SegmentedControl
            label="搜索方式"
            size="sm"
            value={effectiveMode}
            onChange={onMode}
            options={[
              { value: 'keyword', label: '关键词' },
              { value: 'semantic', label: '按意思', icon: <IconSparkle size={13} /> },
            ]}
          />
        )}
        <div className="search-range" role="group" aria-label="时间范围">
          <span className="search-range__label">时间</span>
          <input type="date" className="chat-jump__input" value={from} max={to || undefined}
            onChange={(e) => onRange({ from: e.target.value, to })} aria-label="开始日期" />
          <span className="search-range__dash" aria-hidden="true">–</span>
          <input type="date" className="chat-jump__input" value={to} min={from || undefined}
            onChange={(e) => onRange({ from, to: e.target.value })} aria-label="结束日期" />
          {(from || to) && (
            <Button size="sm" variant="ghost" onClick={() => onRange({ from: '', to: '' })}>清除</Button>
          )}
        </div>
      </div>

      {semantic && semantic.note && (
        <p className="search-hint">
          <IconInfoCircle size={14} />
          <span>{semantic.note}</span>
        </p>
      )}

      <IndexBanner index={index} onRebuild={rebuild} />

      <div className="search-body">
        {noData ? (
          <EmptyState
            icon={<IconSearch size={26} />}
            title="还没有可搜索的聊天记录"
            description="完成初始化（抓密钥并解密）之后，Murmur 会在本机建立搜索索引，之后就能在这里搜全部聊天。"
            actions={<Button variant="secondary" onClick={() => navigate('')}>回到首页</Button>}
          />
        ) : unreachable && !results ? (
          <SearchError error={indexError} onRetry={() => setStatusNonce(n => n + 1)} />
        ) : searchError ? (
          <SearchError error={searchError} onRetry={() => onSubmit()} />
        ) : busy === 'search' && !results ? (
          <ResultsSkeleton />
        ) : results ? (
          <ResultList
            results={results}
            loadingMore={busy === 'more'}
            stale={busy === 'search'}
            onOpen={openHit}
            onMore={() => void run(results.q, results.mode, results.hits.length, results)}
            semanticUsable={semanticUsable && results.mode === 'keyword'}
            onTrySemantic={() => onMode('semantic')}
          />
        ) : (
          <EmptyState
            icon={<IconSearch size={26} />}
            title="在全部聊天里找一句话"
            description="私聊、群聊都会搜到；点结果直接打开那段聊天、停在那一条。索引只在本机建立，不联网。"
          />
        )}
      </div>

      <IndexFooter index={index} onRebuild={rebuild} />
    </div>
  );
}

// ——— index state ———

function IndexBanner({ index, onRebuild }: { index: SearchIndexStatus | null; onRebuild: () => void }) {
  if (!index) return null;
  if (index.state === 'building') {
    const first = !index.indexed_messages;
    return (
      <Callout tone="info" compact className="search-banner" title={first ? '正在建立搜索索引' : '正在更新搜索索引'}>
        <div className="search-progress" aria-label={`已完成 ${Math.round(index.percent)}%`}>
          <span style={{ width: `${Math.max(2, Math.min(100, index.percent))}%` }} />
        </div>
        <span className="search-progress__text">
          {Math.round(index.percent)}% · {index.done.toLocaleString()} / {index.total.toLocaleString()}
          {first ? ' · 建好之前搜到的结果可能不全' : ''}
        </span>
      </Callout>
    );
  }
  if (index.state === 'error') {
    return (
      <Callout
        tone="warning"
        compact
        className="search-banner"
        title="搜索索引更新失败"
        actions={<Button size="sm" icon={<IconRefresh size={14} />} onClick={onRebuild}>重建索引</Button>}
      >
        {maskText(index.last_error || '未知错误')}。已有的索引还能用，但最近的消息可能搜不到。
      </Callout>
    );
  }
  return null;
}

function IndexFooter({ index, onRebuild }: { index: SearchIndexStatus | null; onRebuild: () => void }) {
  if (!index || index.state === 'empty') return null;
  const when = index.last_built_at
    ? new Date(index.last_built_at * 1000).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <div className="search-footer">
      <span>
        已收录 {index.indexed_messages.toLocaleString()} 条消息
        {when && ` · 更新于 ${when}`}
        {index.mode === 'like' && ' · 这台电脑的 SQLite 不支持分词索引，搜索会慢一些'}
      </span>
      {index.state !== 'building' && (
        <Button size="sm" variant="ghost" onClick={onRebuild}>重建索引</Button>
      )}
    </div>
  );
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

function ResultList({ results, loadingMore, stale, onOpen, onMore, semanticUsable, onTrySemantic }: {
  results: Results;
  loadingMore: boolean;
  stale: boolean;
  onOpen: (h: Hit, q: string) => void;
  onMore: () => void;
  semanticUsable: boolean;
  onTrySemantic: () => void;
}) {
  const groups = useMemo(() => groupHits(results.hits), [results.hits]);
  if (!results.hits.length) {
    return (
      <EmptyState
        icon={<IconSearch size={26} />}
        title={`没有找到「${maskText(results.q)}」`}
        description={results.mode === 'semantic'
          ? '换一种说法试试，或者切回「关键词」找原话。'
          : '换个说法、少打几个字，或者清掉时间范围再试。'}
        actions={semanticUsable
          ? <Button variant="secondary" icon={<IconSparkle size={14} />} onClick={onTrySemantic}>改用「按意思」搜索</Button>
          : undefined}
      />
    );
  }
  const shown = results.hits.length;
  const rest = Math.max(0, results.total - shown);
  return (
    <div className={cx('search-results', stale && 'is-stale')} aria-busy={stale || undefined}>
      <div className="search-summary">
        <span>
          {results.mode === 'semantic' ? '按意思找到' : '找到'}
          <b className="et-num"> {results.total.toLocaleString()} </b>
          条{results.mode === 'semantic' ? '相近的聊天' : '消息'}，来自 <b className="et-num">{groups.length}</b> 个会话
          {rest > 0 && <>（先显示 {shown} 条）</>}
        </span>
        {results.note && <span className="search-summary__note">{results.note}</span>}
      </div>
      {groups.map(g => (
        <ResultGroup key={g.chat} group={g} q={results.q} semantic={results.mode === 'semantic'} onOpen={onOpen} />
      ))}
      {rest > 0 && (
        <div className="search-more">
          <Button variant="secondary" loading={loadingMore} onClick={onMore}>
            再显示 {Math.min(rest, results.mode === 'semantic' ? SEMANTIC_PAGE : PAGE_SIZE)} 条（还有 {rest.toLocaleString()} 条）
          </Button>
        </div>
      )}
    </div>
  );
}

function chatTone(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 5;
}

function ResultGroup({ group, q, semantic, onOpen }: {
  group: Group; q: string; semantic: boolean; onOpen: (h: Hit, q: string) => void;
}) {
  const name = displayName(group.chat, group.name);
  return (
    <Card padding="none" className={cx('search-group', `chat-tone-${chatTone(group.chat)}`)}>
      <div className="search-group__head">
        <span className="search-group__badge" aria-hidden="true">{name.replace(/^朋友\s*/, '').slice(0, 1) || '?'}</span>
        <span className="search-group__name">{name}</span>
        {group.isGroup && <Chip size="sm">群聊</Chip>}
        <span className="search-group__count">{group.hits.length} 条</span>
      </div>
      <ul className="search-hits">
        {group.hits.map(h => (
          <li key={`${h.locator.db}:${h.locator.local_id}:${h.ts}`}>
            <button type="button" className="search-hit" onClick={() => onOpen(h, q)}>
              <span className="search-hit__meta">
                <span className="search-hit__who">{displayName(h.sender, h.sender_name)}</span>
                <time dateTime={h.time}>{dayOf(h.time)} {clockOf(h.time)}</time>
                {h.type !== 'text' && (
                  <span className="search-hit__type">
                    <TypeIcon type={normType(h.type, h.type_code)} size={12} />{typeLabel(normType(h.type, h.type_code))}
                  </span>
                )}
              </span>
              {semantic && 'chunk' in h
                ? <SemanticSnippet hit={h} />
                : <Snippet hit={h} />}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** "[image]"-style stubs read as 「[图片]」. */
function stubText(text: string, type: string, code?: number): string | null {
  return isStub(text, type) ? `[${typeLabel(normType(type, code))}]` : null;
}

function Snippet({ hit }: { hit: Hit }) {
  const stub = stubText(hit.snippet, hit.type, hit.type_code);
  if (stub) return <span className="search-hit__text">{stub}</span>;
  const segs = hit.segments?.length ? hit.segments : [{ text: hit.snippet, hit: false }];
  return (
    <span className="search-hit__text">
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
    `${displayName(m.sender, m.sender_name)}：${stubText(m.text, m.type) ?? maskText(m.text)}`;
  return (
    <span className="search-hit__context">
      {before && <span className="search-hit__ctx">{line(before)}</span>}
      <Snippet hit={hit} />
      {after && <span className="search-hit__ctx">{line(after)}</span>}
    </span>
  );
}

// ——— states ———

function ResultsSkeleton() {
  return (
    <div className="search-results" aria-busy="true" aria-label="正在搜索">
      {[0, 1].map(i => (
        <Card key={i} padding="md" className="search-skeleton">
          <div className="ui-row"><Skeleton width={28} circle /><Skeleton width={140} height={14} /></div>
          <div className="ui-mt-3"><SkeletonText lines={2} /></div>
          <div className="ui-mt-3"><SkeletonText lines={2} lastLineWidth="48%" /></div>
        </Card>
      ))}
    </div>
  );
}

function SearchError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = errorCode(error);
  const entry = lookupError(code);
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return (
    <ErrorState
      title={entry?.title ?? '搜索没能完成'}
      code={code ?? undefined}
      reason={entry?.reason ?? '搜索接口返回了错误。'}
      fixes={entry ? [entry.fix] : ['点「重试」再搜一次', '一直失败的话，在下方点「重建索引」']}
      onRetry={onRetry}
      details={raw ? <pre>{maskText(raw)}</pre> : undefined}
    />
  );
}
