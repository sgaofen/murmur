import { useEffect, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { MessageCard } from '../components/MessageCard';
import { RingChart } from '../components/RingChart';
import { Stamp } from '../components/Stamp';
import { errorCode, getFriend, getMoments, getReport, getFriendConnections, getInvokeStream, exportFriendChat, openFolder } from '../data/api';
import type { FriendConnection, ExportFormat, ExportReport, MediaPolicy } from '../data/api';
import type { Friend, FriendStats, Moment } from '../data/types';
import { AIAssistantDrawer, ReportReadyBanner } from './AIAssistantDrawer';
import { MediaGallery } from './extras/MediaGallery';
import { RelationshipReportView } from './extras/RelationshipReportView';
import { PairAnalysisPanel } from './extras/PairAnalysisPanel';
import { mdToHtml, MURMUR_MD_CSS } from '../utils/markdown';
import { displayName, maskedWxid, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { PageHeader } from '../shell/PageHeader';
import { Button, EmptyState, ErrorState, Skeleton, SkeletonText, cx } from '../ui';
import { IconClose, IconInbox, IconRefresh } from '../ui/icons';
import { lookupError } from '../data/errorCatalog';
import { useActivePlatform } from '../utils/activeProfile';
import './Friend.css';

interface Props {
  friendId: string;
  onBack: () => void;
  onOpenFriend?: (id: string) => void;
}

type FriendTab = 'story' | 'media' | 'chat';

function FriendChromeBar({ onBack, friend }: { onBack: () => void; friend: Friend }) {
  const name = displayName(friend.id, friend.name);
  return (
    <PageHeader
      back={{ label: '年代记', onClick: onBack }}
      title={`和 ${name} 的故事`}
      subtitle={<span className="et-mono">{maskedWxid(friend.id)}</span>}
    />
  );
}

function PersonCard({ friend, stats }: { friend: Friend; stats: FriendStats | null }) {
  const name = displayName(friend.id, friend.name);
  const summarySentence = stats
    ? `${friend.bond} · 跨度 ${stats.spanDays} 天，${friend.count.toLocaleString()} 条消息。`
    : `${friend.bond} · ${friend.count.toLocaleString()} 条消息。`;
  return (
    <section className="friend-person et-paper-grain" aria-label="人物档案">
      <div className="friend-person__stamp" aria-hidden="true">
        <Stamp size={62} />
      </div>
      <div className="friend-person__avatar">
        <Avatar friend={friend} size={108} />
        <span className={`et-chip ${friend.tagKind} friend-person__tag`}>{friend.tag}</span>
      </div>
      <div className="friend-person__text">
        <div className="et-eyebrow">人物档案</div>
        <h2 className="et-h1 friend-person__name">{name}</h2>
        <div className="et-meta friend-person__meta">{friend.knew} · 最近活跃 {friend.last}</div>
        <div className="friend-person__quote">
          「{maskText(summarySentence)}」
        </div>
      </div>
    </section>
  );
}

function StatTile({ label, value, sub, big = false }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <div className={cx('friend-stat', big && 'friend-stat--big')}>
      <div className="et-eyebrow friend-stat__label">{label}</div>
      <div className="et-num friend-stat__value">{value}</div>
      {sub && <div className="et-meta friend-stat__sub">{sub}</div>}
    </div>
  );
}

function Bar({ label, pct, count, color }: { label: string; pct: number; count: number; color: string }) {
  return (
    <div>
      <div className="friend-bar__head">
        <span className="friend-bar__label">{label}</span>
        <span className="et-num friend-bar__count">{count.toLocaleString()} 条 · {pct}%</span>
      </div>
      <div className="friend-bar__track">
        <div className="friend-bar__fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function RhythmCard({ friend, stats }: { friend: Friend; stats: FriendStats }) {
  return (
    <section className="friend-card">
      <div className="et-eyebrow">互动节奏</div>
      <h3 className="et-h2 friend-card__title">谁更主动？</h3>
      <div className="friend-rhythm__body">
        <div className="friend-rhythm__ring">
          <RingChart you={stats.selfPct} size={150} label={stats.selfPct >= 50 ? '你说得更多' : '对方说得更多'} />
        </div>
        <div className="friend-rhythm__bars">
          <Bar label="你" pct={stats.selfPct} count={stats.totalSelf} color="var(--accent)" />
          <Bar label={displayName(friend.id, friend.name)} pct={100 - stats.selfPct} count={stats.totalOther} color="var(--surface-inverse)" />
          <div className="friend-rhythm__rule" />
          <div className="friend-rhythm__facts">
            <span>主动开聊 · 你 <b className="et-num">{stats.initSelf}</b> 次</span>
            <span>· {displayName(friend.id, friend.name)} <b className="et-num">{stats.initOther}</b> 次</span>
          </div>
          <div className="friend-rhythm__facts">
            <span>1 分钟内秒回 · <b className="et-num is-accent">{stats.fastReplies}</b> 次</span>
          </div>
        </div>
      </div>
      <div className="friend-rhythm__tiles">
        <StatTile label="最常聊天时段" value={stats.busiestHourLabel} sub={stats.busiestHourSub} />
        <StatTile label="深夜比例" value={`${stats.lateNightPct}%`} sub="23—4 时占总消息" />
        <StatTile label="中位回复" value={stats.medianReplyHuman} sub="你的中位回复时长" />
      </div>
    </section>
  );
}

function MomentsCard({ moments, loading }: { moments: Moment[]; loading: boolean }) {
  void usePrivacy();
  return (
    <section className="friend-card">
      <div className="et-eyebrow">难忘瞬间 · 自动挑选</div>
      <h3 className="et-h2 friend-card__title">那些值得回头看的话。</h3>
      {!loading && moments.length === 0 ? (
        <EmptyState
          icon={<IconInbox size={22} />}
          title="还没挑出值得回看的话"
          description="聊天再多一些、再走心一些，这里就会出现你们的金句。"
        />
      ) : (
        <div className="friend-moments__grid" aria-busy={loading || undefined}>
          {loading && Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="friend-skel-msg" aria-hidden="true">
              <div className="friend-skel-msg__row"><Skeleton width="30%" height={12} /><Skeleton width={70} height={11} /></div>
              <SkeletonText lines={2} lastLineWidth="70%" />
            </div>
          ))}
          {!loading && moments.map((m, i) => (
            <MessageCard
              key={i}
              from={displayName(m.from_id, m.from)}
              date={m.date}
              text={maskText(m.text)}
              accent={i % 2 ? 'var(--surface-inverse)' : 'var(--accent)'}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SignalsEvidenceCard({ friend }: { friend: Friend & { relationship_signals?: any } }) {
  // QQ has no 朋友圈 equivalent in the local DB (QQ Zone lives in Tencent's
  // cloud, not nt_msg.db) — drop those two cells in QQ mode so we don't
  // render a bogus "0 次" stat. The hook runs before any early return so the
  // hook order stays the same when signals appear after a refresh.
  const platform = useActivePlatform();
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
  ];
  if (platform !== 'qq') {
    numCells.push(
      ['朋友圈他赞你', sig.moments_back, '次'],
      ['朋友圈你赞他', sig.moments_out, '次'],
    );
  }
  if (notes.length === 0 && numCells.every(([, v]) => !v)) return null;
  return (
    <section className="friend-card friend-card--tight">
      <div className="et-eyebrow">离线证据 · 不靠 AI 也能看的硬信号</div>
      <h3 className="et-h2 friend-card__title">
        关系层级 {sig.tier || '—'} <small>· {maskText(sig.tier_label || '')}</small>
      </h3>
      <div className="friend-signals__grid">
        {numCells.map(([label, val, unit]) => (
          <div key={label} className="friend-signal">
            <div className="et-eyebrow friend-signal__label">{label}</div>
            <div className={cx('et-num friend-signal__value', !((val || 0) > 0) && 'is-zero')}>
              {val || 0}<span className="friend-signal__unit">{unit}</span>
            </div>
          </div>
        ))}
      </div>
      {notes.length > 0 && (
        <ul className="friend-signals__notes">
          {notes.map((n, i) => <li key={i}>{maskText(n)}</li>)}
        </ul>
      )}
    </section>
  );
}

function ConnectionsCard({ friend, onOpen }: {
  friend: Friend; onOpen: (peerWxid: string) => void;
}) {
  void usePrivacy();
  const [conns, setConns] = useState<FriendConnection[] | null>(null);
  // Selected pair partner to show the PairAnalysisPanel modal for. Click the
  // small "📤" chip per row → modal with three-format download buttons. This
  // is the only easily-discoverable entry point to the pair-export feature
  // outside the 3D Graph; users were missing it.
  const [exportPeer, setExportPeer] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    getFriendConnections(friend.id).then(r => setConns(r.connections)).catch(() => setConns([]));
  }, [friend.id]);
  if (!conns) return (
    <section className="friend-card friend-card--tight" aria-busy="true" aria-label="正在加载关联朋友">
      <Skeleton width={220} height={11} />
      <div className="friend-conns__skel">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={40} radius={10} />)}
      </div>
    </section>
  );
  if (conns.length === 0) return null;
  const top = conns.slice(0, 12);
  return (
    <section className="friend-card friend-card--tight">
      <div className="et-eyebrow">关联朋友 · {displayName(friend.id, friend.name)} 在你的社交圈里</div>
      <h3 className="et-h2 friend-card__title">他认识的你的朋友（点击看人 · 📤 导出这对）</h3>
      <div className="friend-conns__grid">
        {top.map(c => (
          <div key={c.wxid + c.edge_type} className="friend-conn">
            <button type="button" className="friend-conn__open" onClick={() => onOpen(c.wxid)}>
              <span className="friend-conn__name">
                {displayName(c.wxid, c.name)}
              </span>
              <span className="friend-conn__weight">
                {c.edge_type === 'mutual_reply' ? `群里互动 ${c.weight}` :
                 c.edge_type === 'mention' ? `提及 ${c.mention_count ?? '—'}` :
                 c.edge_type === 'moments_cross' ? `朋友圈 ${c.moments_cross ?? '—'}` :
                 c.edge_type === 'co_group' ? `共群 ${c.shared_group_count ?? c.weight}` :
                 `${c.weight}`}
              </span>
            </button>
            <button
              type="button"
              className="friend-conn__export"
              onClick={(e) => {
                e.stopPropagation();
                setExportPeer({ id: c.wxid, name: c.name });
              }}
              title={`导出 ${displayName(friend.id, friend.name)} ↔ ${displayName(c.wxid, c.name)} 的关系档案`}
              aria-label={`导出 ${displayName(friend.id, friend.name)} 和 ${displayName(c.wxid, c.name)} 的关系档案`}>
              📤
            </button>
          </div>
        ))}
      </div>
      {conns.length > 12 && (
        <div className="et-meta friend-conns__more">
          还有 {conns.length - 12} 条更弱的连线 …
        </div>
      )}
      {exportPeer && (
        <PairExportModal
          a={friend.id} aName={friend.name}
          b={exportPeer.id} bName={exportPeer.name}
          onClose={() => setExportPeer(null)}
        />
      )}
    </section>
  );
}

function PairExportModal({
  a, aName, b, bName, onClose,
}: { a: string; aName: string; b: string; bName: string; onClose: () => void }) {
  // Esc closes
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  return (
    <div className="friend-overlay" onClick={onClose}>
      <div className="friend-overlay__panel" role="dialog" aria-modal="true" aria-label="导出这对朋友的关系档案"
        onClick={(e) => e.stopPropagation()}>
        {/* Sits on the panel's title row, below the "MURMUR / PAIR EXPORT" eyebrow. */}
        <button type="button" className="ui-icon-btn friend-overlay__close" onClick={onClose} aria-label="关闭" title="关闭">
          <IconClose size={14} />
        </button>
        <PairAnalysisPanel a={a} b={b} aName={aName} bName={bName} />
      </div>
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
    <section className="friend-card friend-card--accent et-paper-grain">
      <div className="friend-ai__head">
        <span className="friend-ai__badge">AI 已分析</span>
        <span className="et-meta">
          {ageStr} · {(r.size / 1024).toFixed(1)} KB
        </span>
      </div>
      <h3 className="et-h2 friend-card__title">关于 {displayName(friend.id, friend.name)} —— AI 摘要</h3>
      <div className="friend-ai__preview">
        {maskText(preview)}
      </div>
      <div className="friend-ai__actions">
        <Button variant="primary" onClick={onView}>📖 阅读完整报告</Button>
        <Button variant="secondary" icon={<IconRefresh size={14} />} onClick={onRerun}>重新分析</Button>
      </div>
    </section>
  );
}

function AnalysisProgressCard({ stream, error }: {
  stream: { output: string; stage: string; elapsed: number } | null;
  error: string | null;
}) {
  const tail = stream?.output?.trim().slice(-1800);
  return (
    <section className="friend-card friend-card--tight friend-card--accent et-paper-grain" role="status">
      <div className="friend-progress__head">
        <div>
          <div className="et-eyebrow">AI 分析进度</div>
          <h3 className="et-h2 friend-card__title">
            {error ? '分析失败' : `${stream?.stage || '运行中'}…`}
          </h3>
        </div>
        <div className="et-meta et-mono">
          {stream?.elapsed || 0}s
        </div>
      </div>
      {error && (
        <div className="et-meta friend-progress__error">
          {maskText(error.slice(0, 180))}
        </div>
      )}
      {tail && !error && (
        <div className="friend-progress__log">{maskText(tail)}</div>
      )}
    </section>
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
    <div className="friend-overlay friend-overlay--reader" onClick={onClose}>
      <div className="friend-overlay__panel friend-overlay__panel--reader" role="dialog" aria-modal="true" aria-label="AI 关系档案"
        onClick={e => e.stopPropagation()}>
        <button type="button" className="ui-icon-btn friend-overlay__close" aria-label="关闭" title="关闭"
          onClick={(e) => { e.stopPropagation(); onClose(); }}>
          <IconClose size={16} />
        </button>
        <div className="et-eyebrow">AI 关系档案</div>
        <div className="friend-reader__sub">
          关于 {friendName}
        </div>
        {error && (
          <div className="friend-reader__state">
            <ErrorState
              title="报告没能打开"
              reason={maskText(error)}
              fixes={['关掉再点一次「阅读完整报告」', '报告文件被移走或删掉的话，点「重新分析」重新生成']}
            />
          </div>
        )}
        {!content && !error && (
          <div className="friend-reader__state" aria-busy="true">
            <SkeletonText lines={8} lastLineWidth="45%" />
          </div>
        )}
        {content && (
          <article
            className="murmur-md friend-reader__body"
            dangerouslySetInnerHTML={{ __html: mdToHtml(maskText(content)) }}
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
  onExportChat: (fmt: ExportFormat, media: MediaPolicy) => Promise<ExportReport | null>;
  onOpenYearbook: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [media, setMedia] = useState<MediaPolicy>('none');
  const [report, setReport] = useState<ExportReport | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const Btn = ({ icon, label, sub, primary, expanded, onClick }: {
    icon: string; label: string; sub: string; primary?: boolean; expanded?: boolean; onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick} aria-expanded={expanded}
      className={cx('friend-dock__btn', primary && 'is-primary')}>
      <span className="friend-dock__icon" aria-hidden="true">{icon}</span>
      <span className="friend-dock__text">
        <span className="friend-dock__label">{label}</span>
        <span className="friend-dock__sub">{sub}</span>
      </span>
    </button>
  );

  async function pick(fmt: ExportFormat) {
    setBusy(fmt);
    setReport(null);
    setExportError(null);
    try {
      const r = await onExportChat(fmt, media);
      if (r) {
        setReport(r);
      } else {
        setPickerOpen(false);
      }
    } catch (e: any) {
      setExportError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="friend-dock">
        <Btn icon="📖" label="完整聊天记录" sub="气泡浏览，可跳到某一天" onClick={onShowMessages} />
        <Btn icon="📤" label="导出聊天" sub={pickerOpen ? '选择格式…' : '6 种格式 · 可带附件'} expanded={pickerOpen} onClick={() => setPickerOpen(v => !v)} />
        <Btn icon="💑" label="双人年代记" sub="按年份的故事时间线" onClick={onOpenYearbook} />
        <Btn icon="🤖" label="导出 AI 分析包" sub="一键打包给 AI 看" primary onClick={onExportAI} />
      </div>
      {pickerOpen && (
        <div className="friend-export">
          <div className="friend-export__row">
            <div className="friend-export__label">附件</div>
            <div role="radiogroup" aria-label="附件策略" className="friend-export__opts friend-export__opts--media">
              {MEDIA_OPTIONS.map(o => {
                const on = media === o.id;
                return (
                  <button key={o.id} type="button" role="radio" aria-checked={on} disabled={busy !== null}
                    className="friend-export__opt"
                    onClick={() => { setMedia(o.id); setReport(null); }}>
                    <div className="friend-export__opt-title">{o.label}</div>
                    <div className="friend-export__opt-sub">{o.sub}</div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="friend-export__row">
            <div className="friend-export__label">格式</div>
            <div className="friend-export__opts friend-export__opts--formats">
              {EXPORT_FORMATS.map(f => (
                <button key={f.id} type="button" onClick={() => pick(f.id)} disabled={busy !== null} title={f.sub}
                  className={cx('friend-export__opt friend-export__opt--format',
                    busy === f.id && 'is-busy', busy !== null && busy !== f.id && 'is-dim')}>
                  <div className="friend-export__opt-title">{busy === f.id ? '导出中…' : f.label}</div>
                  <div className="friend-export__opt-sub">{f.sub}</div>
                </button>
              ))}
            </div>
            <div className="friend-export__aside">
              <button type="button" className="friend-export__cancel"
                onClick={() => { setPickerOpen(false); setReport(null); setExportError(null); }}>取消</button>
            </div>
          </div>
          {media !== 'none' && !report && (
            <div className="friend-export__note">
              带附件时会生成一个文件夹（聊天文件 + media/ 附件 + 导出报告），不走浏览器下载。
              {media === 'originals' ? '只拷已解密的原图和本机已有的视频。' : '原图缺失时用缩略图顶上。'}
              ChatLab 格式没有附件字段，附件只会放在 media/ 里。
            </div>
          )}
          {exportError && (
            <div className="friend-export__error" role="alert">{maskText(exportError)}</div>
          )}
          {report && <ExportReportCard report={report} />}
        </div>
      )}
    </div>
  );
}

const EXPORT_FORMATS: { id: ExportFormat; label: string; sub: string }[] = [
  { id: 'csv', label: 'CSV', sub: 'Excel 表格' },
  { id: 'md', label: 'Markdown', sub: '笔记 / 给 AI' },
  { id: 'chatlab', label: 'ChatLab', sub: '导入 ChatLab' },
  { id: 'html', label: 'HTML', sub: '离线网页' },
  { id: 'json', label: 'JSON', sub: '给脚本' },
  { id: 'txt', label: 'TXT', sub: '纯文本' },
];

const MEDIA_OPTIONS: { id: MediaPolicy; label: string; sub: string }[] = [
  { id: 'none', label: '不带附件', sub: '只导出文字，最快' },
  { id: 'originals', label: '仅原图', sub: '已解密的原图 / 视频' },
  { id: 'best', label: '尽可能', sub: '没有原图就用缩略图' },
];

function ExportReportCard({ report }: { report: ExportReport }) {
  const m = report.media;
  const reasons = Object.entries(m.missing_reasons || {});
  return (
    <div className="friend-export__report" role="status">
      <div className="friend-export__report-title">
        已导出 <span className="et-num">{report.messages}</span> 条消息
      </div>
      <div className="friend-export__report-media">
        图片 / 视频消息 <span className="et-num">{m.media_messages}</span> 条：
        附件成功 <span className="et-num friend-ok">{m.exported_total}</span> 个
        {m.exported_thumbnail > 0 && <>（其中缩略图 <span className="et-num">{m.exported_thumbnail}</span>）</>}
        ，缺失 <span className={cx('et-num', m.missing_total > 0 && 'friend-bad')}>{m.missing_total}</span> 个
      </div>
      {reasons.length > 0 && (
        <ul>
          {reasons.map(([code, n]) => (
            <li key={code}>{m.missing_reason_labels?.[code] || code}：<span className="et-num">{n}</span></li>
          ))}
        </ul>
      )}
      {m.thumbnail_skipped > 0 && (
        <div className="friend-export__report-hint">其中 {m.thumbnail_skipped} 个有缩略图，换「尽可能」可以导出缩略图。</div>
      )}
      <div className="friend-export__report-foot">
        <button type="button" className="friend-export__open" onClick={() => { void openFolder(report.file); }}>打开文件夹</button>
        <span className="et-meta friend-export__dir">
          {maskText(report.dir)}
        </span>
      </div>
    </div>
  );
}

/** The story tab's shape while the friend loads. */
function FriendSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="friend-page et-root" aria-busy="true">
      <PageHeader back={{ label: '年代记', onClick: onBack }} title="朋友" />
      <div className="friend-tabs" aria-hidden="true">
        {['故事', '相册', '完整对话'].map((t, i) => (
          <span key={t} className="friend-tab" aria-selected={i === 0}>{t}</span>
        ))}
      </div>
      <div className="friend-body" aria-label="正在加载这位朋友">
        <div className="friend-person" aria-hidden="true">
          <div className="friend-skel-person">
            <Skeleton width={108} circle />
            <div className="friend-skel-person__lines">
              <Skeleton width={70} height={11} />
              <Skeleton width="38%" height={30} />
              <Skeleton width="30%" height={12} />
              <Skeleton width="62%" height={18} />
            </div>
          </div>
        </div>
        <div className="friend-stats" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="friend-stat">
              <Skeleton width="50%" height={10} />
              <Skeleton width="70%" height={24} />
              <Skeleton width="60%" height={11} />
            </div>
          ))}
        </div>
        <div className="friend-card" aria-hidden="true">
          <Skeleton width={80} height={11} />
          <div style={{ marginTop: 10 }}><Skeleton width={140} height={22} /></div>
          <div className="friend-rhythm__body">
            <div className="friend-rhythm__ring"><Skeleton width={150} circle /></div>
            <SkeletonText lines={4} lastLineWidth="40%" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function FriendPage({ friendId, onBack, onOpenFriend }: Props) {
  void usePrivacy();
  const [friend, setFriend] = useState<Friend | null>(null);
  const [stats, setStats] = useState<FriendStats | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [momentsLoading, setMomentsLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  // Manual-AI pack just generated — surfaces a ReportReadyBanner with copy /
  // open-folder / send-online links until the user dismisses it. Replaces
  // the old Step-2 modal that was inside AIExportDialog.
  const [readyPack, setReadyPack] = useState<{
    ok: boolean; path: string; size: number; name: string; content: string;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [tab, setTab] = useState<FriendTab>('story');
  const [agentInvoke, setAgentInvoke] = useState<string | null>(null);  // 'claude' | 'codex' etc, null = idle
  const [reportOpen, setReportOpen] = useState(false);
  const [analysisStream, setAnalysisStream] = useState<{ output: string; stage: string; elapsed: number } | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // 完整对话 opens the chat page (#/chat/<id>); it used to be a side drawer.
  const openChat = () => { window.location.hash = `#/chat/${encodeURIComponent(friendId)}`; };

  useEffect(() => {
    setError(null);
    setStats(null);
    getFriend(friendId)
      .then(d => { setFriend(d); setStats(d.stats); })
      .catch(e => setError(e));
    setMomentsLoading(true);
    getMoments(friendId)
      .then(setMoments)
      .catch(() => {})
      .finally(() => setMomentsLoading(false));
  }, [friendId, loadNonce]);

  useEffect(() => {
    let cancelled = false;
    let pollId: number | null = null;

    async function refreshFriend() {
      const d = await getFriend(friendId);
      if (cancelled) return;
      setFriend(d);
      setStats(d.stats);
    }

    async function tick() {
      try {
        const s = await getInvokeStream(friendId);
        if (cancelled) return;
        if (s.running) {
          setAnalysisError(null);
          setAnalysisStream({ output: s.output || '', stage: s.stage || 'running', elapsed: s.elapsed || 0 });
          return;
        }
        if (s.error) {
          setAnalysisError(s.error);
          setAnalysisStream({ output: s.output || '', stage: s.stage || 'failed', elapsed: s.elapsed || 0 });
          if (pollId != null) window.clearInterval(pollId);
          return;
        }
        if (s.stage === 'saved') {
          await refreshFriend();
        }
        setAnalysisStream(null);
        setAnalysisError(null);
        if (pollId != null) window.clearInterval(pollId);
      } catch {
        // Keep the page usable if the progress endpoint is briefly unavailable.
      }
    }

    getInvokeStream(friendId)
      .then(s => {
        if (cancelled) return;
        if (s.running) {
          setAnalysisError(null);
          setAnalysisStream({ output: s.output || '', stage: s.stage || 'running', elapsed: s.elapsed || 0 });
          pollId = window.setInterval(tick, 2000);
        } else if (s.error) {
          setAnalysisError(s.error);
          setAnalysisStream({ output: s.output || '', stage: s.stage || 'failed', elapsed: s.elapsed || 0 });
        } else if (s.stage === 'saved') {
          refreshFriend().catch(() => {});
        } else {
          setAnalysisStream(null);
          setAnalysisError(null);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (pollId != null) window.clearInterval(pollId);
    };
  }, [friendId]);

  async function handleExportChat(fmt: ExportFormat, media: MediaPolicy): Promise<ExportReport | null> {
    if (!friend) return null;
    // Routes through cli/exporters.py — full history (no 5000-cap), preserves
    // compress_content text bodies, picks the right Content-Disposition name.
    // Exports always carry the raw display name; privacy mode in the UI doesn't
    // mask file contents, by design — the file is a personal local archive.
    // Errors propagate to ActionDock, which shows them inline.
    return exportFriendChat(friend.id, fmt, media);
  }

  if (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const code = errorCode(error);
    const entry = lookupError(code);
    return (
      <>
        <PageHeader back={{ label: '年代记', onClick: onBack }} title="朋友" />
        <ErrorState
          layout="page"
          title={entry?.title ?? '这位朋友的页面没能加载'}
          code={code ?? undefined}
          reason={entry?.reason ?? '读取这位朋友的资料时出错了。'}
          fixes={entry ? [entry.fix] : ['点「重试」再读一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
          onRetry={() => setLoadNonce(n => n + 1)}
          details={raw ? <pre>{maskText(raw)}</pre> : undefined}
        />
      </>
    );
  }
  if (!friend) {
    return <FriendSkeleton onBack={onBack} />;
  }

  // If user invoked an agent, show the report page instead of the regular friend layout
  if (agentInvoke) {
    return <RelationshipReportView friend={friend} cli={agentInvoke} onClose={() => {
      setAgentInvoke(null);
      // Re-fetch friend so the freshly-saved aiReport surfaces in the summary card
      getFriend(friendId).then(d => { setFriend(d); setStats(d.stats); }).catch(() => {});
    }} />;
  }

  return (
    <div className="friend-page et-root">
      <FriendChromeBar onBack={onBack} friend={friend} />
      <FriendTabs tab={tab} setTab={(t) => (t === 'chat' ? openChat() : setTab(t))} />
      {tab === 'media' && <MediaGallery friend={friend} />}
      {tab === 'story' && (
      <div className="friend-body">
        <PersonCard friend={friend} stats={stats} />
        {(analysisStream || analysisError) && (
          <AnalysisProgressCard stream={analysisStream} error={analysisError} />
        )}
        <AIReportCard friend={friend}
          onView={() => setReportOpen(true)}
          onRerun={() => setExportOpen(true)} />
        <SignalsEvidenceCard friend={friend as any} />
        <ConnectionsCard friend={friend} onOpen={(id) => onOpenFriend?.(id)} />
        {stats ? (
          <>
            <div className="friend-stats">
              <StatTile label="总消息" value={(stats.totalSelf + stats.totalOther).toLocaleString()} sub="含图文/语音" big />
              <StatTile label="时间跨度" value={`${stats.spanDays} 天`} sub="第一次 → 最近一次" />
              <StatTile label="最长沉默" value={`${stats.longestSilenceDays} 天`} sub={`${stats.longestSilenceFrom} 起`} />
              <StatTile label="高频词" value={`「${maskText(stats.topPhrase)}」`} sub={`共出现 ${stats.topPhraseCount} 次`} />
            </div>
            <RhythmCard friend={friend} stats={stats} />
          </>
        ) : (
          <section className="friend-card">
            <EmptyState
              icon={<IconInbox size={22} />}
              title="消息太少，还算不出统计"
              description={`你们一共 ${friend.count.toLocaleString()} 条消息。多聊一阵子，这里会出现谁更主动、深夜比例、回复速度这些数字。`}
            />
          </section>
        )}
        <MomentsCard moments={moments} loading={momentsLoading} />
        <ActionDock
          onExportAI={() => setExportOpen(true)}
          onShowMessages={openChat}
          onExportChat={handleExportChat}
          onOpenYearbook={() => { window.location.hash = `#yearbook/${friendId}`; }}
        />
        <div className="et-meta friend-footnote">
          — 这一页只你看得见。Murmur 不会把任何内容上传到云端。 —
        </div>
      </div>
      )}
      <AIAssistantDrawer
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        friend={friend}
        onComplete={(pack) => { setReadyPack(pack); setExportOpen(false); }}
        onLocalAgent={(cli) => { setExportOpen(false); setAgentInvoke(cli); }}
      />
      {readyPack && (
        <div style={{ position: 'fixed', top: 'var(--shell-top, 0px)', left: 'var(--shell-left, 0px)', right: 0, zIndex: 40 }}>
          <ReportReadyBanner
            pack={readyPack}
            friend={friend}
            onOpenLocation={() => { /* openFolder is invoked inside the banner */ }}
            onCopy={() => { void navigator.clipboard.writeText(readyPack.content); }}
            onSendOnline={() => {
              // Manual hand-off: the user copies + pastes themselves. We just
              // open ChatGPT in a new tab as a starting point.
              window.open('https://chat.openai.com/', '_blank');
            }}
            onDismiss={() => setReadyPack(null)}
          />
        </div>
      )}
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
    <div className="friend-tabs" role="tablist" aria-label="朋友页">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === tab}
          className="friend-tab" onClick={() => setTab(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}
