/* 右栏 · 选中一个人：11 选中 SUBJECT · 12 AI 摘要 · 13 连线 LINKS。
 * 读数只用后端给的字段：图里的私聊 / 群聊条数和分级来自 /api/graph，跨度、最长沉默、认识多久来自 /api/friend/<id>，
 * 图外连线来自 /api/friend/<id>/connections；拿不到的显示「—」，不估算。 */
import { useEffect, useMemo, useState } from 'react';
import { getFriend, getFriendConnections, getInvokeStream, getReport, invokeAgent } from '../../data/api';
import type { FriendConnection, LocalAgent } from '../../data/api';
import type { Friend, FriendStats } from '../../data/types';
import { kfmt } from '../../components/graph3d/engine';
import { ReportReader, parseReport } from '../extras/ReportReader';
import type { ParsedReport } from '../extras/ReportReader';
import { displayName, maskedWxid, maskText } from '../../utils/privacy';
import { Button, Skeleton, cx } from '../../ui';
import { IconCopy } from '../../ui/icons';
import type { GEdge, GNode, GraphModel } from './model';
import { TIER_LABEL, clusterName, codeOf, edgeEvidence, fmt, leadOf, mmdd, nameOf, other, sortEdges, tierCode } from './model';
import { AgentButtons, Glyph, Meter, Readout, StreamBox, SubHead, glyphKind } from './parts';
import type { StreamState } from './parts';

type Detail = Friend & { stats: FriendStats | null };

export interface SubjectPanelProps {
  model: GraphModel;
  node: GNode;
  isQQ: boolean;
  agents: LocalAgent[] | null;
  hotPeer: string | null;
  onHotPeer: (id: string | null) => void;
  onPair: (peerId: string, conn?: FriendConnection) => void;
  onFocus: (clusterId: string) => void;
  onOpenProfile: () => void;
  onOpenChat: () => void;
  onClose: () => void;
}

const RING_NO: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5 };

