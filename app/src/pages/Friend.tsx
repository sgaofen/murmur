import { useEffect, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { MessageCard } from '../components/MessageCard';
import { RingChart } from '../components/RingChart';
import { Stamp } from '../components/Stamp';
import { getFriend, getMessages, getMoments, getReport, getFriendConnections } from '../data/api';
import type { FriendConnection } from '../data/api';
import type { Friend, FriendStats, Moment } from '../data/types';
import { AIExportDialog } from './AIExportDialog';
import { MediaGallery } from './extras/MediaGallery';
import { AgentReport } from './extras/AgentReport';
import { mdToHtml, MURMUR_MD_CSS } from '../utils/markdown';
import { displayName, maskedWxid } from '../utils/privacy';
import { usePrivacy } from '../components/PrivacyToggle';

interface Props {
  friendId: string;
  onBack: () => void;
  onOpenFriend?: (id: string) => void;
}

type FriendTab = 'story' | 'media' | 'chat';

function FriendChromeBar({ onBack, friend }: { onBack: () => void; friend: Friend }) {
  const name = displayName(friend.id, friend.name);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 28px', borderBottom: '0.5px solid var(--et-line)',
    }}>
      <button onClick={onBack} style={{
        all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
        color: 'var(--et-mute)', fontSize: 13, fontWeight: 500,
      }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 2L3 7l5 5" strokeLinecap="round" />
        </svg>
        回到年代记
      </button>
      <div className="et-serif" style={{ fontSize: 14, color: 'var(--et-mute)' }}>和 {name} 的故事</div>
      <span className="et-meta" style={{ fontFamily: 'var(--et-mono)', fontSize: 11, color: 'var(--et-faint)' }}>{maskedWxid(friend.id)}</span>
    </div>
  );
}

function PersonCard({ friend, stats }: { friend: Friend; stats: FriendStats | null }) {
  const name = displayName(friend.id, friend.name);
  const summarySentence = stats
    ? `${friend.bond} · 跨度 ${stats.spanDays} 天，${friend.count.toLocaleString()} 条消息。`
    : `${friend.bond} · ${friend.count.toLocaleString()} 条消息。`;
  return (
    <div className="et-paper-grain" style={{
      position: 'relative', padding: '28px 30px', display: 'grid',
      gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'center',
      background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r-lg)', boxShadow: 'var(--et-shadow-2)', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 18, right: 22, transform: 'rotate(-6deg)', opacity: 0.85 }}>
        <Stamp size={62} />
      </div>
      <div style={{ position: 'relative' }}>
        <Avatar friend={friend} size={108} />
        <span className={`et-chip ${friend.tagKind}`} style={{ position: 'absolute', bottom: -8, left: '50%', transform: 'translateX(-50%)' }}>{friend.tag}</span>
      </div>
      <div>
        <div className="et-eyebrow">人物档案</div>
        <div className="et-h1" style={{ marginTop: 8, color: 'var(--et-ink)' }}>{name}</div>
        <div className="et-meta" style={{ marginTop: 6, color: 'var(--et-mute)' }}>{friend.knew} · 最近活跃 {friend.last}</div>
        <div className="et-serif" style={{
          marginTop: 18, fontSize: 17, lineHeight: 1.65, color: 'var(--et-ink-soft)',
          paddingLeft: 14, borderLeft: '2.5px solid var(--et-orange)',
          maxWidth: 540, fontStyle: 'italic',
        }}>
          「{summarySentence}」
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, sub, big = false }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <div style={{
      flex: 1, padding: '16px 18px', background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
      display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
    }}>
      <div className="et-eyebrow" style={{ fontSize: 10 }}>{label}</div>
      <div className="et-num" style={{ fontSize: big ? 28 : 22, fontWeight: 600, color: 'var(--et-ink)', lineHeight: 1.1 }}>{value}</div>
      {sub && <div className="et-meta" style={{ color: 'var(--et-mute)' }}>{sub}</div>}
    </div>
  );
}

