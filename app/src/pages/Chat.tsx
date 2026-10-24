/* 聊天 (#/chat/<id>) — one conversation as a full page: bubbles (you on the
 * right), day separators, image / video previews, jump to a date, and older
 * messages loading as you scroll up.
 *
 * The hash query picks where it opens:
 *   ?m=<cursor>&q=<keywords>   at one message (a search hit), keywords marked
 *   ?at=YYYY-MM-DD             at the first message of that day
 *   (nothing)                  at the newest message
 *   &from=search               back goes to 搜索 instead of the friend page
 *
 * Data: GET /api/chat/messages (cli/chat_view.py). Built from ui/ primitives
 * and tokens; layout in ./Chat.css. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorCode, getChatPage, mediaUrl } from '../data/api';
import type { ChatPageInfo, ChatPageMessage } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { Button, Chip, Dialog, EmptyState, ErrorState, Skeleton, cx } from '../ui';
import { IconClose, IconPlay, IconRefresh } from '../ui/icons';
import { PageHeader } from '../shell/PageHeader';
import { displayName, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import {
  Highlight, IconArrowDown, IconCalendarJump, IconMessage, IconQuote, TypeIcon,
  clockOf, dayFromTs, dayOf, formatDay, isStub, splitQuote, splitShare, splitTerms, typeLabel,
} from '../components/chatBits';
import './Chat.css';

const FIRST_PAGE = 80;
const PAGE = 60;
/** A gap longer than this starts a new group and shows the time again. */
const GROUP_GAP_S = 5 * 60;
/** Show 「回到最新」 once this far (px) above the bottom. */
const AWAY_PX = 640;

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