export function SubjectPanel(p: SubjectPanelProps) {
  const { model, node, isQQ, agents } = p;
  const id = node.id;
  const name = nameOf(node);
  const code = codeOf(name);
  const cluster = node.cluster ? model.clusterById.get(node.cluster) : undefined;
  const cName = cluster ? clusterName(cluster, model) : null;

  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailErr, setDetailErr] = useState(false);
  const [conns, setConns] = useState<FriendConnection[] | null>(null);
  const [showAllOut, setShowAllOut] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'running' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [reader, setReader] = useState<{ text: string | null; error: string | null } | null>(null);

  // panel state belongs to one person: the parent keys this component by id
  useEffect(() => {
    let cancelled = false;
    getFriend(id).then(d => { if (!cancelled) setDetail(d); }).catch(() => { if (!cancelled) setDetailErr(true); });
    getFriendConnections(id).then(r => { if (!cancelled) setConns(r.connections || []); }).catch(() => { if (!cancelled) setConns([]); });
    getInvokeStream(id).then(s => {
      if (cancelled) return;
      if (s.running) { setPhase('running'); setStream({ output: s.output || '', stage: s.stage || '运行中', elapsed: s.elapsed || 0 }); }
      else if (s.error) { setErr(s.error); setPhase('error'); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (phase !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getInvokeStream(id);
        if (cancelled) return;
        setStream({ output: s.output || '', stage: s.stage || '运行中', elapsed: s.elapsed || 0 });
        if (s.running) return;
        if (s.error) { setErr(s.error); setPhase('error'); return; }
        const d = await getFriend(id);
        if (cancelled) return;
        setDetail(d); setPhase('idle'); setStream(null);
      } catch { /* the stream endpoint can race with process start-up; keep polling */ }
    };
    void tick();
    const t = window.setInterval(tick, 2000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [id, phase]);

  async function run(cli: string) {
    setErr(null);
    setStream({ output: '', stage: '排队中', elapsed: 0 });
    try {
      const r = await invokeAgent({ cli, wxid: id });
      if (!r.ok) { setErr(r.error || '没能排上队'); setPhase('error'); return; }
      setPhase('running');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e)); setPhase('error');
    }
  }

  async function openReport() {
    const path = detail?.aiReport?.path;
    if (!path) return;
    setReader({ text: null, error: null });
    try {
      const r = await getReport(path);
      setReader({ text: r.content, error: null });
    } catch (e) {
      setReader({ text: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const parsed: ParsedReport | null = useMemo(() => (reader?.text ? parseReport(maskText(reader.text)) : null), [reader?.text]);

  // ——— links: in-graph edges, grouped 同一圈 / 其他; plus connections the graph doesn't show ———
  const edges = useMemo(() => sortEdges(model.adj.get(id) || []), [model, id]);
  const core = edges.filter(e => node.cluster && model.byId.get(other(e, id))?.cluster === node.cluster);
  const rest = edges.filter(e => !core.includes(e));
  const inGraph = new Set(edges.map(e => other(e, id)));
  const outside = (conns || []).filter(c => c.wxid !== id && c.edge_type !== 'private' && !inGraph.has(c.wxid));
  const outsideUniq = outside.filter((c, i) => outside.findIndex(x => x.wxid === c.wxid) === i);

  const stats = detail?.stats ?? null;
  const total = node.privateMsgs + node.groupMsgs;
  const dmPct = total ? Math.round(node.privateMsgs / total * 100) : 0;
  const silenceFrom = stats && stats.longestSilenceDays > 0 && /^\d{4}/.test(stats.longestSilenceFrom) ? stats.longestSilenceFrom : null;
  const rep = detail?.aiReport?.available ? detail.aiReport : null;
  const summary = leadOf(rep?.short);
  const dash = <span className="gx-dash">—</span>;

  const linkRow = (e: GEdge) => {
    const pid = other(e, id), pn = model.byId.get(pid);
    if (!pn) return null;
    const nm = nameOf(pn), ev = edgeEvidence(e), sameCore = !!node.cluster && pn.cluster === node.cluster;
    return (
      <li key={e.key}>
        <button type="button" className={cx('gx-lk', p.hotPeer === pid && 'is-hot')}
          onClick={() => p.onPair(pid)}
          onMouseEnter={() => p.onHotPeer(pid)} onMouseLeave={() => p.onHotPeer(null)}
          onFocus={() => p.onHotPeer(pid)} onBlur={() => p.onHotPeer(null)}
          title={`看 ${name} 和 ${nm} 之间`}>
          <Glyph code={codeOf(nm)} kind={pn.tier === 'D' || pn.tier === 'E' ? 'x' : glyphKind(pn.tier)} core={sameCore} />
          <span className="gx-lk__t">{pn.tier}</span>
          <span className="gx-lk__n">{nm}</span>
          <span className="gx-lk__g">{ev.label} {ev.value}</span>
          <span className="gx-lk__v">{kfmt(pn.privateMsgs)}</span>
        </button>
      </li>
    );
  };

  return (
    <>
      <div className="gx-right__body">
        <SubHead id="11" title="选中" right={`SUBJECT · ${tierCode(node)}`} first />
        <div className="gx-id">
          <div className={cx('gx-id__code', Array.from(code).length > 2 && 'is-long')} aria-hidden="true">{code}</div>
          <div className="gx-id__text">
            <h2 className="gx-id__name" title={name}>{name}</h2>
            <div className="gx-id__chips">
              <span className="gx-chip is-signal">TIER {node.tier}</span>
              {cluster && <span className="gx-chip">CORE</span>}
              {cluster && cName && (
                <button type="button" className="gx-chip gx-chip--btn" onClick={() => p.onFocus(cluster.id)} title="聚焦这个核心圈">{cName}</button>
              )}
              {node.bridge && <span className="gx-chip" title="连接不同圈子的人">BRIDGE</span>}
              {rep && <span className="gx-chip">AI</span>}
            </div>
          </div>
        </div>
        <div className="gx-id__meta">
          <span>{maskedWxid(id)}</span>
          {detail?.knew && <span>{detail.knew}</span>}
          {detail?.last && <span>最近 {detail.last}</span>}
        </div>
        <div className="gx-ro">
          <Readout en="MSG" zh="私聊" sub={node.groupMsgs ? `群里另有 ${fmt(node.groupMsgs)} 条` : '群里没有往来'}>
            {fmt(node.privateMsgs)}
          </Readout>
          <Readout en="RING" zh="离你" sub={`${TIER_LABEL[node.tier]} · 综合第 ${node.rank} 位`}>
            {node.tier}<small>第 {RING_NO[node.tier]} 环</small>
          </Readout>
          <Readout en="SPAN" zh="跨度" sub={stats ? `约 ${(stats.spanDays / 365.25).toFixed(1)} 年` : detailErr ? '没能读到' : undefined}>
            {stats ? <>{fmt(stats.spanDays)}<small>D</small></> : detail || detailErr ? dash : <Skeleton width={72} height={18} />}
          </Readout>
          <Readout en="SILENCE" zh="最长沉默" sub={silenceFrom ? `从 ${silenceFrom} 起` : undefined}>
            {stats ? <>{fmt(stats.longestSilenceDays)}<small>D</small></> : detail || detailErr ? dash : <Skeleton width={56} height={18} />}
          </Readout>
        </div>
        <div className="gx-rrow">
          <span className="ui-label">DM / GROUP<b>私聊 / 群聊</b></span>
          <span className="gx-rrow__v">{total ? <>{dmPct} / {100 - dmPct}</> : '—'}</span>
        </div>
        <Meter parts={[{ pct: dmPct, tone: 'ink' }, { pct: 100 - dmPct, tone: 'dim' }]} />
        <div className="gx-facts">
          <span><i>共群</i>{fmt(node.groups)}<small>个</small></span>
          {!isQQ && <span><i>朋友圈</i>他赞你 {fmt(node.momentsBack)} · 你赞他 {fmt(node.momentsOut)}</span>}
          {stats?.topPhrase && <span><i>高频词</i>「{maskText(stats.topPhrase)}」</span>}
        </div>

        <SubHead id="12" title="AI 摘要" right={rep ? `LOCAL MODEL · ${mmdd(rep.mtime)}` : phase === 'running' ? 'RUNNING' : 'NONE'} />
        <div className="gx-ai">
          {rep ? (
            <>
              <p className="gx-note gx-note--lead">{maskText(summary)}</p>
              <div className="gx-ai__keys">
                <Button size="sm" onClick={openReport}>阅读完整报告</Button>
              </div>
            </>
          ) : (
            <>
              <p className="gx-note gx-note--faint">还没让 AI 读过你和 {name} 的聊天。</p>
              {phase === 'running' && <StreamBox stream={stream} />}
              {phase === 'error' && err && <p className="gx-err">没跑完：{maskText(err.slice(0, 140))}</p>}
              {phase !== 'running' && <AgentButtons agents={agents} onRun={run} verb="分析" />}
            </>
          )}
        </div>

        <SubHead id="13" title="连线" right={`LINKS ${edges.length} · 同一圈 / 其他`} />
        {edges.length === 0 && (
          <p className="gx-note gx-note--faint gx-pad">在这张图的范围里，{name} 和其他人之间没有连线。</p>
        )}
        {core.length > 0 && (
          <>
            <div className="gx-lk-sub"><span>CORE · 同一圈</span><span>{core.length}</span></div>
            <ul className="gx-list">{core.map(linkRow)}</ul>
          </>
        )}
        {rest.length > 0 && (
          <>
            <div className="gx-lk-sub"><span>LINK · {core.length ? '其他' : '连线'}</span><span>{rest.length}</span></div>
            <ul className="gx-list">{rest.map(linkRow)}</ul>
          </>
        )}
        {outsideUniq.length > 0 && (
          <>
            <div className="gx-lk-sub"><span>OUTSIDE · 不在这张图里</span><span>{outsideUniq.length}</span></div>
            <ul className="gx-list">
              {(showAllOut ? outsideUniq : outsideUniq.slice(0, 5)).map(c => {
                const nm = displayName(c.wxid, c.name);
                const ev = c.edge_type === 'mutual_reply' ? `互回 ${c.weight}`
                  : c.edge_type === 'mention' ? `提及 ${c.mention_count ?? '—'}`
                  : c.edge_type === 'moments_cross' ? `朋友圈 ${c.moments_cross ?? '—'}`
                  : c.edge_type === 'co_group' ? `共群 ${c.shared_group_count ?? c.weight}` : c.edge_type;
                return (
                  <li key={c.wxid}>
                    <button type="button" className="gx-lk is-out" onClick={() => p.onPair(c.wxid, c)} title={`看 ${name} 和 ${nm} 之间`}>
                      <Glyph code={codeOf(nm)} kind="x" />
                      <span className="gx-lk__t">·</span>
                      <span className="gx-lk__n">{nm}</span>
                      <span className="gx-lk__g">{ev}</span>
                      <span className="gx-lk__v" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {outsideUniq.length > 5 && (
              <button type="button" className="gx-more" onClick={() => setShowAllOut(s => !s)}>
                {showAllOut ? '收起' : `展开其余 ${outsideUniq.length - 5} 条`}
              </button>
            )}
          </>
        )}
      </div>
      <div className="gx-right__foot">
        <Button variant="primary" size="sm" kbd="P" onClick={p.onOpenProfile}>打开档案</Button>
        <Button size="sm" kbd="C" onClick={p.onOpenChat}>查看对话</Button>
        <Button size="sm" variant="ghost" kbd="⎋" className="gx-right__end" onClick={p.onClose}>取消选中</Button>
      </div>
      {reader && (
        <ReportReader
          title={parsed?.title ? parsed.title : `与 ${name} 的关系档案`}
          meta={rep ? <>关于 <b>{name}</b> · {mmdd(rep.mtime)} 生成 · {(rep.size / 1024).toFixed(1)} KB</> : undefined}
          sections={parsed?.sections ?? []}
          raw={!parsed ? (reader.error ? `报告没能打开：${maskText(reader.error)}` : '正在读取报告…') : undefined}
          onClose={() => setReader(null)}
          actions={parsed ? (
            <Button size="sm" variant="ghost" icon={<IconCopy size={13} />}
              onClick={() => { void navigator.clipboard.writeText(maskText(reader.text || '')); }}>
              复制全文
            </Button>
          ) : undefined}
        />
      )}
    </>
  );
}