function Bar({ label, pct, count, color }: { label: string; pct: number; count: number; color: string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: 'var(--et-ink)', fontWeight: 500 }}>{label}</span>
        <span className="et-num" style={{ fontSize: 13, color: 'var(--et-mute)' }}>{count.toLocaleString()} 条 · {pct}%</span>
      </div>
      <div style={{ height: 6, background: 'rgba(26,43,74,0.08)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 999 }} />
      </div>
    </div>
  );
}

function RhythmCard({ friend, stats }: { friend: Friend; stats: FriendStats }) {
  return (
    <div style={{
      padding: '24px 26px', background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
    }}>
      <div className="et-eyebrow">互动节奏</div>
      <div className="et-h2" style={{ marginTop: 6, color: 'var(--et-ink)' }}>谁更主动？</div>
      <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'center' }}>
        <RingChart you={stats.selfPct} size={150} label={stats.selfPct >= 50 ? '你说得更多' : '对方说得更多'} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Bar label="你" pct={stats.selfPct} count={stats.totalSelf} color="var(--et-orange)" />
          <Bar label={displayName(friend.id, friend.name)} pct={100 - stats.selfPct} count={stats.totalOther} color="var(--et-ink)" />
          <div style={{ height: 1, background: 'var(--et-line)', margin: '4px 0' }} />
          <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--et-mute)' }}>
            <span>主动开聊 · 你 <b className="et-num" style={{ color: 'var(--et-ink)' }}>{stats.initSelf}</b> 次</span>
            <span>· {displayName(friend.id, friend.name)} <b className="et-num" style={{ color: 'var(--et-ink)' }}>{stats.initOther}</b> 次</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--et-mute)' }}>1 分钟内秒回 · <b className="et-num" style={{ color: 'var(--et-orange)' }}>{stats.fastReplies}</b> 次</div>
        </div>
      </div>
      <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
        <StatTile label="最常聊天时段" value={stats.busiestHourLabel} sub={stats.busiestHourSub} />
        <StatTile label="深夜比例" value={`${stats.lateNightPct}%`} sub="23—4 时占总消息" />
        <StatTile label="中位回复" value={stats.medianReplyHuman} sub="你的中位回复时长" />
      </div>
    </div>
  );
}

