/* 年代记 (#/) — the instrument's front panel. Six numbered modules on a 1px
 * grid, all read from the local backend:
 *
 *   01 联系人   /api/friends (people / groups / message sums) + /api/home-summary
 *   02 月度热度  /api/home-summary heat — the last 12 months, % of the peak
 *   03 常聊     top 8 private chats by message count
 *   04 名录     every chat, filterable (私聊 / 群聊) and searchable
 *   05 标签     the backend's automatic labels (count + recency), as a distribution
 *   06 数据源   实时同步, 更新数据, 密钥, 后台任务
 *
 * Nothing on this page is estimated or invented: where the backend has no
 * figure (weekly sparklines, reply ratios, tiers) the module shows a figure
 * it does have instead. Styles: ./Home.css. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { API_BASE, APP_VERSION, ApiError, errorCode, getAllFriends, getDiagBundle, getHomeSummary, getLogTail, getTauriLogTail, refreshData } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import type { LogTailResponse } from '../data/api';
import type { Friend, HomeSummary } from '../data/types';
import { ExtractKeyDialog } from './ExtractKeyDialog';
import { TaskCenterBell, TaskCenterDrawer, useTaskCenter } from '../components/extras/TaskCenter';
import { displayName, maskText } from '../utils/privacy';
import { redactDiagnostics } from '../utils/diagRedact';
import { usePrivacy } from '../utils/usePrivacy';
import { LiveSyncToggle } from '../components/LiveSyncToggle';
import { clockTime, pollLiveSyncNow, useLiveSync } from '../utils/liveSync';
import { Button, EmptyState, ErrorState, Module, SegmentedControl, Skeleton, cx } from '../ui';
import { IconClose, IconInbox, IconKey, IconRefresh, IconSearch } from '../ui/icons';
import { PageHeader } from '../shell/PageHeader';
import './Home.css';
import { homeHasNoData } from '../utils/pageStates';

interface Props {
  onOpenFriend: (id: string) => void;
  onOpenOnboarding?: () => void;
  onOpenQQ?: () => void;
}

type Tab = 'private' | 'group';

/** Fixed thousands separators ("418,906") whatever the OS locale. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function pct(part: number, whole: number, digits = 1): string {
  if (!whole) return '0.0';
  return ((part / whole) * 100).toFixed(digits);
}

/** "3月" → "03" (the backend sends short month labels without the year). */
function monthCode(label: string): string {
  const m = /^(\d{1,2})/.exec(label);
  return m ? m[1].padStart(2, '0') : label;
}

function sumCounts(list: Friend[]): number {
  let s = 0;
  for (const f of list) s += f.count;
  return s;
}

/** The backend's automatic labels (cli/etcli.py `_quick_label`), most active
 * first. Unknown labels are appended in the order they appear. */
const TAG_ORDER = ['话痨型', '正在升温', '老朋友', '最近常聊', '熟人', '私聊', '近期断联', '久未联系', '—'];
const TAG_RULE: Record<string, string> = {
  话痨型: '消息超过 2,000 条，两周内聊过',
  正在升温: '消息超过 500 条，三天内聊过',
  老朋友: '消息超过 1,500 条，一个月内聊过',
  最近常聊: '一周内聊过',
  熟人: '消息超过 1,000 条',
  私聊: '其余的私聊',
  近期断联: '超过 60 天没聊',
  久未联系: '超过一年没聊',
  '—': '没有时间记录',
};