export function ChatPage({ chatId, query, navigate }: ChatPageProps) {
  const privacy = usePrivacy();
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const fromSearch = params.get('from') === 'search';
  const q = params.get('q') || '';
  const terms = useMemo(() => splitTerms(q), [q]);
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
  const narrow = useNarrow();
  const [jumpOpen, setJumpOpen] = useState(false);
  const [tones, setTones] = useState<Tones>({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);   // bumped by every full (re)load; late page responses are dropped
  const intentRef = useRef<ScrollIntent | null>(null);

  const load = useCallback(async (opts: { around?: string; at?: string } = {}) => {
    const req = ++reqRef.current;
    setPhase('loading');
    setError(null);
    setNote(null);
    setOlder('idle');
    setNewer('idle');
    try {
      const r = await getChatPage(chatId, { around: opts.around, at: opts.at, limit: FIRST_PAGE });
      if (req !== reqRef.current) return;
      if (r.chat) setInfo(r.chat);
      setMsgs(r.messages);
      setTones(t => withTones(t, r.messages));
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
      setTones(t => withTones(t, r.messages));
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
      setTones(t => withTones(t, r.messages));
      setHasAfter(!!r.has_more_after);
      setNewer('idle');
    } catch {
      if (req === reqRef.current) setNewer('error');
    }
  }, [chatId, phase, hasAfter, newer, msgs]);

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
  }, [msgs, phase]);

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

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX;
    if (next !== away) setAway(next);
  };

  const jumpLatest = () => {
    if (hasAfter) {
      setTarget(null);
      void load({});
      return;
    }
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const onJump = (e: FormEvent) => {
    e.preventDefault();
    if (!jumpDay) return;
    setJumpOpen(false);
    void load({ at: jumpDay });
  };

  // Groups have no friend page; they are reached from search (or a link) only.
  const isGroup = info ? info.is_group : chatId.endsWith('@chatroom');
  const back = fromSearch
    ? { label: '搜索', onClick: () => navigate(q ? `search?q=${encodeURIComponent(q)}` : 'search') }
    : isGroup
      ? { label: '首页', onClick: () => navigate('') }
      : { label: '朋友页', onClick: () => navigate(`friend/${chatId}`) };

  const name = displayName(chatId, info?.name ?? null);
  const minDay = info?.first_ts != null ? dayFromTs(info.first_ts) : undefined;
  const maxDay = info?.last_ts != null ? dayFromTs(info.last_ts) : undefined;
  const subtitle = info ? describeChat(info) : undefined;

  const canJump = !!info && info.count > 0;
  const jumpForm = (
    <form className="chat-jump" onSubmit={onJump} aria-label="跳到日期">
      {!narrow && <IconCalendarJump size={16} className="chat-jump__icon" />}
      <input
        type="date"
        className="chat-jump__input"
        value={jumpDay}
        min={minDay}
        max={maxDay}
        onChange={(e) => setJumpDay(e.target.value)}
        aria-label="日期"
      />
      <Button size="sm" type="submit" disabled={!jumpDay}>跳转</Button>
    </form>
  );

  // Narrow windows: the header only has room for an icon; the date field
  // opens as a bar under it.
  const header = (
    <PageHeader
      back={back}
      title={!info ? '聊天' : info.is_group || narrow ? name : `和 ${name} 的聊天`}
      subtitle={subtitle}
    >
      {canJump && !narrow && jumpForm}
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
        <Button size="sm" variant="ghost" onClick={() => navigate(`friend/${chatId}`)}>朋友页</Button>
      )}
    </PageHeader>
  );

  if (phase === 'error') {
    return (
      <div className="chat-page chat-page--state">
        {header}
        <ChatError error={error} onRetry={() => void load({ around: startCursor, at: startDay })} />
      </div>
    );
  }

  return (
    <div className="chat-page app-fill">
      {header}
      {canJump && narrow && jumpOpen && <div className="chat-jumpbar">{jumpForm}</div>}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          {note && phase === 'ready' && (
            <div className="chat-note" role="status">
              <span>{note}</span>
              <button type="button" className="ui-icon-btn chat-note__close" aria-label="知道了" title="知道了"
                onClick={() => setNote(null)}>
                <IconClose size={13} />
              </button>
            </div>
          )}
          {phase === 'loading' && <ChatSkeleton />}
          {phase === 'ready' && msgs.length === 0 && (
            <EmptyState
              layout="inline"
              icon={<IconMessage size={26} />}
              title="这里还没有消息"
              description="这个会话在已解密的数据里没有消息记录。新消息要等下一次「更新数据」后才会出现。"
            />
          )}
          {phase === 'ready' && msgs.length > 0 && (
            <>
              <div ref={topRef} className="chat-edge">
                {hasBefore ? (
                  older === 'error' ? (
                    <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} onClick={() => void loadOlder()}>
                      更早的消息没加载出来，重试
                    </Button>
                  ) : (
                    <span className="chat-edge__loading"><span className="ui-spinner" aria-hidden="true" />加载更早的消息…</span>
                  )
                ) : (
                  <span className="chat-edge__start">聊天从这里开始</span>
                )}
              </div>
              <MessageList
                msgs={msgs}
                isGroup={!!info?.is_group}
                tones={tones}
                target={target}
                targetLabel={terms.length && !targetByDate ? '搜索命中' : '跳转位置'}
                terms={terms}
                onPreview={setPreview}
                privacy={privacy}
              />
              <div ref={bottomRef} className="chat-edge chat-edge--bottom">
                {hasAfter && (newer === 'error' ? (
                  <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} onClick={() => void loadNewer()}>
                    后面的消息没加载出来，重试
                  </Button>
                ) : (
                  <span className="chat-edge__loading"><span className="ui-spinner" aria-hidden="true" />加载后面的消息…</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {phase === 'ready' && (away || hasAfter) && (
        <Button
          className="chat-latest"
          size="sm"
          pill
          icon={<IconArrowDown size={14} />}
          onClick={jumpLatest}
        >
          回到最新
        </Button>
      )}
      <MediaPreview msg={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

const NARROW_QUERY = '(max-width: 640px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => {
    try {
      return window.matchMedia(NARROW_QUERY).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(NARROW_QUERY);
    } catch {
      return;
    }
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
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

// ——— list ———

interface ListProps {
  msgs: ChatPageMessage[];
  isGroup: boolean;
  tones: Tones;
  target: string | null;
  targetLabel: string;
  terms: string[];
  onPreview: (m: ChatPageMessage) => void;
  /** Only here so a privacy toggle re-renders the memoized list. */
  privacy: boolean;
}

const isSystem = (m: ChatPageMessage) => m.type === 'system' || m.type === 'revoke';

const MessageList = memo(function MessageList({ msgs, isGroup, tones, target, targetLabel, terms, onPreview }: ListProps) {
  const rows = [];
  let prev: ChatPageMessage | null = null;
  for (const m of msgs) {
    const day = dayOf(m.time);
    const newDay = !prev || dayOf(prev.time) !== day;
    if (newDay) {
      rows.push(
        <div key={`d-${day}-${m.id}`} className="chat-day" role="separator">
          <span>{formatDay(day)}</span>
        </div>,
      );
    }
    if (isSystem(m)) {
      rows.push(
        <div key={m.id} data-mid={m.id} className={cx('chat-system', m.id === target && 'is-target')}>
          <span>{isStub(m.text, m.type) ? typeLabel(m.type) : <Highlight text={maskText(m.text)} terms={terms} />}</span>
        </div>,
      );
    } else {
      // Time shows after a pause (like WeChat), not on every change of speaker.
      const showTime = newDay || !prev || m.ts - prev.ts > GROUP_GAP_S;
      const startsGroup = showTime || !prev || isSystem(prev) || prev.from_id !== m.from_id;
      rows.push(
        <MessageRow
          key={m.id}
          m={m}
          isGroup={isGroup}
          tone={tones[m.from_id] ?? 0}
          startsGroup={startsGroup}
          showTime={showTime}
          flag={m.id === target ? targetLabel : null}
          terms={terms}
          onPreview={onPreview}
        />,
      );
    }
    prev = m;
  }
  return <div className="chat-list">{rows}</div>;
});

/** Group-chat sender tones (token pairs only), handed out in order of first
 * appearance so the first five people never share one; never reassigned
 * while the page is open, even as older pages load. */
type Tones = Record<string, number>;
const TONES = 5;

function withTones(prev: Tones, msgs: ChatPageMessage[]): Tones {
  let next: Tones | null = null;
  for (const m of msgs) {
    if (m.from_id === 'self' || isSystem(m)) continue;
    const cur = next ?? prev;
    if (m.from_id in cur) continue;
    next = next ?? { ...prev };
    const n = Object.keys(next).length;
    next[m.from_id] = n % TONES;
  }
  return next ?? prev;
}

function MessageRow({ m, isGroup, tone, startsGroup, showTime, flag, terms, onPreview }: {
  m: ChatPageMessage; isGroup: boolean; tone: number; startsGroup: boolean; showTime: boolean; flag: string | null;
  terms: string[]; onPreview: (m: ChatPageMessage) => void;
}) {
  const self = m.from_id === 'self';
  const name = displayName(m.from_id, m.from);
  const showAvatar = isGroup && !self;
  const media = m.media && m.media.url ? m.media : null;
  return (
    <div
      data-mid={m.id}
      className={cx('chat-msg', self ? 'is-self' : 'is-other', startsGroup && 'is-start', flag && 'is-target',
        showAvatar && `chat-tone-${tone}`)}
    >
      {showAvatar && (
        <div className="chat-msg__avatar" aria-hidden="true">
          {startsGroup && <span>{name.replace(/^朋友\s*/, '').slice(0, 1) || '?'}</span>}
        </div>
      )}
      <div className="chat-msg__col">
        {startsGroup && (showAvatar || showTime) && (
          <div className="chat-msg__meta">
            {showAvatar && <span className="chat-msg__name">{name}</span>}
            {showTime && <time dateTime={m.time}>{clockOf(m.time)}</time>}
          </div>
        )}
        {flag && <Chip size="sm" tone="accent" className="chat-msg__flag">{flag}</Chip>}
        <div className={cx('chat-bubble', media && 'chat-bubble--media')}>
          <MessageBody m={m} terms={terms} onPreview={onPreview} />
        </div>
      </div>
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
          <div className="chat-quote">
            <IconQuote size={13} />
            <span>
              {quote.who && <span className="chat-quote__who">{maskText(quote.who)}：</span>}
              {maskText(quote.quoted)}
            </span>
          </div>
          {quote.reply && <div className="chat-text"><Highlight text={maskText(quote.reply)} terms={terms} /></div>}
        </>
      );
    }
    const share = splitShare(text);
    if (share) {
      return (
        <div className="chat-share">
          <span className="chat-type"><TypeIcon type="share" size={13} />{share.label}</span>
          <span className="chat-share__body"><Highlight text={maskText(share.body)} terms={terms} /></span>
        </div>
      );
    }
  }
  if (m.type !== 'text' && isStub(text, m.type)) return <TypeTag type={m.type} />;
  return <div className="chat-text"><Highlight text={maskText(text)} terms={terms} /></div>;
}

function TypeTag({ type, note }: { type: string; note?: string }) {
  return (
    <span className="chat-type">
      <TypeIcon type={type} size={14} />
      {typeLabel(type)}
      {note && <span className="chat-type__note">· {note}</span>}
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
      className={cx('chat-media', `chat-media--${media.kind}`, privacy && 'is-private')}
      onClick={() => onPreview(m)}
      aria-label={label}
      title={privacy ? `${label}（隐私模式下缩略图已模糊）` : label}
    >
      {media.kind === 'image' ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <>
          <video src={src} muted playsInline preload="metadata" onError={() => setFailed(true)} />
          <span className="chat-media__play"><IconPlay size={18} /></span>
        </>
      )}
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
      title={media?.kind === 'video' ? '视频' : '图片'}
      description={msg ? `${displayName(msg.from_id, msg.from)} · ${formatDay(dayOf(msg.time))} ${clockOf(msg.time)}` : undefined}
      className="chat-preview-dialog"
    >
      {media && msg && (
        <div className="chat-preview">
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
  const rows: { self: boolean; w: number; h: number }[] = [
    { self: false, w: 46, h: 38 }, { self: false, w: 30, h: 38 }, { self: true, w: 38, h: 38 },
    { self: false, w: 58, h: 62 }, { self: true, w: 24, h: 38 }, { self: true, w: 44, h: 62 },
    { self: false, w: 36, h: 38 },
  ];
  return (
    <div className="chat-skeleton" aria-busy="true" aria-label="正在加载聊天记录">
      {rows.map((r, i) => (
        <div key={i} className={cx('chat-skeleton__row', r.self && 'is-self')}>
          <Skeleton width={`${r.w}%`} height={r.h} radius={14} />
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
