import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Avatar } from '../components/Avatar';
import { FriendCard } from '../components/FriendCard';
import { Postmark } from '../components/Postmark';
import { Ribbon } from '../components/Ribbon';
import { Sparkline } from '../components/Sparkline';
import { APP_VERSION, ApiError, errorCode, getAllFriends, getDiagBundle, getHomeSummary, getLogTail, getTauriLogTail, refreshData } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import type { LogTailResponse } from '../data/api';
import type { Friend, HomeSummary } from '../data/types';
import { ExtractKeyDialog } from './ExtractKeyDialog';
import { TaskCenterBell, TaskCenterDrawer, useTaskCenter } from '../components/extras/TaskCenter';
import { displayName, maskText } from '../utils/privacy';
import { redactDiagnostics } from '../utils/diagRedact';
import { usePrivacy } from '../utils/usePrivacy';
import { LiveSyncToggle } from '../components/LiveSyncToggle';
import { Button, EmptyState, ErrorState, SegmentedControl, Skeleton, SkeletonText, cx } from '../ui';
import { IconClose, IconInbox, IconKey, IconRefresh, IconSearch } from '../ui/icons';
import { PageHeader } from '../shell/PageHeader';
import './Home.css';
import { homeHasNoData } from '../utils/pageStates';

interface Props {
  onOpenFriend: (id: string) => void;
  onOpenOnboarding?: () => void;
  onOpenQQ?: () => void;
}

type Tab = 'private' | 'group' | 'time';

function HomeChromeBar({ onRefresh, refreshing, refreshMsg, onExtractKey, onToggleTaskCenter, taskCenterActive, onLiveSynced }: {
  onRefresh: () => void; refreshing: boolean; refreshMsg: string; onExtractKey: () => void;
  onToggleTaskCenter: () => void; taskCenterActive: boolean; onLiveSynced: () => void;
}) {
  // Logo, account switcher and the 年度 / 关系网 / 报告 / 表格 links moved to
  // the app shell's left nav; only Home's own actions stay here.
  return (
    <PageHeader title="首页" subtitle="年代记 · 你和朋友们的这些年">
      {refreshMsg && (
        <span className="home-refresh-msg" role="status" title={maskText(refreshMsg)}>{maskText(refreshMsg)}</span>
      )}
      <TaskCenterBell onClick={onToggleTaskCenter} active={taskCenterActive} />
      <Button variant="ghost" size="sm" className="home-action" icon={<IconKey size={14} />} onClick={onExtractKey}
        title="重新读取微信密钥，按引导操作" aria-label="密钥">
        密钥
      </Button>
      <LiveSyncToggle onSynced={onLiveSynced} disabled={refreshing} />
      <Button variant="ghost" size="sm" className="home-action" icon={<IconRefresh size={14} />} onClick={onRefresh} loading={refreshing}
        aria-label={refreshing ? '正在解密最新数据' : '更新数据'}>
        {refreshing ? '正在解密最新数据…' : '更新数据'}
      </Button>
    </PageHeader>
  );
}