const INDEX_PAGE = 300;
const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('mac');
/** "127.0.0.1:9100" — where the boot probe is knocking. */
const BACKEND_HOST = API_BASE.replace(/^https?:\/\//, '').replace(/\/+$/, '');

// ———————————————————————— 01 联系人 ————————————————————————

function ContactsModule({ summary, people, groups, totalMsgs, stale }: {
  summary: HomeSummary;
  people: number | null;
  groups: number | null;
  totalMsgs: number | null;
  stale: number | null;
}) {
  const dash = <span className="home-dash">—</span>;
  return (
    <Module id="01" title="联系人" right="CONTACTS" className="home-m01">
      <div className="home-m01__main">
        <div className="ui-label">PEOPLE<b>聊过天的人</b></div>
        <div className="ui-big home-m01__big">{people == null ? <Skeleton width={150} height={70} /> : fmt(people)}</div>
        <div className="home-m01__sub">
          深聊 ≥500 条 <span className="ui-num">{fmt(summary.closeFriends)}</span>
          <span className="home-sep">·</span>
          超过一年未联系 <span className="ui-num">{stale == null ? '—' : fmt(stale)}</span>
        </div>
      </div>
      <div className="home-ro">
        <div>
          <div className="ui-label">GROUPS<b>群聊</b></div>
          <div className="home-ro__v">{groups == null ? dash : fmt(groups)}</div>
        </div>
        <div>
          <div className="ui-label">MESSAGES<b>消息</b></div>
          <div className="home-ro__v">{totalMsgs == null ? dash : fmt(totalMsgs)}</div>
        </div>
        <div>
          <div className="ui-label">SPAN<b>跨度</b></div>
          <div className="home-ro__v">{fmt(summary.daysSinceFirst)}<small> D</small></div>
        </div>
        <div>
          <div className="ui-label">SESSIONS<b>会话</b></div>
          <div className="home-ro__v">{fmt(summary.totalContacts)}</div>
        </div>
      </div>
    </Module>
  );
}

// ———————————————————————— 02 月度热度 ————————————————————————

const SEQ_SEGMENTS = 20;

function HeatModule({ summary }: { summary: HomeSummary }) {
  const { heat } = summary;
  const values = heat.values.length ? heat.values : new Array(12).fill(0);
  const labels = heat.months.length === values.length ? heat.months : values.map((_, i) => `${i + 1}月`);
  const hasData = heat.peakCount > 0;
  const peakIdx = hasData ? values.indexOf(Math.max(...values)) : -1;
  const lowIdx = hasData ? values.indexOf(Math.min(...values)) : -1;
  return (
    <Module
      id="02" title="月度热度" en="LAST 12 MONTHS · UNIT % OF PEAK" crop="bottom" className="home-m02"
      right={(
        <>
          <span className="home-legend" aria-hidden="true">
            <i style={{ background: 'var(--heat-1)' }} /><i style={{ background: 'var(--heat-3)' }} />
            <i style={{ background: 'var(--heat-4)' }} /><i style={{ background: 'var(--signal)' }} />
          </span>
          <span className="home-hide-md">0 — 100%</span>
          {hasData && (
            <>
              <span className="home-hd-strong">PEAK {monthCode(heat.peakLabel)} · {fmt(heat.peakCount)}</span>
              <span className="home-hide-md">LOW {monthCode(heat.troughLabel)} · {fmt(heat.troughCount)}</span>
            </>
          )}
        </>
      )}
    >
      <div className="home-seq" role="img"
        aria-label={hasData
          ? `最近 12 个月的消息量，${heat.peakLabel}最多（${fmt(heat.peakCount)} 条），${heat.troughLabel}最少（${fmt(heat.troughCount)} 条）`
          : '最近 12 个月还没有消息'}>
        {values.map((v, i) => {
          const lit = v > 0 ? Math.max(1, Math.round(v * SEQ_SEGMENTS)) : 0;
          const isPeak = i === peakIdx;
          const isLow = i === lowIdx && lowIdx !== peakIdx;
          const yearTurn = i > 0 && monthCode(labels[i]) === '01';
          return (
            <div key={i} className={cx('home-seq__col', isPeak && 'is-peak', isLow && 'is-low', yearTurn && 'is-turn')}>
              <span className="home-seq__read">{Math.round(v * 100)}</span>
              <span className="home-seq__meter" aria-hidden="true">
                {Array.from({ length: SEQ_SEGMENTS }, (_, s) => (
                  <i key={s} className={cx(s < lit && 'on', isPeak && s < lit && s >= lit - 3 && 'tip')} />
                ))}
              </span>
              <span className="home-seq__m">{monthCode(labels[i])}</span>
              <span className="home-seq__tag">{isPeak ? 'PEAK' : isLow ? 'LOW' : ''}</span>
            </div>
          );
        })}
      </div>
    </Module>
  );
}

// ———————————————————————— 03 常聊 ————————————————————————

const VU_SEGMENTS = 30;

function TopModule({ top, privateTotal, onOpen, loading }: {
  top: Friend[]; privateTotal: number; onOpen: (id: string) => void; loading: boolean;
}) {
  const max = top[0]?.count || 1;
  const topSum = sumCounts(top);
  const share = pct(topSum, privateTotal);
  return (
    <Module id="03" title="常聊" right={`TOP ${String(Math.max(top.length, loading ? 8 : 0)).padStart(2, '0')} · BY MSG`} className="home-m03">
      <div className="home-vu">
        {loading && Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="home-vu__row is-skel" aria-hidden="true">
            <span className="home-vu__top"><Skeleton width="46%" height={11} /></span>
            <Skeleton width="80%" height={6} />
          </div>
        ))}
        {!loading && top.length === 0 && <div className="home-note">还没有私聊记录。</div>}
        {!loading && top.map((f, i) => {
          const n = Math.max(1, Math.round((f.count / max) * VU_SEGMENTS));
          return (
            <button key={f.id} type="button" className="home-vu__row" onClick={() => onOpen(f.id)}
              title={`打开 ${displayName(f.id, f.name)} 的档案`}>
              <span className="home-vu__top">
                <span className="home-vu__rk">{String(i + 1).padStart(2, '0')}</span>
                <span className="home-vu__name">{displayName(f.id, f.name)}</span>
                {f.tag && f.tag !== '—' && <span className="home-vu__tag">{f.tag}</span>}
                <span className="home-vu__val">{fmt(f.count)}</span>
              </span>
              <span className="home-vu__seg" aria-hidden="true">
                {Array.from({ length: VU_SEGMENTS }, (_, s) => (
                  <i key={s} className={cx(s < n && (i === 0 && s >= n - 4 ? 'pk' : 'on'))} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {!loading && top.length > 0 && (
        <div className="home-m03__foot">
          <div className="home-m03__share">
            <span className="ui-label">SHARE<b>前 {top.length} 位占私聊消息</b></span>
            <span className="ui-num">{share}%</span>
          </div>
          <div className="home-bar" aria-hidden="true">
            <i style={{ width: `${share}%` }} /><i />
          </div>
        </div>
      )}
    </Module>
  );
}

// ———————————————————————— 04 名录 ————————————————————————

function IndexModule({
  tab, setTab, search, setSearch, rows, tabTotal, tabMax, counts, loading, error, onRetry, onOpen,
}: {
  tab: Tab; setTab: (t: Tab) => void;
  search: string; setSearch: (s: string) => void;
  rows: Friend[] | null;
  /** Messages in the whole tab (私聊 or 群聊) — the share column's 100%. */
  tabTotal: number;
  /** Largest chat in the tab — the bar column's full length. */
  tabMax: number;
  counts: { private: number | null; group: number | null };
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (id: string) => void;
}) {
  const [limit, setLimit] = useState(INDEX_PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  // New filter / query: back to the top, first page only.
  useEffect(() => {
    setLimit(INDEX_PAGE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab, search]);

  const label = (n: number | null) => (n == null ? '—' : fmt(n));
  let body: ReactNode;
  if (error && !rows) {
    const code = errorCode(error);
    const entry = lookupError(code);
    const raw = error instanceof Error ? error.message : String(error);
    body = (
      <ErrorState
        title={entry?.title ?? '名录没能加载'}
        code={code ?? undefined}
        reason={entry?.reason ?? '读取聊天列表时本地服务返回了错误。'}
        fixes={entry ? [entry.fix] : ['点「重试」再读一次', '还不行就在 06 数据源里点「更新数据」']}
        onRetry={onRetry}
        details={raw ? <pre>{maskText(redactDiagnostics(raw))}</pre> : undefined}
      />
    );
  } else if (!rows) {
    body = (
      <div className="home-idx__skel" aria-busy="true" aria-label="正在加载名录">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i}><Skeleton width={18} height={10} /><Skeleton width={`${30 + ((i * 37) % 40)}%`} height={10} /><Skeleton width={56} height={10} /></div>
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={search ? <IconSearch size={22} /> : <IconInbox size={22} />}
        label={search ? 'NO MATCH' : 'EMPTY'}
        title={search ? `没找到「${maskText(search)}」` : tab === 'group' ? '还没有群聊记录' : '还没有私聊记录'}
        description={search
          ? '试试备注、昵称或微信号里的一部分。'
          : '解密后的数据里还没有这类聊天。聊过天之后在 06 数据源里点「更新数据」再看。'}
        actions={search ? <Button size="sm" onClick={() => setSearch('')}>清除搜索</Button> : undefined}
      />
    );
  } else {
    const shown = rows.slice(0, limit);
    const more = rows.length - shown.length;
    body = (
      <table className={cx('home-idx', loading && 'is-refreshing')} aria-busy={loading || undefined}>
        <colgroup>
          <col className="home-idx__c-rk" /><col /><col className="home-idx__c-tag" />
          <col className="home-idx__c-n" /><col className="home-idx__c-share" /><col className="home-idx__c-last" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">名字</th>
            <th scope="col" className="home-idx__tag">标签</th>
            <th scope="col" className="r">消息<span className="home-idx__sort" aria-label="（按消息数从多到少）">↓</span></th>
            <th scope="col" className="home-idx__share">占{tab === 'group' ? '群聊' : '私聊'} %</th>
            <th scope="col" className="home-idx__last">最近</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((f, i) => {
            const share = tabTotal ? (f.count / tabTotal) * 100 : 0;
            const bar = tabMax ? (f.count / tabMax) * 100 : 0;
            return (
              <tr key={f.id} onClick={() => onOpen(f.id)}>
                <td className="home-idx__rk">{String(i + 1).padStart(2, '0')}</td>
                <td className="home-idx__name">
                  <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(f.id); }}>
                    {displayName(f.id, f.name)}
                  </button>
                </td>
                <td className="home-idx__tag">{f.tag && f.tag !== '—' ? f.tag : ''}</td>
                <td className="r home-idx__n">{fmt(f.count)}</td>
                <td className="home-idx__share">
                  <span className="home-idx__bar" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, Math.max(bar, bar > 0 ? 2 : 0))}%` }} />
                  </span>
                  <span>{share.toFixed(share >= 10 ? 1 : 2)}</span>
                </td>
                <td className="home-idx__last">{f.last}</td>
              </tr>
            );
          })}
          {more > 0 && (
            <tr className="home-idx__more">
              <td />
              <td colSpan={5}>
                <button type="button" onClick={() => setLimit(l => l + INDEX_PAGE)}>
                  +{fmt(more)} MORE<span>显示后 {fmt(Math.min(more, INDEX_PAGE))} 个</span>
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  }

  return (
    <Module
      id="04" title="名录" en="INDEX" className="home-m04" bodyClassName="home-m04__body"
      right={(
        <>
          <SegmentedControl
            label="聊天类型"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'private', label: <>私聊 <span className="ui-num">{label(counts.private)}</span></> , title: '私聊' },
              { value: 'group', label: <>群聊 <span className="ui-num">{label(counts.group)}</span></>, title: '群聊' },
            ]}
          />
          <label className="ui-field home-find">
            <IconSearch size={13} />
            <input
              type="search"
              placeholder="名字 / 微信号 / 备注"
              aria-label="在名录里搜索"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" className="ui-icon-btn home-find__clear" aria-label="清除搜索" title="清除搜索" onClick={() => setSearch('')}>
                <IconClose size={11} />
              </button>
            )}
          </label>
        </>
      )}
    >
      <div className="home-m04__scroll" ref={scrollRef}>{body}</div>
    </Module>
  );
}

// ———————————————————————— 05 标签 ————————————————————————

function LabelsModule({ people }: { people: Friend[] | null }) {
  const rows = useMemo(() => {
    if (!people) return null;
    const counts = new Map<string, number>();
    for (const f of people) {
      const t = f.tag || '—';
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const order = [...TAG_ORDER, ...[...counts.keys()].filter(t => !TAG_ORDER.includes(t))];
    return order.filter(t => counts.has(t)).map(t => ({ tag: t, n: counts.get(t) as number }));
  }, [people]);
  const total = people?.length ?? 0;
  const max = rows ? Math.max(1, ...rows.map(r => r.n)) : 1;
  return (
    <Module id="05" title="标签" en="AUTO LABEL" right={people ? `PRIVATE · ${fmt(total)}` : undefined} className="home-m05">
      <div className="home-lab">
        {!rows && Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="home-lab__row" aria-hidden="true"><Skeleton width={48} height={10} /><Skeleton height={6} /><Skeleton width={40} height={10} /></div>
        ))}
        {rows && rows.length === 0 && <div className="home-note">还没有私聊记录。</div>}
        {rows && rows.map(r => (
          <div key={r.tag} className="home-lab__row" title={TAG_RULE[r.tag] ?? '后端自动打的标签'}>
            <span className="home-lab__name">{r.tag === '—' ? '无时间' : r.tag}</span>
            <span className="home-lab__bar" aria-hidden="true"><i style={{ width: `${(r.n / max) * 100}%` }} /></span>
            <span className="home-lab__n">{fmt(r.n)}</span>
            <span className="home-lab__p">{pct(r.n, total)}%</span>
          </div>
        ))}
      </div>
    </Module>
  );
}

// ———————————————————————— 06 数据源 ————————————————————————

function SourceModule({ refreshing, refreshLog, onRefresh, onExtractKey, onToggleTasks, tasksOpen, onLiveSynced }: {
  refreshing: boolean;
  refreshLog: { at: Date; ok: boolean; text: string } | null;
  onRefresh: () => void;
  onExtractKey: () => void;
  onToggleTasks: () => void;
  tasksOpen: boolean;
  onLiveSynced: () => void;
}) {
  const { status } = useLiveSync();
  const syncOn = !!status?.enabled;
  const stamp = (d: Date) => d.toLocaleTimeString('zh-CN', { hour12: false });
  return (
    <Module id="06" title="数据源" en="SOURCE" right="LOCAL ONLY" className="home-m06">
      <div className="home-m06__sync">
        <LiveSyncToggle onSynced={onLiveSynced} disabled={refreshing} />
        {status && <span className="home-m06__iv">{syncOn ? `EVERY ${status.interval} S` : 'MANUAL'}</span>}
      </div>
      <div className="home-ro">
        <div>
          <div className="ui-label">LAST SYNC<b>最后同步</b></div>
          <div className="home-ro__v home-ro__v--sm">{syncOn ? clockTime(status?.last_sync_ts ?? null) : '—'}</div>
        </div>
        <div>
          <div className="ui-label">NEW<b>本次新增</b></div>
          <div className="home-ro__v home-ro__v--sm">{syncOn && status ? fmt(status.total_new_messages) : '—'}</div>
        </div>
      </div>
      <div className="home-m06__keys">
        <Button size="sm" kbd={<IconRefresh size={11} />} onClick={onRefresh} loading={refreshing}
          title="重新解密一遍微信数据库，读进最新的消息"
          aria-label={refreshing ? '正在解密最新数据' : '更新数据'}>
          {refreshing ? '解密中…' : '更新数据'}
        </Button>
        <Button size="sm" kbd={<IconKey size={11} />} onClick={onExtractKey} title="重新读取微信密钥，按引导操作">
          密钥
        </Button>
        <TaskCenterBell onClick={onToggleTasks} active={tasksOpen} />
      </div>
      <div className="home-m06__log" role="status" aria-live="polite">
        {refreshing ? (
          <><span className="home-m06__t">{stamp(new Date())}</span><span className="home-m06__w">RUN</span><span>正在解密最新数据…</span></>
        ) : refreshLog ? (
          <>
            <span className="home-m06__t">{stamp(refreshLog.at)}</span>
            <span className={refreshLog.ok ? 'home-m06__ok' : 'home-m06__err'}>{refreshLog.ok ? 'OK' : 'ERR'}</span>
            <span title={maskText(refreshLog.text)}>{maskText(refreshLog.text)}</span>
          </>
        ) : (
          <><span className="home-m06__t">{APP_VERSION.split(' ')[0]}</span><span>全部数据只在这台电脑上，不会上传</span></>
        )}
      </div>
    </Module>
  );
}

// ———————————————————————— loading ————————————————————————

/** The whole panel while the local backend starts (cold launch can take a while). */
function HomeSkeleton({ waitSec }: { waitSec: number }) {
  const segs = 30;
  return (
    <div className="home-page" aria-busy="true">
      <PageHeader title="年代记" />
      <div className="home-rack ui-rack">
        <Module id="01" title="联系人" right="CONTACTS" className="home-m01">
          <div className="home-m01__main home-boot" role="status">
            <div className="ui-label">BOOT<b>正在启动本地服务</b></div>
            <div className="ui-big home-m01__big home-boot__big">{String(waitSec).padStart(2, '0')}<small>S</small></div>
            <div className="home-boot__bar" aria-hidden="true">
              {Array.from({ length: segs }, (_, i) => <i key={i} style={{ animationDelay: `${(i * 60) % 1800}ms` }} />)}
            </div>
            <div className="home-m01__sub home-boot__hint">
              {waitSec >= 8
                ? (IS_MAC
                  ? '首次打开时，本地后端正在启动，可能要等 10–60 秒。'
                  : '首次打开时，本地后端正在启动；Windows 杀毒 / Defender 扫描 etcli.exe 时可能要等 10–60 秒。')
                : `正在连接 ${BACKEND_HOST}`}
            </div>
          </div>
        </Module>
        <Module id="02" title="月度热度" en="LAST 12 MONTHS" crop="bottom" className="home-m02">
          <div className="home-seq" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="home-seq__col">
                <span className="home-seq__read">··</span>
                <span className="home-seq__meter">{Array.from({ length: SEQ_SEGMENTS }, (_, s) => <i key={s} />)}</span>
                <span className="home-seq__m">{String(i + 1).padStart(2, '0')}</span>
                <span className="home-seq__tag" />
              </div>
            ))}
          </div>
        </Module>
        <TopModule top={[]} privateTotal={0} onOpen={() => {}} loading />
        <Module id="04" title="名录" en="INDEX" className="home-m04" bodyClassName="home-m04__body">
          <div className="home-idx__skel" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i}><Skeleton width={18} height={10} /><Skeleton width={`${30 + ((i * 37) % 40)}%`} height={10} /><Skeleton width={56} height={10} /></div>
            ))}
          </div>
        </Module>
        <div className="home-side">
          <LabelsModule people={null} />
          <Module id="06" title="数据源" en="SOURCE" right="LOCAL ONLY" className="home-m06">
            <div className="home-m06__log"><span className="home-m06__t">—</span><span>等待本地服务…</span></div>
          </Module>
        </div>
      </div>
    </div>
  );
}

function isOnboardingNeededError(e: any): boolean {
  if (errorCode(e) === 'NO_DECRYPTED_DATA') return true;
  const text = String(e?.message || e || '').toLowerCase();
  return text.includes('no_decrypted_data') ||
    text.includes('onboarding_required') ||
    text.includes('needs_onboarding') ||
    text.includes('bootstrap mode');
}

// ———————————————————————— page ————————————————————————

export function HomePage({ onOpenFriend, onOpenOnboarding }: Props) {
  void usePrivacy();
  const [tab, setTab] = useState<Tab>('private');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  // Every chat with messages (kind=all) — feeds 01 / 03 / 04 / 05.
  const [everyone, setEveryone] = useState<Friend[] | null>(null);
  const [everyoneError, setEveryoneError] = useState<unknown>(null);
  const [everyoneNonce, setEveryoneNonce] = useState(0);
  // 名录 search results (backend `q`, which also matches 微信号 / 备注).
  const [found, setFound] = useState<Friend[] | null>(null);
  const [findError, setFindError] = useState<unknown>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootWaitSec, setBootWaitSec] = useState(0);
  const [bootLogs, setBootLogs] = useState<LogTailResponse | null>(null);
  // Bumped by the error screen's retry button to re-run the boot probe.
  const [bootNonce, setBootNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshLog, setRefreshLog] = useState<{ at: Date; ok: boolean; text: string } | null>(null);
  const [extractOpen, setExtractOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const taskCenter = useTaskCenter();
  const onOpenOnboardingRef = useRef(onOpenOnboarding);
  useEffect(() => { onOpenOnboardingRef.current = onOpenOnboarding; }, [onOpenOnboarding]);

  // Initial load
  useEffect(() => {
    // Retry for up to 60 seconds on cold launch. On Windows the bundled
    // PyInstaller etcli.exe can be slowed down by Defender/AV scanning, and
    // on slower machines the webview may render long before port 9100 is ready.
    // A user-initiated 「重新连接」 that gets an HTTP answer shows it right away:
    // the backend is up, so polling for another minute won't change anything.
    const isReconnect = bootNonce > 0;
    let cancelled = false;
    let attempts = 0;
    const tryFetch = async () => {
      setBootLogs(null);
      while (!cancelled && attempts < 80) {
        attempts++;
        setBootWaitSec(Math.ceil((attempts - 1) * 0.75));
        try {
          const r = await getHomeSummary();
          if (!cancelled) { setSummary(r); setError(null); setBootWaitSec(0); }
          return;
        } catch (e: any) {
          if (cancelled) return;
          if (isOnboardingNeededError(e)) {
            setError(String(e?.message || e));
            setBootWaitSec(0);
            onOpenOnboardingRef.current?.();
            return;
          }
          // Last attempt (or the backend answered a reconnect) — surface the error
          if (attempts >= 80 || (isReconnect && e instanceof ApiError && e.status > 0)) {
            setError(String(e?.message || e));
            getTauriLogTail(80)
              .then(localLogs => localLogs || getLogTail(80))
              .then(logs => {
                if (!cancelled) setBootLogs(logs);
              }).catch(() => {
                if (!cancelled) setBootLogs(null);
              });
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 750));
        }
      }
    };
    tryFetch();
    return () => { cancelled = true; };
  }, [bootNonce]);

  // Debounce search
  useEffect(() => {
    const t = window.setTimeout(() => setSearchDebounced(search.trim()), 220);
    return () => window.clearTimeout(t);
  }, [search]);

  // Every chat — only after the boot probe succeeds. Otherwise this request
  // can race the 60s startup retry and falsely flip the page into error state.
  const summaryReady = summary != null;
  useEffect(() => {
    if (!summaryReady) return;
    let cancelled = false;
    getAllFriends({ kind: 'all' })
      .then(fs => { if (!cancelled) { setEveryone(fs); setEveryoneError(null); } })
      .catch(e => { if (!cancelled) setEveryoneError(e); });
    return () => { cancelled = true; };
  }, [summaryReady, everyoneNonce]);

  // 名录 search goes to the backend (it also matches 微信号 / 备注, which the
  // list payload doesn't carry).
  useEffect(() => {
    if (!summaryReady || !searchDebounced) { setFound(null); setFindError(null); return; }
    let cancelled = false;
    setFinding(true);
    getAllFriends({ kind: tab, q: searchDebounced })
      .then(fs => { if (!cancelled) { setFound(fs); setFindError(null); } })
      .catch(e => { if (!cancelled) setFindError(e); })
      .finally(() => { if (!cancelled) setFinding(false); });
    return () => { cancelled = true; };
  }, [summaryReady, tab, searchDebounced, everyoneNonce]);

  const reloadAll = useCallback(async () => {
    const [s, fs] = await Promise.all([getHomeSummary(), getAllFriends({ kind: 'all' })]);
    setSummary(s);
    setEveryone(fs);
    setEveryoneError(null);
    setEveryoneNonce(n => n + 1);
  }, []);

  // Live sync swapped in new DB files: quietly re-fetch what the page shows.
  const handleLiveSynced = useCallback(() => {
    reloadAll().catch(() => {
      // transient (e.g. a DB mid-swap) — the next sync or a manual refresh catches up
    });
  }, [reloadAll]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    const taskId = taskCenter.addTask({
      icon: 'lock', name: '正在解密最新数据', sub: '运行 refresh.py …', pct: 5, status: 'run',
    });
    // simulate progress while waiting (real backend doesn't stream)
    const progT = window.setInterval(() => {
      taskCenter.updateTask(taskId, { pct: Math.min(90, Math.floor(Math.random() * 8) + 30) });
    }, 600);
    try {
      const r = await refreshData();
      window.clearInterval(progT);
      const failCode = r.ok ? null : (r.code ?? null);
      const failure = r.ok ? '' : summarizeRefreshFailure(r.details || '', failCode);
      const partial = r.ok && (r.details || '').includes('[WARN]');
      const successMsg = partial
        ? '已更新，但部分数据库未解密；可多打开聊天/朋友圈后重抓密钥'
        : `已更新 · ${(r.ms / 1000).toFixed(1)}s`;
      taskCenter.updateTask(taskId, {
        pct: 100, status: r.ok ? 'done' : 'error',
        sub: r.ok ? successMsg : refreshFailureDetail(failure, failCode),
      });
      setRefreshLog({ at: new Date(), ok: r.ok, text: r.ok ? successMsg : failure });
      if (r.ok) {
        await reloadAll();
        pollLiveSyncNow();
      }
    } catch (e: any) {
      window.clearInterval(progT);
      const failCode = errorCode(e);
      const failure = summarizeRefreshFailure(e?.message || String(e), failCode);
      taskCenter.updateTask(taskId, { status: 'error', pct: 100, sub: refreshFailureDetail(failure, failCode) });
      setRefreshLog({ at: new Date(), ok: false, text: failure });
    } finally {
      setRefreshing(false);
    }
  }

  // ——— derived readouts (exact sums over what the backend returned) ———
  const derived = useMemo(() => {
    if (!everyone) return null;
    const people = everyone.filter(f => !f.isGroup).sort((a, b) => b.count - a.count);
    const groups = everyone.filter(f => f.isGroup).sort((a, b) => b.count - a.count);
    return {
      people, groups,
      peopleMsgs: sumCounts(people),
      groupMsgs: sumCounts(groups),
      stale: people.filter(f => f.tag === '久未联系').length,
    };
  }, [everyone]);

  if (error && !summary) {
    if (isOnboardingNeededError(error)) {
      return (
        <EmptyState
          layout="page"
          icon={<IconKey size={22} />}
          label="SETUP · 00"
          title="还没完成初始化"
          description="本地后端已经启动了，但还没有找到可用的解密数据。请按初始化引导选择微信数据目录、抓密钥并解密。"
          actions={onOpenOnboarding && (
            <Button variant="primary" kbd="↵" onClick={onOpenOnboarding}>打开初始化引导</Button>
          )}
        />
      );
    }
    const info = describeBootError(error);
    return (
      <ErrorState
        layout="page"
        code={info.code}
        title={info.title}
        reason={info.reason}
        fixes={info.fixes}
        onRetry={() => { setError(null); setBootLogs(null); setBootNonce(n => n + 1); }}
        retryLabel="重新连接"
        diagnostics={() => bootDiagnostics(error, bootLogs)}
        // Redacted on screen too: when copying fails the button tells users to
        // take a screenshot, and that also ends up in a public issue.
        details={
          <>
            <div>报错原文</div>
            <pre>{maskText(redactDiagnostics(error))}</pre>
            {bootLogs && (
              <>
                <div>启动诊断日志 · {maskText(redactDiagnostics(bootLogs.logs_dir))}</div>
                <pre>{maskText(redactDiagnostics([
                  '--- serve.log ---',
                  bootLogs.serve || '(empty)',
                  '',
                  '--- tauri-shell.log ---',
                  bootLogs.tauri_shell || '(empty)',
                ].join('\n')))}</pre>
              </>
            )}
          </>
        }
      />
    );
  }

  if (!summary) {
    return <HomeSkeleton waitSec={bootWaitSec} />;
  }

  // Connected, but the decrypted data has no chats yet (fresh account, wrong
  // account picked, or a decrypt that is still filling in).
  // A failed chat list is not "no data": it keeps its own ErrorState in 04.
  const noData = homeHasNoData({
    totalContacts: summary.totalContacts, topFriends: summary.topFriends.length,
    friendsLoaded: everyone != null || everyoneError != null, friendsCount: everyone?.length ?? 0,
    friendsError: everyoneError, search: '', tab: 'private',
  });

  const extract = (
    <ExtractKeyDialog
      open={extractOpen}
      onClose={() => setExtractOpen(false)}
      onSuccess={() => { void handleRefresh(); }}
    />
  );

  if (noData) {
    return (
      <div className="home-page">
        <PageHeader title="年代记" />
        <EmptyState
          layout="page"
          icon={<IconInbox size={22} />}
          label="NO DATA · 00"
          title="这里还空着"
          description="已经连上本地服务，但解密后的数据里还没有聊天记录。刚完成初始化的话，等解密跑完再点「更新数据」；也可能是选错了账号，可以在右下角切换。"
          actions={(
            <>
              <Button variant="primary" kbd={<IconRefresh size={11} />} loading={refreshing} onClick={handleRefresh}>
                更新数据
              </Button>
              {onOpenOnboarding && <Button onClick={onOpenOnboarding}>重新走一遍初始化</Button>}
            </>
          )}
        />
        {extract}
      </div>
    );
  }

  const tabList = derived ? (tab === 'group' ? derived.groups : derived.people) : null;
  const tabTotal = derived ? (tab === 'group' ? derived.groupMsgs : derived.peopleMsgs) : 0;
  const rows = searchDebounced ? found : tabList;
  const rowsError = searchDebounced ? findError : everyoneError;

  return (
    <div className="home-page">
      <PageHeader title="年代记" />
      <div className="home-rack ui-rack">
        <ContactsModule
          summary={summary}
          people={derived ? derived.people.length : null}
          groups={derived ? derived.groups.length : null}
          totalMsgs={derived ? derived.peopleMsgs + derived.groupMsgs : null}
          stale={derived ? derived.stale : null}
        />
        <HeatModule summary={summary} />
        <TopModule
          top={derived ? derived.people.slice(0, 8) : []}
          privateTotal={derived?.peopleMsgs ?? 0}
          onOpen={onOpenFriend}
          loading={!derived && !everyoneError}
        />
        <IndexModule
          tab={tab} setTab={setTab}
          search={search} setSearch={setSearch}
          rows={rows}
          tabTotal={tabTotal}
          tabMax={tabList?.[0]?.count ?? 0}
          counts={{ private: derived?.people.length ?? null, group: derived?.groups.length ?? null }}
          loading={finding}
          error={rowsError}
          onRetry={() => setEveryoneNonce(n => n + 1)}
          onOpen={onOpenFriend}
        />
        <div className="home-side">
          <LabelsModule people={derived ? derived.people : null} />
          <SourceModule
            refreshing={refreshing}
            refreshLog={refreshLog}
            onRefresh={handleRefresh}
            onExtractKey={() => setExtractOpen(true)}
            onToggleTasks={() => setTaskCenterOpen(o => !o)}
            tasksOpen={taskCenterOpen}
            onLiveSynced={handleLiveSynced}
          />
        </div>
      </div>
      {extract}
      {taskCenterOpen && <TaskCenterDrawer onClose={() => setTaskCenterOpen(false)} />}
    </div>
  );
}

// Task-center line: catalog title + fix when the backend sent a known code.
function refreshFailureDetail(summary: string, code: string | null): string {
  const entry = lookupError(code);
  return entry ? `${entry.title}：${entry.fix}` : summary;
}

function summarizeRefreshFailure(details: string, code: string | null = null): string {
  const entry = lookupError(code);
  if (entry) return `更新失败：${entry.title}`;
  const text = details || '';
  if (text.includes('找不到 Mac 解密密钥') || text.includes('decrypted_keys.json')) {
    return '缺少 Mac 解密密钥：先点「密钥」→「开始自动抓取」，抓到后再更新数据。';
  }
  if (text.includes('找不到密钥') || text.toLowerCase().includes('no key')) {
    return '缺少解密密钥：先完成密钥抓取，再更新数据。';
  }
  if (text.includes('核心数据库未解密')) {
    return '核心数据库未解密：请重新抓密钥后再更新数据。';
  }
  const firstUsefulLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('[INFO]'));
  return `更新失败：${(firstUsefulLine || text || '未知错误').slice(0, 80)}`;
}

/** Turn a boot-probe failure into code / reason / fixes for <ErrorState>.
 * Errors from data/api.ts look like `API /api/home-summary: 503 {json}`;
 * anything else means fetch() itself failed (backend not listening). */
function describeBootError(raw: string): { code: string; title: string; reason: ReactNode; fixes: ReactNode[] } {
  const isMac = IS_MAC;
  const logHint = <>查看日志 <code>~/Documents/Murmur/logs/serve.log</code></>;
  const issueHint = '还不行就点「复制诊断信息」，贴到 GitHub issue 给作者 sgaofen';
  const m = /^API (\S+): (\d{3})\s*([\s\S]*)$/.exec(raw);
  if (!m) {
    return {
      code: 'BACKEND_UNREACHABLE',
      title: '后端没起来',
      reason: <>Murmur 会在后台自动启动本地服务（{isMac ? 'etcli' : 'etcli.exe'}），但等了一分钟仍然连不上 <code>{BACKEND_HOST}</code>。</>,
      fixes: [
        '完全退出 Murmur 再重新打开',
        logHint,
        <>开发模式可手动运行 <code>{isMac ? 'bash start-mac.sh' : 'start-windows.bat'}</code></>,
        issueHint,
      ],
    };
  }
  const status = Number(m[2]);
  const body = readErrorBody(m[3]);
  const apiCode = body.error && /^[a-z][a-z0-9_]*$/.test(body.error) ? body.error : null;
  const message = body.message;
  const detail = !message && body.error && !apiCode ? body.error : null;
  return {
    code: apiCode ? `HTTP ${status} · ${apiCode}` : `HTTP ${status}`,
    title: '首页数据没能加载',
    reason: message
      ? maskText(redactDiagnostics(message))
      : `本地服务返回了错误（HTTP ${status}）${detail ? `：${maskText(redactDiagnostics(detail)).slice(0, 160)}` : '。'}`,
    fixes: ['点「重新连接」再试一次', '完全退出 Murmur 再重新打开', logHint, issueHint],
  };
}

/** Pull `error` / `message` out of an etcli error body. data/api.ts keeps only
 * the first 200 chars, so long JSON bodies (e.g. database_malformed) arrive
 * truncated — fall back to reading the string fields directly. */
function readErrorBody(text: string): { error: string | null; message: string | null } {
  const body = parseJsonObject(text);
  if (body) {
    return {
      error: typeof body.error === 'string' ? body.error : null,
      message: typeof body.message === 'string' ? body.message : null,
    };
  }
  return { error: readJsonStringField(text, 'error'), message: readJsonStringField(text, 'message') };
}

function parseJsonObject(text: string): { error?: unknown; message?: unknown } | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? v as { error?: unknown; message?: unknown } : null;
  } catch {
    return null;  // body was plain text / truncated
  }
}

/** `"key": "value"` from possibly-truncated JSON; an unterminated value gets a trailing「…」. */
function readJsonStringField(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(")?`).exec(text);
  if (!m) return null;
  let value: string;
  try {
    value = JSON.parse(`"${m[1]}"`) as string;
  } catch {
    value = m[1];  // cut in the middle of an escape sequence
  }
  return m[2] ? value : `${value}…`;
}

/** Text behind 「复制诊断信息」. When the backend answered with an HTTP error,
 * prefer its /api/diag-bundle (profiles, init_error, log tails — scrubbed by
 * cli/diag_redact.py); otherwise use the log tail we already fetched.
 * ErrorState runs the result through redactDiagnostics() before copying, so
 * this is redacted whether or not privacy mode is on. */
async function bootDiagnostics(error: string, logs: LogTailResponse | null): Promise<string> {
  const head = [
    '### Murmur 启动诊断',
    `- 版本：${APP_VERSION}`,
    `- 平台：${navigator.userAgent}`,
    `- 时间：${new Date().toISOString()}`,
    `- 报错：${error}`,
  ];
  let body: string[] = logs ? [
    `- 日志目录：${logs.logs_dir}`,
    '',
    '```',
    '--- serve.log ---',
    logs.serve || '(empty)',
    '',
    '--- tauri-shell.log ---',
    logs.tauri_shell || '(empty)',
    '```',
  ] : [];
  if (/^API \S+: \d{3}\b/.test(error)) {
    try {
      body = ['', (await getDiagBundle()).markdown];
    } catch {
      // diag-bundle unavailable — keep the local log tail
    }
  }
  return maskText([...head, ...body].join('\n'));
}