function MomentsCard({ moments, loading }: { moments: Moment[]; loading: boolean }) {
  return (
    <div style={{
      padding: '24px 26px', background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div className="et-eyebrow">难忘瞬间 · 自动挑选</div>
          <div className="et-h2" style={{ marginTop: 6, color: 'var(--et-ink)' }}>那些值得回头看的话。</div>
        </div>
      </div>
      <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {loading && <div className="et-meta" style={{ gridColumn: 'span 2', textAlign: 'center', padding: 20 }}>加载中…</div>}
        {!loading && moments.length === 0 && <div className="et-meta" style={{ gridColumn: 'span 2', textAlign: 'center', padding: 20 }}>没有抓到合适的样本</div>}
        {moments.map((m, i) => (
          <MessageCard key={i} from={m.from} date={m.date} text={m.text} accent={i % 2 ? 'var(--et-ink)' : 'var(--et-orange)'} />
        ))}
      </div>
    </div>
  );
}

function SignalsEvidenceCard({ friend }: { friend: Friend & { relationship_signals?: any } }) {
  const sig = friend.relationship_signals;
  if (!sig) return null;
  const notes: string[] = sig.signature_notes || [];
  const numCells: Array<[string, any, string]> = [
    ['持续年', sig.longevity_years, '年'],
    ['线下证据', sig.offline_evidence?.count, '条'],
    ['脆弱表达', (sig.vulnerability?.self_disclose_count || 0) + (sig.vulnerability?.other_disclose_count || 0), '条'],
    ['通话', sig.calls, '次'],
    ['道歉/和解', sig.conflict_recovery?.apology_count, '次'],
    ['人生节点', sig.lifecycle?.count, '次'],
    ['朋友圈他赞你', sig.moments_back, '次'],
    ['朋友圈你赞他', sig.moments_out, '次'],
  ];
  if (notes.length === 0 && numCells.every(([, v]) => !v)) return null;
  return (
    <div style={{
      padding: '20px 24px', background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
    }}>
      <div className="et-eyebrow">离线证据 · 不靠 AI 也能看的硬信号</div>
      <div className="et-h2" style={{ marginTop: 6, color: 'var(--et-ink)' }}>
        关系层级 {sig.tier || '—'} <span style={{ fontSize: 13, color: 'var(--et-mute)', fontWeight: 400 }}>· {sig.tier_label || ''}</span>
      </div>
      <div style={{
        marginTop: 14, display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
      }}>
        {numCells.map(([label, val, unit]) => (
          <div key={label} style={{
            padding: '10px 12px', background: 'var(--et-paper-2)',
            border: '0.5px solid var(--et-line-2)', borderRadius: 8,
          }}>
            <div className="et-eyebrow" style={{ fontSize: 9 }}>{label}</div>
            <div className="et-num" style={{ fontSize: 18, fontWeight: 600, marginTop: 2,
              color: (val || 0) > 0 ? 'var(--et-ink)' : 'var(--et-faint)' }}>
              {val || 0}<span style={{ fontSize: 11, color: 'var(--et-mute)', marginLeft: 3 }}>{unit}</span>
            </div>
          </div>
        ))}
      </div>
      {notes.length > 0 && (
        <ul style={{ marginTop: 14, padding: '12px 18px', background: 'var(--et-orange-soft)',
          border: '0.5px solid var(--et-orange-2)', borderRadius: 8, listStyle: 'none' }}>
          {notes.map((n, i) => (
            <li key={i} className="et-serif" style={{ padding: '4px 0', fontSize: 14,
              color: 'var(--et-ink-soft)', lineHeight: 1.6 }}>
              <span style={{ color: 'var(--et-orange)', marginRight: 6 }}>▸</span>{n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectionsCard({ friend, onOpen }: {
  friend: Friend; onOpen: (peerWxid: string) => void;
}) {
  const [conns, setConns] = useState<FriendConnection[] | null>(null);
  useEffect(() => {
    getFriendConnections(friend.id).then(r => setConns(r.connections)).catch(() => setConns([]));
  }, [friend.id]);
  if (!conns) return (
    <div style={{ padding: 16, color: 'var(--et-mute)' }} className="et-meta">关联朋友加载中…</div>
  );
  if (conns.length === 0) return null;
  const top = conns.slice(0, 12);
  return (
    <div style={{
      padding: '20px 24px', background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
    }}>
      <div className="et-eyebrow">关联朋友 · {displayName(friend.id, friend.name)} 在你的社交圈里</div>
      <div className="et-h2" style={{ marginTop: 6, color: 'var(--et-ink)' }}>他认识的你的朋友（点击查看）</div>
      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
        {top.map(c => (
          <button key={c.wxid + c.edge_type} onClick={() => onOpen(c.wxid)} style={{
            all: 'unset', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', borderRadius: 10,
            background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--et-orange-soft)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'var(--et-paper-2)'}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--et-ink)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{c.name}</span>
            <span style={{ fontSize: 10, color: 'var(--et-mute)' }}>
              {c.edge_type === 'mutual_reply' ? `群里互动 ${c.weight}` :
               c.edge_type === 'mention' ? `提及 ${c.mention_count ?? '—'}` :
               c.edge_type === 'moments_cross' ? `朋友圈 ${c.moments_cross ?? '—'}` :
               c.edge_type === 'co_group' ? `共群 ${c.shared_group_count ?? c.weight}` :
               `${c.weight}`}
            </span>
          </button>
        ))}
      </div>
      {conns.length > 12 && (
        <div className="et-meta" style={{ marginTop: 10, color: 'var(--et-faint)' }}>
          还有 {conns.length - 12} 条更弱的连线 …
        </div>
      )}
    </div>
  );
}

function AIReportCard({ friend, onView, onRerun }: {
  friend: Friend;
  onView: () => void;
  onRerun: () => void;
}) {
  if (!friend.aiReport?.available) return null;
  const r = friend.aiReport;
  // Trim "# {name} 关系档案" / "> ..." / "---" frontmatter from short for cleaner preview
  let preview = r.short
    .replace(/^#[^\n]*\n+/, '')
    .replace(/^>[^\n]*\n+/gm, '')
    .replace(/^---+\n+/m, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim();
  if (preview.length > 380) preview = preview.slice(0, 380).replace(/\s+\S*$/, '') + '…';
  const ageMs = Date.now() - r.mtime * 1000;
  const ageDays = Math.floor(ageMs / 86400000);
  const ageStr = ageDays < 1 ? '今天' : ageDays === 1 ? '昨天' : `${ageDays} 天前`;
  return (
    <div className="et-paper-grain" style={{
      position: 'relative', padding: '22px 26px',
      background: 'var(--et-paper)', border: '0.5px solid var(--et-orange-2)',
      borderRadius: 'var(--et-r)', boxShadow: 'var(--et-shadow-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{
          padding: '3px 10px', borderRadius: 999, fontSize: 10, fontWeight: 600,
          background: 'var(--et-orange)', color: '#fff', letterSpacing: 0.5,
        }}>AI 已分析</span>
        <span className="et-meta" style={{ color: 'var(--et-mute)', fontSize: 11 }}>
          {ageStr} · {(r.size / 1024).toFixed(1)} KB
        </span>
      </div>
      <div className="et-h2" style={{ color: 'var(--et-ink)' }}>关于 {displayName(friend.id, friend.name)} —— AI 摘要</div>
      <div className="et-serif" style={{
        marginTop: 12, fontSize: 14.5, lineHeight: 1.78, color: 'var(--et-ink-soft)',
        whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'hidden',
        position: 'relative',
      }}>
        {preview}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 60,
          background: 'linear-gradient(to bottom, transparent, var(--et-paper))',
          pointerEvents: 'none',
        }} />
      </div>
      <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <button onClick={onView} style={{
          all: 'unset', cursor: 'pointer',
          padding: '8px 18px', borderRadius: 8,
          background: 'var(--et-ink)', color: 'var(--et-paper)',
          fontSize: 13, fontWeight: 600,
        }}>📖 阅读完整报告</button>
        <button onClick={onRerun} style={{
          all: 'unset', cursor: 'pointer',
          padding: '8px 18px', borderRadius: 8,
          background: 'transparent', color: 'var(--et-mute)',
          border: '0.5px solid var(--et-line-2)',
          fontSize: 13, fontWeight: 500,
        }}>↻ 重新分析</button>
      </div>
    </div>
  );
}

function ReportViewerOverlay({ relPath, friendName, onClose }: {
  relPath: string;
  friendName: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getReport(relPath)
      .then(r => { if (!cancelled) setContent(r.content); })
      .catch(e => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, [relPath]);
  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 30,
      background: 'rgba(20,24,42,0.55)',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      paddingTop: 40, paddingBottom: 40, overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '88%', maxWidth: 920,
        background: 'var(--et-paper)',
        border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r-lg)',
        boxShadow: 'var(--et-shadow-3)',
        padding: '32px 44px', position: 'relative',
      }}>
        <button onClick={onClose} style={{
          all: 'unset', cursor: 'pointer', position: 'absolute', top: 14, right: 18,
          fontSize: 22, color: 'var(--et-mute)', lineHeight: 1, padding: 6,
        }}>×</button>
        <div className="et-eyebrow">AI 关系档案</div>
        <div style={{ fontFamily: 'var(--et-serif)', fontSize: 13, color: 'var(--et-mute)', marginTop: 4 }}>
          关于 {friendName}
        </div>
        {error && <div style={{ marginTop: 24, color: 'var(--et-rose)' }}>加载失败：{error}</div>}
        {!content && !error && <div className="et-meta" style={{ marginTop: 24 }}>加载中…</div>}
        {content && (
          <article
            className="murmur-md"
            style={{
              marginTop: 18, fontFamily: 'var(--et-sans)',
              fontSize: 15, lineHeight: 1.78, color: 'var(--et-ink)',
            }}
            dangerouslySetInnerHTML={{ __html: mdToHtml(content) }}
          />
        )}
      </div>
      <style>{MURMUR_MD_CSS}</style>
    </div>
  );
}

function ActionDock({ onExportAI, onShowMessages, onExportChat, onOpenYearbook }: {
  onExportAI: () => void;
  onShowMessages: () => void;
  onExportChat: () => void;
  onOpenYearbook: () => void;
}) {
  const Btn = ({ icon, label, sub, primary, disabled, onClick }: {
    icon: string; label: string; sub: string; primary?: boolean; disabled?: boolean; onClick?: () => void;
  }) => (
    <button onClick={onClick} disabled={disabled} style={{
      all: 'unset', cursor: disabled ? 'not-allowed' : 'pointer',
      flex: 1, padding: '14px 18px',
      background: primary ? 'var(--et-ink)' : 'var(--et-paper)',
      color: primary ? 'var(--et-paper)' : 'var(--et-ink)',
      border: primary ? 'none' : '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r)',
      display: 'flex', alignItems: 'center', gap: 12,
      opacity: disabled ? 0.45 : 1,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8,
        background: primary ? 'var(--et-orange)' : 'var(--et-orange-soft)',
        color: primary ? '#fff' : 'var(--et-orange-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0,
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, opacity: primary ? 0.7 : 1, color: primary ? 'var(--et-paper)' : 'var(--et-mute)', marginTop: 2 }}>{sub}</div>
      </div>
    </button>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
      <Btn icon="📖" label="完整聊天记录" sub="按时间倒序浏览" onClick={onShowMessages} />
      <Btn icon="📤" label="导出聊天 .json" sub="本地文件" onClick={onExportChat} />
      <Btn icon="💑" label="双人年代记" sub="按年份的故事时间线" onClick={onOpenYearbook} />
      <Btn icon="🤖" label="导出 AI 分析包" sub="一键打包给 AI 看" primary onClick={onExportAI} />
    </div>
  );
}

function MessagesDrawer({ open, friend, onClose }: { open: boolean; friend: Friend; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Awaited<ReturnType<typeof getMessages>> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getMessages(friend.id, { limit: 500 })
      .then(setMsgs)
      .finally(() => setLoading(false));
  }, [open, friend.id]);

  if (!open) return null;

  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 20,
      background: 'rgba(20,24,42,0.45)',
      display: 'flex', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 540, maxWidth: '92%',
        background: 'var(--et-paper)',
        boxShadow: 'var(--et-shadow-3)',
        height: '100%', overflow: 'auto',
        padding: '20px 24px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div className="et-eyebrow">完整聊天记录</div>
            <div className="et-h2" style={{ marginTop: 4, color: 'var(--et-ink)' }}>和 {displayName(friend.id, friend.name)} 的对话</div>
          </div>
          <button onClick={onClose} style={{ all: 'unset', cursor: 'pointer', padding: 8, color: 'var(--et-mute)' }}>×</button>
        </div>
        {loading && <div className="et-meta" style={{ textAlign: 'center', padding: 40 }}>加载中…</div>}
        {!loading && msgs && (
          <>
            <div className="et-meta" style={{ marginBottom: 12, color: 'var(--et-mute)' }}>
              显示最早 {msgs.length} 条 · 共 {friend.count.toLocaleString()} 条
              {friend.isGroup && (
                <span style={{ marginLeft: 8, color: 'var(--et-faint)', fontSize: 10 }}>
                  · 群里同一个 wxid 永远是同一个人，改名也不会被算成两个人
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {msgs.map((m, i) => {
                const isSelf = m.from_id === 'self';
                // For groups, color-code distinct senders consistently by hashing wxid → hue.
                const hue = friend.isGroup && !isSelf
                  ? Array.from(m.from_id).reduce((a, c) => a + c.charCodeAt(0), 0) % 360
                  : null;
                const labelColor = hue != null
                  ? `hsl(${hue}, 38%, 38%)`
                  : 'var(--et-faint)';
                return (
                  <div key={i} style={{
                    display: 'flex', flexDirection: 'column',
                    alignItems: isSelf ? 'flex-end' : 'flex-start',
                  }}>
                    <div className="et-meta" style={{ fontSize: 10, color: labelColor, marginBottom: 2 }}>
                      <strong>{m.from}</strong>
                      {friend.isGroup && !isSelf && (
                        <span style={{ opacity: 0.55, marginLeft: 4, fontFamily: 'var(--et-mono)' }}>
                          ~{m.from_id.slice(-6)}
                        </span>
                      )}
                      <span style={{ marginLeft: 6, opacity: 0.7 }}>{m.time.slice(5, 16).replace('T', ' ')}</span>
                    </div>
                    <div style={{
                      maxWidth: '78%',
                      padding: '8px 12px',
                      background: isSelf ? 'var(--et-orange-soft)' : 'var(--et-paper-2)',
                      border: '0.5px solid var(--et-line-2)',
                      borderRadius: 12,
                      fontSize: 13, color: 'var(--et-ink)',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>{m.text}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function downloadAsFile(filename: string, content: string, mime: string = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

export function FriendPage({ friendId, onBack, onOpenFriend }: Props) {
  void usePrivacy();
  const [friend, setFriend] = useState<Friend | null>(null);
  const [stats, setStats] = useState<FriendStats | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [momentsLoading, setMomentsLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<FriendTab>('story');
  const [agentInvoke, setAgentInvoke] = useState<string | null>(null);  // 'claude' | 'codex' etc, null = idle
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    setError(null);
    setStats(null);
    getFriend(friendId)
      .then(d => { setFriend(d); setStats(d.stats); })
      .catch(e => setError(e?.message || String(e)));
    setMomentsLoading(true);
    getMoments(friendId)
      .then(setMoments)
      .catch(() => {})
      .finally(() => setMomentsLoading(false));
  }, [friendId]);

  async function handleExportChat() {
    if (!friend) return;
    try {
      const msgs = await getMessages(friendId, { limit: 5000 });
      downloadAsFile(`${friend.name}_chat.json`, JSON.stringify(msgs, null, 2));
    } catch (e: any) {
      alert('导出失败：' + (e?.message || e));
    }
  }

  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)' }}>← 返回</button>
        <div style={{ marginTop: 20, color: 'var(--et-rose)' }}>加载失败：{error}</div>
      </div>
    );
  }
  if (!friend) {
    return <div style={{ padding: 40 }}><div className="et-meta">加载中…</div></div>;
  }

  // If user invoked an agent, show the report page instead of the regular friend layout
  if (agentInvoke) {
    return <AgentReport friend={friend} cli={agentInvoke} onClose={() => {
      setAgentInvoke(null);
      // Re-fetch friend so the freshly-saved aiReport surfaces in the summary card
      getFriend(friendId).then(d => { setFriend(d); setStats(d.stats); }).catch(() => {});
    }} />;
  }

  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100%', position: 'relative' }}>
      <FriendChromeBar onBack={onBack} friend={friend} />
      <FriendTabs tab={tab} setTab={setTab} />
      {tab === 'media' && <MediaGallery friend={friend} />}
      {tab === 'chat' && <ChatTabRedirect onOpen={() => setDrawerOpen(true)} friend={friend} />}
      {tab === 'story' && (
      <div style={{ padding: '24px 28px 32px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1180, margin: '0 auto' }}>
        <PersonCard friend={friend} stats={stats} />
        <AIReportCard friend={friend}
          onView={() => setReportOpen(true)}
          onRerun={() => setExportOpen(true)} />
        <SignalsEvidenceCard friend={friend as any} />
        <ConnectionsCard friend={friend} onOpen={(id) => onOpenFriend?.(id)} />
        {stats ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              <StatTile label="总消息" value={(stats.totalSelf + stats.totalOther).toLocaleString()} sub="含图文/语音" big />
              <StatTile label="时间跨度" value={`${stats.spanDays} 天`} sub="第一次 → 最近一次" />
              <StatTile label="最长沉默" value={`${stats.longestSilenceDays} 天`} sub={`${stats.longestSilenceFrom} 起`} />
              <StatTile label="高频词" value={`「${stats.topPhrase}」`} sub={`共出现 ${stats.topPhraseCount} 次`} />
            </div>
            <RhythmCard friend={friend} stats={stats} />
          </>
        ) : (
          <div className="et-meta" style={{ color: 'var(--et-mute)', textAlign: 'center', padding: 20 }}>这位朋友消息太少，没有可分析的统计。</div>
        )}
        <MomentsCard moments={moments} loading={momentsLoading} />
        <ActionDock
          onExportAI={() => setExportOpen(true)}
          onShowMessages={() => setDrawerOpen(true)}
          onExportChat={handleExportChat}
          onOpenYearbook={() => { window.location.hash = `#yearbook/${friendId}`; }}
        />
        <div className="et-meta" style={{ textAlign: 'center', color: 'var(--et-faint)', marginTop: 8 }}>
          — 这一页只你看得见。Murmur 不会把任何内容上传到云端。 —
        </div>
      </div>
      )}
      <AIExportDialog open={exportOpen} onClose={() => setExportOpen(false)} friend={friend}
                       onLocalAgent={(cli) => { setExportOpen(false); setAgentInvoke(cli); }} />
      <MessagesDrawer open={drawerOpen} friend={friend} onClose={() => setDrawerOpen(false)} />
      {reportOpen && friend.aiReport && (
        <ReportViewerOverlay
          relPath={friend.aiReport.path}
          friendName={displayName(friend.id, friend.name)}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}

function FriendTabs({ tab, setTab }: { tab: FriendTab; setTab: (t: FriendTab) => void }) {
  const tabs: { id: FriendTab; label: string }[] = [
    { id: 'story', label: '故事' },
    { id: 'media', label: '相册' },
    { id: 'chat', label: '完整对话' },
  ];
  return (
    <div style={{ padding: '4px 28px 0', display: 'flex', gap: 4, borderBottom: '0.5px solid var(--et-line-2)' }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{
          all: 'unset', cursor: 'pointer',
          padding: '10px 18px', borderRadius: '10px 10px 0 0',
          fontFamily: 'var(--et-serif)', fontSize: 14, fontWeight: t.id === tab ? 600 : 500,
          color: t.id === tab ? 'var(--et-ink)' : 'var(--et-mute)',
          background: t.id === tab ? 'var(--et-paper)' : 'transparent',
          borderBottom: t.id === tab ? '2px solid var(--et-orange)' : '2px solid transparent',
          marginBottom: -1,
        }}>{t.label}</button>
      ))}
    </div>
  );
}

function ChatTabRedirect({ onOpen, friend }: { onOpen: () => void; friend: Friend }) {
  useEffect(() => { onOpen(); }, [onOpen]);
  return (
    <div style={{ padding: 60, textAlign: 'center' }}>
      <div className="et-meta">
        和 {displayName(friend.id, friend.name)} 的完整对话已在右侧抽屉打开。
      </div>
      <button onClick={onOpen} style={{
        all: 'unset', marginTop: 14, cursor: 'pointer',
        padding: '8px 16px', borderRadius: 8,
        background: 'var(--et-orange)', color: '#fff', fontSize: 13, fontWeight: 600,
      }}>再打开一次</button>
    </div>
  );
}
