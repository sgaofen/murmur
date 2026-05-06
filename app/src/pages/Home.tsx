import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { FriendCard } from '../components/FriendCard';
import { Postmark } from '../components/Postmark';
import { Ribbon } from '../components/Ribbon';
import { Sparkline } from '../components/Sparkline';
import { APP_VERSION, getAllFriends, getHomeSummary, getLogTail, getTauriLogTail, refreshData } from '../data/api';
import type { LogTailResponse } from '../data/api';
import type { Friend, HomeSummary } from '../data/types';
import { ExtractKeyDialog } from './ExtractKeyDialog';
import { TaskCenterBell, TaskCenterDrawer, useTaskCenter } from '../components/extras/TaskCenter';
import { displayName, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { ProfileSwitcher } from '../components/ProfileSwitcher';

interface Props {
  dark?: boolean;
  onOpenFriend: (id: string) => void;
  onOpenOnboarding?: () => void;
  onOpenQQ?: () => void;
}

type Tab = 'private' | 'group' | 'time';

function HomeChromeBar({ onRefresh, refreshing, refreshMsg, onExtractKey, onToggleTaskCenter, taskCenterActive }: {
  onRefresh: () => void; refreshing: boolean; refreshMsg: string; onExtractKey: () => void;
  onToggleTaskCenter: () => void; taskCenterActive: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 28px', borderBottom: '0.5px solid var(--et-line)', background: 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg width="22" height="22" viewBox="0 0 22 22">
          <circle cx="11" cy="11" r="9.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.2" />
          <circle cx="11" cy="11" r="5.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.2" />
          <circle cx="11" cy="11" r="1.6" fill="var(--et-orange)" />
        </svg>
        <div className="et-serif" style={{ fontSize: 17, fontWeight: 600, color: 'var(--et-ink)', letterSpacing: '0.04em' }}>Murmur 微语</div>
        <div style={{ width: 1, height: 14, background: 'var(--et-line-2)', margin: '0 4px' }} />
        <ProfileSwitcher />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {refreshMsg && (
          <span className="et-meta" style={{ color: 'var(--et-orange)', fontSize: 11 }}>{maskText(refreshMsg)}</span>
        )}
        <a href="#annual" title="年度总览 — 所有朋友 + 所有聊天" style={{
          padding: '5px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
          color: 'var(--et-orange-2)', background: 'var(--et-orange-soft)',
          textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>📅 年度</a>
        <a href="#graph" title="3D 关系网络" style={{
          padding: '5px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
          color: 'var(--et-orange-2)', background: 'var(--et-orange-soft)',
          textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>🌌 关系网</a>
        <a href="#reports" title="AI 关系档案" style={{
          padding: '5px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
          color: 'var(--et-orange-2)', background: 'var(--et-orange-soft)',
          textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>📑 报告</a>
        <a href="#table" title="信号表格（无需 AI）" style={{
          padding: '5px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
          color: 'var(--et-mute)', background: 'transparent',
          textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
          border: '0.5px solid var(--et-line-2)',
        }}>📊 表格</a>
        <TaskCenterBell onClick={onToggleTaskCenter} active={taskCenterActive} />
        <button onClick={onExtractKey} title="重新读取微信密钥，按引导操作" style={{
          all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
          color: 'var(--et-mute)', fontSize: 12, fontWeight: 500,
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M5 7a2 2 0 1 1 4 0v1H5V7zm-1 1V7a3 3 0 1 1 6 0v1h.5A1.5 1.5 0 0 1 12 9.5v2A1.5 1.5 0 0 1 10.5 13h-7A1.5 1.5 0 0 1 2 11.5v-2A1.5 1.5 0 0 1 3.5 8H4z" strokeLinecap="round" />
          </svg>
          密钥
        </button>
        <button onClick={onRefresh} disabled={refreshing} style={{
          all: 'unset', cursor: refreshing ? 'wait' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          color: refreshing ? 'var(--et-faint)' : 'var(--et-mute)', fontSize: 12, fontWeight: 500,
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"
            style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined}>
            <path d="M11.5 7a4.5 4.5 0 1 1-1.32-3.18M11 1v3.5h-3.5" strokeLinecap="round" />
          </svg>
          {refreshing ? '正在解密最新数据…' : '更新数据'}
        </button>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function HeroFrame({ summary, onOpen }: { summary: HomeSummary; onOpen: (id: string) => void }) {
  void usePrivacy();
  return (
    <div className="et-paper-grain" style={{
      position: 'relative', margin: '24px 28px 0', padding: '40px 44px 36px',
      background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r-lg)', boxShadow: 'var(--et-shadow-2)', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', inset: 14, border: '0.5px solid var(--et-line)', borderRadius: 14, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: 24, right: 30, transform: 'rotate(8deg)', opacity: 0.85 }}>
        <Postmark size={86} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Ribbon color="var(--et-orange)" tone="solid">2026 · 年代记</Ribbon>
        <div className="et-meta" style={{ color: 'var(--et-mute)' }}>Murmur · Vol. 01</div>
      </div>
      <div className="et-serif" style={{
        marginTop: 24, fontSize: 46, lineHeight: 1.22, fontWeight: 500,
        color: 'var(--et-ink)', maxWidth: 760, letterSpacing: '0.005em',
      }}>
        这些年，时间带你遇见了 <span style={{ color: 'var(--et-orange)', fontWeight: 600 }}>{summary.totalContacts}</span> 个人，<br/>
        其中 <span style={{ color: 'var(--et-orange)', fontWeight: 600 }}>{summary.closeFriends}</span> 位朋友，陪你走过了 <span style={{ color: 'var(--et-orange)', fontWeight: 600 }}>{summary.daysSinceFirst.toLocaleString()}</span> 天。
      </div>
      <div className="et-meta" style={{ marginTop: 16, fontSize: 13, color: 'var(--et-mute)', maxWidth: 560 }}>
        翻一翻今年最常聊的人，这是 Murmur 写给你的一封小信。
      </div>
      <div style={{
        marginTop: 32, display: 'grid',
        gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 14, position: 'relative',
      }}>
        {summary.topFriends.map((f, i) => (
          <div key={f.id} onClick={() => onOpen(f.id)} style={{
            position: 'relative', padding: '16px 14px 14px',
            background: i === 0 ? 'var(--et-orange-soft)' : 'transparent',
            border: `0.5px solid ${i === 0 ? 'rgba(224,83,46,0.25)' : 'var(--et-line)'}`,
            borderRadius: 'var(--et-r)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            textAlign: 'center', cursor: 'pointer',
          }}>
            <div style={{
              position: 'absolute', top: -9, left: '50%', transform: 'translateX(-50%)',
              background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)', borderRadius: 999,
              padding: '2px 10px', fontFamily: 'var(--et-serif)', fontSize: 11, fontWeight: 600,
              color: i === 0 ? 'var(--et-orange)' : 'var(--et-ink)',
            }}>No.{i + 1}</div>
            <Avatar friend={f} size={i === 0 ? 64 : 52} ring={i === 0} />
            <div className="et-serif" style={{ fontSize: 15, fontWeight: 600, color: 'var(--et-ink)', marginTop: 2 }}>{displayName(f.id, f.name)}</div>
            <div className="et-num" style={{ fontSize: 18, fontWeight: 600, color: i === 0 ? 'var(--et-orange)' : 'var(--et-ink)' }}>
              {f.count.toLocaleString()}<span style={{ fontSize: 10, fontWeight: 500, color: 'var(--et-mute)', marginLeft: 3, fontFamily: 'var(--et-sans)' }}>条</span>
            </div>
            <div className="et-meta" style={{ color: 'var(--et-mute)' }}>{f.last}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Timeline({ summary }: { summary: HomeSummary }) {
  return (
    <div style={{
      margin: '24px 28px 0', padding: '22px 26px 18px',
      background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div className="et-eyebrow">时光线 · 一年里你和谁说话最多</div>
          <div className="et-serif" style={{ fontSize: 18, fontWeight: 500, color: 'var(--et-ink)', marginTop: 6 }}>{summary.heat.peakLabel}最响，{summary.heat.troughLabel}最静。</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="et-meta">高峰 · {summary.heat.peakLabel} <span className="et-num" style={{ color: 'var(--et-orange)', fontWeight: 600 }}>{summary.heat.peakCount.toLocaleString()}</span> 条</span>
          <span className="et-meta">沉默 · {summary.heat.troughLabel} <span className="et-num" style={{ fontWeight: 600 }}>{summary.heat.troughCount.toLocaleString()}</span> 条</span>
        </div>
      </div>
      <Sparkline data={summary.heat.values} months={summary.heat.months} w={870} h={88} />
    </div>
  );
}

function FilterBar({
  tab, setTab, search, setSearch, count,
}: {
  tab: Tab; setTab: (s: Tab) => void;
  search: string; setSearch: (s: string) => void;
  count: number;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'private', label: '私聊朋友' },
    { id: 'group',   label: '群聊'     },
  ];
  return (
    <div style={{
      margin: '28px 28px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      paddingBottom: 14, borderBottom: '0.5px solid var(--et-line-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            all: 'unset', cursor: 'pointer',
            padding: '8px 14px', borderRadius: 999,
            fontFamily: 'var(--et-sans)', fontSize: 13, fontWeight: t.id === tab ? 600 : 500,
            color: t.id === tab ? 'var(--et-paper)' : 'var(--et-ink)',
            background: t.id === tab ? 'var(--et-ink)' : 'transparent',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>{t.label}</button>
        ))}
        <div style={{ width: 1, height: 18, background: 'var(--et-line-2)', margin: '0 6px' }} />
        <span className="et-meta" style={{ color: 'var(--et-mute)' }}>共 {count} 个 · 排序 · 总消息数 ↓</span>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 12px', border: '0.5px solid var(--et-line-2)', borderRadius: 999,
        background: 'var(--et-paper)', minWidth: 220,
      }}>
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="var(--et-mute)" strokeWidth="1.4">
          <circle cx="5.5" cy="5.5" r="4" /><path d="M8.5 8.5l3 3" strokeLinecap="round" />
        </svg>
        <input
          placeholder="搜索朋友（姓名 / 微信号 / 备注）"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            all: 'unset', flex: 1, fontFamily: 'var(--et-sans)', fontSize: 13, color: 'var(--et-ink)',
          }}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{
            all: 'unset', cursor: 'pointer', color: 'var(--et-mute)', fontSize: 14,
          }}>×</button>
        )}
      </div>
    </div>
  );
}

function isOnboardingNeededError(e: any): boolean {
  const text = String(e?.message || e || '').toLowerCase();
  return text.includes('no_decrypted_data') ||
    text.includes('onboarding_required') ||
    text.includes('needs_onboarding') ||
    text.includes('bootstrap mode');
}

export function HomePage({ dark = false, onOpenFriend, onOpenOnboarding }: Props) {
  void usePrivacy();
  const [tab, setTab] = useState<Tab>('private');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [allFriends, setAllFriends] = useState<Friend[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bootWaitSec, setBootWaitSec] = useState(0);
  const [bootLogs, setBootLogs] = useState<LogTailResponse | null>(null);
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
          // Last attempt — surface the error
          if (attempts >= 80) {
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
  }, []);

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
          setError(null);
        }
      })
      .catch(e => {
        if (!cancelled) setError(String(e.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoadingFriends(false);
      });
    return () => { cancelled = true; };
  }, [summary, tab, searchDebounced]);

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
      const failure = r.ok ? '' : summarizeRefreshFailure(r.details || '');
      const partial = r.ok && (r.details || '').includes('[WARN]');
      const successMsg = partial
        ? '已更新，但部分数据库未解密；可多打开聊天/朋友圈后重抓密钥'
        : `已更新 · ${(r.ms / 1000).toFixed(1)}s`;
      taskCenter.updateTask(taskId, {
        pct: 100, status: r.ok ? 'done' : 'error',
        sub: r.ok ? successMsg : failure,
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
      const failure = summarizeRefreshFailure(e?.message || String(e));
      taskCenter.updateTask(taskId, { status: 'error', pct: 100, sub: failure });
      setRefreshMsg(failure);
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(''), 6000);
    }
  }

  if (error && !summary) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16,
      }}>
        <div className="et-h2" style={{ color: 'var(--et-ink)' }}>
          {isOnboardingNeededError(error) ? '还没完成初始化' : '后端没起来'}
        </div>
        <div className="et-meta" style={{ color: 'var(--et-mute)', maxWidth: 520, textAlign: 'center' }}>
          {isOnboardingNeededError(error) ? (
            <>
              本地后端已经启动了，但还没有找到可用的解密数据。请按初始化引导选择微信数据目录、抓密钥并解密。
            </>
          ) : (
            <>
              Murmur 应该自动启动 etcli.exe 作为后端。如果没起，请：<br/>
              1. 完全退出 Murmur 重启<br/>
              2. 还不行就看日志 <code style={{ background: 'var(--et-paper-2)', padding: '2px 6px', borderRadius: 4 }}>~/Documents/Murmur/logs/serve.log</code><br/>
              3. 开发模式可手动跑 <code style={{ background: 'var(--et-paper-2)', padding: '2px 6px', borderRadius: 4 }}>{navigator.userAgent.toLowerCase().includes('mac') ? 'bash start-mac.sh' : 'start-windows.bat'}</code><br/>
              4. 把日志贴 issue 给作者 sgaofen
            </>
          )}
        </div>
        {isOnboardingNeededError(error) && onOpenOnboarding && (
          <button onClick={onOpenOnboarding} style={{
            all: 'unset', cursor: 'pointer', padding: '12px 28px',
            borderRadius: 999, background: 'var(--et-orange)', color: '#fff',
            fontSize: 14, fontWeight: 600, boxShadow: '0 6px 16px rgba(255,107,71,0.28)',
          }}>打开初始化引导</button>
        )}
        <div className="et-meta" style={{ color: 'var(--et-faint)' }}>{maskText(error)}</div>
        {bootLogs && (
          <details style={{ width: 'min(760px, 92vw)' }}>
            <summary className="et-meta" style={{ cursor: 'pointer', color: 'var(--et-orange)', textAlign: 'center' }}>
              查看启动诊断日志
            </summary>
            <div className="et-meta" style={{ color: 'var(--et-mute)', marginTop: 8, textAlign: 'center' }}>
              日志目录：{maskText(bootLogs.logs_dir)}
            </div>
            <pre style={{
              marginTop: 10,
              padding: 12,
              maxHeight: 260,
              overflow: 'auto',
              borderRadius: 8,
              border: '0.5px solid var(--et-line-2)',
              background: 'var(--et-paper-2)',
              color: 'var(--et-ink-soft)',
              fontSize: 11,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
            }}>{maskText([
              '--- serve.log ---',
              bootLogs.serve || '(empty)',
              '',
              '--- tauri-shell.log ---',
              bootLogs.tauri_shell || '(empty)',
            ].join('\n'))}</pre>
          </details>
        )}
      </div>
    );
  }

  if (!summary) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <div className="et-meta">正在启动本地服务…</div>
        <div className="et-meta" style={{ color: 'var(--et-faint)', fontSize: 11 }}>
          {bootWaitSec >= 8
            ? `首次打开时，本地后端正在启动；Windows 杀毒/Defender 扫描 etcli.exe 时可能要等 10-60 秒。已等待 ${bootWaitSec} 秒`
            : '正在连接 127.0.0.1:9100'}
        </div>
      </div>
    );
  }

  return (
    <div className={`et-root ${dark ? 'et-dark' : ''}`} style={{ background: 'var(--et-bg)', minHeight: '100%' }}>
      <HomeChromeBar onRefresh={handleRefresh} refreshing={refreshing} refreshMsg={refreshMsg}
        onExtractKey={() => setExtractOpen(true)}
        onToggleTaskCenter={() => setTaskCenterOpen(o => !o)}
        taskCenterActive={taskCenterOpen} />
      <HeroFrame summary={summary} onOpen={onOpenFriend} />
      <Timeline summary={summary} />
      <FilterBar tab={tab} setTab={setTab} search={search} setSearch={setSearch} count={allFriends.length} />
      <div style={{
        margin: '0 28px 36px', display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 14,
        opacity: loadingFriends ? 0.4 : 1, transition: 'opacity .2s ease',
      }}>
        {allFriends.length === 0 && !loadingFriends && (
          <div className="et-meta" style={{ gridColumn: 'span 4', textAlign: 'center', padding: 40, color: 'var(--et-mute)' }}>
            {searchDebounced ? `没找到 "${maskText(searchDebounced)}"` : '没有数据'}
          </div>
        )}
        {allFriends.map((f, i) => (
          <FriendCard key={f.id} friend={f} rank={i + 1} onClick={() => onOpenFriend(f.id)} />
        ))}
      </div>
      <div style={{ margin: '0 28px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="et-meta" style={{ color: 'var(--et-mute)' }}>
          全部数据均在你的电脑上 · 不会上传到任何云端
        </div>
        <div className="et-meta" style={{ fontFamily: 'var(--et-mono)', color: 'var(--et-faint)' }}>{APP_VERSION}</div>
      </div>
      <ExtractKeyDialog
        open={extractOpen}
        onClose={() => setExtractOpen(false)}
        onSuccess={() => { handleRefresh(); }}
      />
      {taskCenterOpen && <TaskCenterDrawer onClose={() => setTaskCenterOpen(false)} />}
    </div>
  );
}

function summarizeRefreshFailure(details: string): string {
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