function HeroFrame({ summary, onOpen }: { summary: HomeSummary; onOpen: (id: string) => void }) {
  void usePrivacy();
  return (
    <section className="home-hero et-paper-grain" aria-label="年代记">
      <div className="home-hero__frame" aria-hidden="true" />
      <div className="home-hero__postmark" aria-hidden="true">
        <Postmark size={86} />
      </div>
      <div className="home-hero__ribbon">
        <Ribbon color="var(--accent-solid)" tone="solid">2026 · 年代记</Ribbon>
        <span className="et-meta">Murmur · Vol. 01</span>
      </div>
      <h2 className="home-hero__title">
        这些年，时间带你遇见了 <em className="et-num">{summary.totalContacts.toLocaleString()}</em> 个人，<br />
        其中 <em className="et-num">{summary.closeFriends.toLocaleString()}</em> 位朋友，陪你走过了{' '}
        <em className="et-num">{summary.daysSinceFirst.toLocaleString()}</em> 天。
      </h2>
      <p className="home-hero__lede">翻一翻今年最常聊的人，这是 Murmur 写给你的一封小信。</p>
      {summary.topFriends.length > 0 && (
        <ol className="home-top" aria-label="今年最常聊的人">
          {summary.topFriends.map((f, i) => (
            <li key={f.id}>
              <button type="button" className={cx('home-top__item', i === 0 && 'is-first')} onClick={() => onOpen(f.id)}>
                <span className="home-top__rank">No.{i + 1}</span>
                <Avatar friend={f} size={i === 0 ? 64 : 52} ring={i === 0} />
                <span className="home-top__text">
                  <span className="home-top__name">{displayName(f.id, f.name)}</span>
                  <span className="home-top__count et-num">
                    {f.count.toLocaleString()}<span className="home-top__unit">条</span>
                  </span>
                  <span className="home-top__last">{f.last}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Timeline({ summary }: { summary: HomeSummary }) {
  return (
    <section className="home-card home-timeline">
      <div className="home-timeline__head">
        <div>
          <div className="et-eyebrow">时光线 · 一年里你和谁说话最多</div>
          <div className="home-timeline__title">{summary.heat.peakLabel}最响，{summary.heat.troughLabel}最静。</div>
        </div>
        <div className="home-timeline__stats">
          <span className="et-meta">高峰 · {summary.heat.peakLabel} <span className="et-num home-timeline__peak">{summary.heat.peakCount.toLocaleString()}</span> 条</span>
          <span className="et-meta">沉默 · {summary.heat.troughLabel} <span className="et-num">{summary.heat.troughCount.toLocaleString()}</span> 条</span>
        </div>
      </div>
      <Sparkline data={summary.heat.values} months={summary.heat.months} w={870} h={88} />
    </section>
  );
}

function FilterBar({
  tab, setTab, search, setSearch, count,
}: {
  tab: Tab; setTab: (s: Tab) => void;
  search: string; setSearch: (s: string) => void;
  count: number;
}) {
  return (
    <div className="home-filter">
      <div className="home-filter__left">
        <SegmentedControl
          label="朋友类型"
          value={tab === 'group' ? 'group' : 'private'}
          onChange={(v) => setTab(v as Tab)}
          options={[{ value: 'private', label: '私聊朋友' }, { value: 'group', label: '群聊' }]}
        />
        <span className="et-meta">共 {count.toLocaleString()} 个 · 按总消息数排序</span>
      </div>
      <label className="home-search">
        <IconSearch size={14} />
        <input
          type="search"
          placeholder="搜索朋友（姓名 / 微信号 / 备注）"
          aria-label="搜索朋友"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button type="button" className="ui-icon-btn" aria-label="清除搜索" title="清除搜索" onClick={() => setSearch('')}>
            <IconClose size={12} />
          </button>
        )}
      </label>
    </div>
  );
}

/** Placeholder for one FriendCard while the list loads. */
function FriendCardSkeleton() {
  return (
    <div className="home-skel-card" aria-hidden="true">
      <div className="home-skel-card__row">
        <Skeleton width={42} circle />
        <div className="home-skel-card__lines">
          <Skeleton width="58%" height={15} />
          <Skeleton width="40%" height={11} />
        </div>
      </div>
      <div className="home-skel-card__row">
        <div className="home-skel-card__lines">
          <Skeleton width={96} height={22} />
          <Skeleton width="52%" height={11} />
        </div>
        <Skeleton width={56} height={20} radius={999} />
      </div>
    </div>
  );
}

function FriendGridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="home-grid" aria-busy="true" aria-label="正在加载朋友列表">
      {Array.from({ length: n }, (_, i) => <FriendCardSkeleton key={i} />)}
    </div>
  );
}

/** The whole page while the local backend starts (cold launch can take a while). */
function HomeSkeleton({ waitSec }: { waitSec: number }) {
  return (
    <div className="home-page et-root" aria-busy="true">
      <PageHeader title="首页" subtitle="年代记 · 你和朋友们的这些年" />
      <div className="home-boot" role="status">
        <span className="ui-spinner" aria-hidden="true" />
        <span>正在启动本地服务…</span>
        <span className="home-boot__hint">
          {waitSec >= 8
            ? `首次打开时，本地后端正在启动；Windows 杀毒/Defender 扫描 etcli.exe 时可能要等 10-60 秒。已等待 ${waitSec} 秒`
            : '正在连接 127.0.0.1:9100'}
        </span>
      </div>
      <section className="home-hero home-hero--skeleton" aria-hidden="true">
        <Skeleton width={150} height={26} radius={4} />
        <Skeleton width="72%" height={34} />
        <Skeleton width="54%" height={34} />
        <Skeleton width="40%" height={13} />
        <div className="home-top">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="home-top__skel">
              <Skeleton width={i === 0 ? 64 : 52} circle />
              <Skeleton width="60%" height={14} />
              <Skeleton width="44%" height={16} />
            </div>
          ))}
        </div>
      </section>
      <section className="home-card home-timeline" aria-hidden="true">
        <SkeletonText lines={2} lastLineWidth="36%" />
        <div className="ui-mt-4"><Skeleton height={70} radius={6} /></div>
      </section>
      <div className="home-filter" aria-hidden="true">
        <Skeleton width={150} height={30} radius={999} />
        <Skeleton width={240} height={34} radius={999} />
      </div>
      <FriendGridSkeleton />
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

export function HomePage({ onOpenFriend, onOpenOnboarding }: Props) {
  void usePrivacy();
  const [tab, setTab] = useState<Tab>('private');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [allFriends, setAllFriends] = useState<Friend[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(true);
  // First list response arrived (skeleton until then), and its failure if any.
  const [friendsLoaded, setFriendsLoaded] = useState(false);
  const [friendsError, setFriendsError] = useState<unknown>(null);
  const [friendsNonce, setFriendsNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [bootWaitSec, setBootWaitSec] = useState(0);
  const [bootLogs, setBootLogs] = useState<LogTailResponse | null>(null);
  // Bumped by the error screen's retry button to re-run the boot probe.
  const [bootNonce, setBootNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');
  const [extractOpen, setExtractOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const taskCenter = useTaskCenter();
  const debounceRef = useRef<number | null>(null);

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
            onOpenOnboarding?.();
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
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setSearchDebounced(search), 220);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [search]);

  // Fetch friends only after the boot probe succeeds. Otherwise this request
  // can race the 60s startup retry and falsely flip the page into error state.
  useEffect(() => {
    if (!summary) return;
    let cancelled = false;
    setLoadingFriends(true);
    getAllFriends({ kind: tab === 'time' ? 'all' : tab, q: searchDebounced })
      .then(fs => {
        if (!cancelled) {
          setAllFriends(fs);
          setFriendsError(null);
        }
      })
      .catch(e => {
        if (!cancelled) setFriendsError(e);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFriends(false);
          setFriendsLoaded(true);
        }
      });
    return () => { cancelled = true; };
  }, [summary, tab, searchDebounced, friendsNonce]);

  // Live sync swapped in new DB files: quietly re-fetch what the page shows.
  async function handleLiveSynced() {
    try {
      const [s, fs] = await Promise.all([
        getHomeSummary(),
        getAllFriends({ kind: tab === 'time' ? 'all' : tab, q: searchDebounced }),
      ]);
      setSummary(s);
      setAllFriends(fs);
    } catch {
      // transient (e.g. a DB mid-swap) — the next sync or a manual refresh catches up
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshMsg('');
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
      setRefreshMsg(r.ok ? successMsg : failure);
      if (r.ok) {
        const [s, fs] = await Promise.all([
          getHomeSummary(),
          getAllFriends({ kind: tab === 'time' ? 'all' : tab, q: searchDebounced }),
        ]);
        setSummary(s);
        setAllFriends(fs);
      }
    } catch (e: any) {
      window.clearInterval(progT);
      const failCode = errorCode(e);
      const failure = summarizeRefreshFailure(e?.message || String(e), failCode);
      taskCenter.updateTask(taskId, { status: 'error', pct: 100, sub: refreshFailureDetail(failure, failCode) });
      setRefreshMsg(failure);
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(''), 6000);
    }
  }

  if (error && !summary) {
    if (isOnboardingNeededError(error)) {
      return (
        <EmptyState
          layout="page"
          icon={<IconKey size={26} />}
          title="还没完成初始化"
          description="本地后端已经启动了，但还没有找到可用的解密数据。请按初始化引导选择微信数据目录、抓密钥并解密。"
          actions={onOpenOnboarding && (
            <Button variant="primary" size="lg" onClick={onOpenOnboarding}>打开初始化引导</Button>
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
  // A failed friend list is not "no data": it keeps its own ErrorState below.
  const noData = homeHasNoData({
    totalContacts: summary.totalContacts, topFriends: summary.topFriends.length,
    friendsLoaded, friendsCount: allFriends.length, friendsError, search: searchDebounced, tab,
  });

  let list: ReactNode;
  if (!friendsLoaded) {
    list = <FriendGridSkeleton />;
  } else if (friendsError && !loadingFriends) {
    const code = errorCode(friendsError);
    const entry = lookupError(code);
    const raw = friendsError instanceof Error ? friendsError.message : String(friendsError);
    list = (
      <ErrorState
        className="home-list-empty"
        title={entry?.title ?? '朋友列表没能加载'}
        code={code ?? undefined}
        reason={entry?.reason ?? '读取朋友列表时本地服务返回了错误。'}
        fixes={entry ? [entry.fix] : ['点「重试」再读一次', '还不行就点右上角「更新数据」']}
        onRetry={() => setFriendsNonce(n => n + 1)}
        details={raw ? <pre>{maskText(redactDiagnostics(raw))}</pre> : undefined}
      />
    );
  } else if (allFriends.length === 0 && !loadingFriends) {
    list = (
      <EmptyState
        className="home-list-empty"
        icon={searchDebounced ? <IconSearch size={26} /> : <IconInbox size={26} />}
        title={searchDebounced
          ? `没找到「${maskText(searchDebounced)}」`
          : tab === 'group' ? '还没有群聊记录' : '还没有私聊朋友'}
        description={searchDebounced
          ? '试试备注、昵称或微信号里的一部分。'
          : '解密后的数据里还没有这类聊天。聊过天之后点右上角「更新数据」再看。'}
        actions={searchDebounced
          ? <Button size="sm" onClick={() => setSearch('')}>清除搜索</Button>
          : undefined}
      />
    );
  } else {
    list = (
      <div className={cx('home-grid', loadingFriends && 'is-refreshing')} aria-busy={loadingFriends || undefined}>
        {allFriends.map((f, i) => (
          <FriendCard key={f.id} friend={f} rank={i + 1} onClick={() => onOpenFriend(f.id)} />
        ))}
      </div>
    );
  }

  return (
    <div className="home-page et-root">
      <HomeChromeBar onRefresh={handleRefresh} refreshing={refreshing} refreshMsg={refreshMsg}
        onExtractKey={() => setExtractOpen(true)}
        onToggleTaskCenter={() => setTaskCenterOpen(o => !o)}
        taskCenterActive={taskCenterOpen}
        onLiveSynced={handleLiveSynced} />
      {noData ? (
        <EmptyState
          layout="page"
          icon={<IconInbox size={26} />}
          title="这里还空着"
          description="已经连上本地服务，但解密后的数据里还没有聊天记录。刚完成初始化的话，等解密跑完再点「更新数据」；也可能是选错了账号，可以在左下角切换。"
          actions={(
            <>
              <Button variant="primary" icon={<IconRefresh size={15} />} loading={refreshing} onClick={handleRefresh}>
                更新数据
              </Button>
              {onOpenOnboarding && <Button onClick={onOpenOnboarding}>重新走一遍初始化</Button>}
            </>
          )}
        />
      ) : (
        <>
          <HeroFrame summary={summary} onOpen={onOpenFriend} />
          <Timeline summary={summary} />
          <FilterBar tab={tab} setTab={setTab} search={search} setSearch={setSearch} count={allFriends.length} />
          {list}
          <footer className="home-footer">
            <span className="et-meta">全部数据均在你的电脑上 · 不会上传到任何云端</span>
            <span className="et-meta home-footer__version">{APP_VERSION}</span>
          </footer>
        </>
      )}
      <ExtractKeyDialog
        open={extractOpen}
        onClose={() => setExtractOpen(false)}
        onSuccess={() => { handleRefresh(); }}
      />
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
  const isMac = navigator.userAgent.toLowerCase().includes('mac');
  const logHint = <>查看日志 <code>~/Documents/Murmur/logs/serve.log</code></>;
  const issueHint = '还不行就点「复制诊断信息」，贴到 GitHub issue 给作者 sgaofen';
  const m = /^API (\S+): (\d{3})\s*([\s\S]*)$/.exec(raw);
  if (!m) {
    return {
      code: 'BACKEND_UNREACHABLE',
      title: '后端没起来',
      reason: <>Murmur 会在后台自动启动本地服务（{isMac ? 'etcli' : 'etcli.exe'}），但等了一分钟仍然连不上 <code>127.0.0.1:9100</code>。</>,
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
