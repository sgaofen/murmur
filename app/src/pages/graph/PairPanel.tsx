/* 右栏 · 两个朋友之间：11 这一对 PAIR · 12 证据 EVIDENCE · 13 AI 推断。
 * 证据来自 /api/friend-pair-pack（只有共群这类弱信号时后端返回 422，这里如实说明并且不提供 AI 推断）；
 * AI 推断报告来自 /api/pair-report，没有就可以让本机的 AI CLI 现跑一份（/api/agents/invoke-pair + pair-stream）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { findPairReport, getPairPack, getPairStream, getReport, invokePairAgent } from '../../data/api';
import type { FriendConnection, LocalAgent } from '../../data/api';
import { mdToHtml } from '../../utils/markdown';
import { displayName, maskText } from '../../utils/privacy';
import { ReportReader, parseReport } from '../extras/ReportReader';
import { PairAnalysisPanel } from '../extras/PairAnalysisPanel';
import { Button, Dialog, Skeleton, cx } from '../../ui';
import { IconCopy } from '../../ui/icons';
import type { GEdge, GNode, GraphModel } from './model';
import { clusterName, codeOf, edgeFacts, edgeKey, fmt, leadOf, mmdd, nameOf, pairEvidenceErrorMessage, tierCode } from './model';
import { AgentButtons, Readout, StreamBox, SubHead } from './parts';
import type { StreamState } from './parts';

export interface PairPanelProps {
  model: GraphModel;
  a: GNode;
  bId: string;
  /** Present when the other person came from the connections list and isn't in the graph. */
  conn?: FriendConnection;
  isQQ: boolean;
  agents: LocalAgent[] | null;
  onBack: () => void;
  onOpenFriend: (id: string) => void;
}

type Report = { available: boolean; path?: string; size?: number; mtime?: number; short?: string };

export function PairPanel(p: PairPanelProps) {
  const { model, a, bId, conn, isQQ, agents } = p;
  const b = model.byId.get(bId);
  const aName = nameOf(a);
  const bName = b ? nameOf(b) : displayName(bId, conn?.name || bId);
  const edge: GEdge | undefined = model.adj.get(a.id)?.find(e => e.key === edgeKey(a.id, bId));
  const facts = edge ? edgeFacts(edge, isQQ) : conn ? connFacts(conn, isQQ) : [];
  const sameCircle = !!a.cluster && b?.cluster === a.cluster ? model.clusterById.get(a.cluster) : undefined;

  const [pack, setPack] = useState<string | null>(null);
  const [packErr, setPackErr] = useState<string | null>(null);
  const [packLoading, setPackLoading] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [phase, setPhase] = useState<'idle' | 'running' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [reader, setReader] = useState<{ text: string | null; error: string | null } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const startedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getPairPack(a.id, bId)
      .then(r => { if (!cancelled) setPack(r.pack); })
      .catch(e => { if (!cancelled) setPackErr(pairEvidenceErrorMessage(e)); })
      .finally(() => { if (!cancelled) setPackLoading(false); });
    findPairReport(a.id, bId).then(r => { if (!cancelled) setReport(r); }).catch(() => { if (!cancelled) setReport({ available: false }); });
    // an analysis started earlier (here or in another window) that is still running
    getPairStream(a.id, bId).then(s => {
      if (cancelled || !s.running) return;
      startedAt.current = Date.now() - (s.elapsed || 0) * 1000;
      setStream({ output: s.output || '', stage: s.stage || '运行中', elapsed: s.elapsed || 0 });
      setPhase('running');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [a.id, bId]);

  useEffect(() => {
    if (phase !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      if (Date.now() - startedAt.current > 5 * 60 * 1000) { setErr('5 分钟还没跑完，可以稍后回来看'); setPhase('error'); return; }
      try {
        const s = await getPairStream(a.id, bId);
        if (cancelled) return;
        setStream({ output: s.output || '', stage: s.stage || '运行中', elapsed: s.elapsed || 0 });
        if (s.running) return;
        if (s.error) { setErr(s.error); setPhase('error'); return; }
        const r = await findPairReport(a.id, bId);
        if (cancelled) return;
        setReport(r); setPhase('idle'); setStream(null);
      } catch { /* keep polling */ }
    };
    const t = window.setInterval(tick, 2000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [a.id, bId, phase]);

  async function run(cli: string) {
    setErr(null);
    setStream({ output: '', stage: '排队中', elapsed: 0 });
    startedAt.current = Date.now();
    try {
      const r = await invokePairAgent({ cli, a: a.id, b: bId });
      if (!r.ok) { setErr(r.error || '没能排上队'); setPhase('error'); return; }
      setPhase('running');
    } catch (e) {
      setErr(pairEvidenceErrorMessage(e)); setPhase('error');
    }
  }

  async function openReport() {
    if (!report?.path) return;
    setReader({ text: null, error: null });
    try {
      const r = await getReport(report.path);
      setReader({ text: r.content, error: null });
    } catch (e) {
      setReader({ text: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const parsed = useMemo(() => (reader?.text ? parseReport(maskText(reader.text)) : null), [reader?.text]);
  const packHtml = useMemo(() => {
    if (!pack) return '';
    const cut = pack.length > 4000 ? pack.slice(0, 4000) + `\n\n*……后面省略，共 ${Math.round(pack.length / 1000)}K 字*` : pack;
    return mdToHtml(maskText(cut));
  }, [pack]);

  const ca = codeOf(aName), cb = codeOf(bName);
  const head = `PAIR · ${tierCode(a)} ↔ ${b ? tierCode(b) : 'OUT'}`;
  const weak = !!packErr && /弱信号/.test(packErr);
  const rep = report?.available ? report : null;

  return (
    <>
      <div className="gx-right__body">
        <SubHead id="11" title="这一对" right={head} first />
        <div className="gx-pair">
          <div className="gx-pair__codes" aria-hidden="true">
            <span>{ca}</span><i>↔</i><span>{cb}</span>
          </div>
          <div className="gx-pair__names">
            <span title={aName}>{aName}</span><i>和</i><span title={bName}>{bName}</span>
          </div>
          <div className="gx-id__chips">
            {edge && <span className="gx-chip is-signal">{edgeTypeLabel(edge.type)}</span>}
            {!edge && conn && <span className="gx-chip">不在这张图里</span>}
            {sameCircle && <span className="gx-chip">同一圈 · {clusterName(sameCircle, model)}</span>}
            {rep && <span className="gx-chip">AI</span>}
          </div>
        </div>
        <div className="gx-ro">
          {facts.length ? facts.map(f => (
            <Readout key={f.k} en={f.k} zh={f.zh}>{fmt(f.v)}<small>{f.unit}</small></Readout>
          )) : (
            <Readout en="SIGNAL" zh="信号">—</Readout>
          )}
          {facts.length > 1 && facts.length % 2 === 1 && <div className="gx-ro__cell is-empty" aria-hidden="true" />}
        </div>
        {!isQQ && edge?.moments != null && edge.momentsAB != null && edge.momentsBA != null && (
          <div className="gx-facts">
            <span><i>朋友圈</i>{codeOf(aName)} → {codeOf(bName)} {fmt(edge.momentsAB)} · {codeOf(bName)} → {codeOf(aName)} {fmt(edge.momentsBA)}</span>
          </div>
        )}

        <SubHead id="12" title="证据" right={packLoading ? 'LOADING' : pack ? `EVIDENCE · ${Math.max(1, Math.round(pack.length / 1000))}K` : 'WEAK SIGNAL'} />
        <div className="gx-ai">
          {packLoading && <div className="gx-skel"><Skeleton height={12} /><Skeleton height={12} width="80%" /><Skeleton height={12} width="64%" /></div>}
          {packErr && <p className={cx('gx-note', weak && 'gx-note--faint')}>{maskText(packErr)}</p>}
          {pack && <article className="gx-md" dangerouslySetInnerHTML={{ __html: packHtml }} />}
        </div>

        <SubHead id="13" title="AI 推断" right={rep ? `LOCAL MODEL · ${mmdd(rep.mtime)}` : phase === 'running' ? 'RUNNING' : 'NONE'} />
        <div className="gx-ai">
          {rep ? (
            <>
              <p className="gx-note gx-note--lead">{maskText(leadOf(rep.short, 170))}</p>
              <div className="gx-ai__keys">
                <Button size="sm" onClick={openReport}>阅读完整推断</Button>
                <Button size="sm" variant="ghost" onClick={() => setExportOpen(true)}>导出这一对</Button>
              </div>
            </>
          ) : weak ? (
            <p className="gx-note gx-note--faint">证据不够，先不推断。等他们俩在群里有了来回、或者你的聊天里同时提到他们，再来看。</p>
          ) : (
            <>
              <p className="gx-note gx-note--faint">这一对还没让 AI 推断过。</p>
              {phase === 'running' && <StreamBox stream={stream} />}
              {phase === 'error' && err && <p className="gx-err">没跑完：{maskText(err.slice(0, 160))}</p>}
              {phase !== 'running' && <AgentButtons agents={agents} onRun={run} verb="推断这一对" />}
              {phase !== 'running' && (
                <div className="gx-ai__keys">
                  <Button size="sm" variant="ghost" onClick={() => setExportOpen(true)}>导出这一对给在线 AI</Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="gx-right__foot">
        <Button size="sm" variant="ghost" kbd="⎋" onClick={p.onBack}>返回 {ca}</Button>
        <Button size="sm" className="gx-right__end" onClick={() => p.onOpenFriend(a.id)}>{ca} 的档案</Button>
        <Button size="sm" onClick={() => p.onOpenFriend(bId)}>{cb} 的档案</Button>
      </div>
      <Dialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        eyebrow="PAIR EXPORT"
        title={`${aName} × ${bName}`}
        description="把他们俩之间的往来导出成文件"
        size="md"
      >
        <PairAnalysisPanel a={a.id} b={bId} aName={a.name} bName={b?.name || conn?.name || bId} bare />
      </Dialog>
      {reader && (
        <ReportReader
          id="13"
          label="AI 推断"
          title={parsed?.title ? parsed.title : `${aName} 和 ${bName}`}
          meta={rep ? <><b>{aName}</b> ↔ <b>{bName}</b> · {mmdd(rep.mtime)} 生成{rep.size ? ` · ${(rep.size / 1024).toFixed(1)} KB` : ''}</> : undefined}
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

function edgeTypeLabel(t: string): string {
  if (t === 'mutual_reply') return '群里互回';
  if (t === 'mention') return '被一起提到';
  if (t === 'moments_cross') return '朋友圈互动';
  if (t === 'co_group') return '共同群';
  return t;
}

function connFacts(c: FriendConnection, isQQ: boolean) {
  const out: { k: string; zh: string; v: number; unit: string }[] = [];
  if (c.edge_type === 'mutual_reply') out.push({ k: 'REPLY', zh: '群里互回', v: Math.round(c.weight), unit: '次' });
  if (c.mention_count) out.push({ k: 'MENTION', zh: '你聊天里同时提到', v: c.mention_count, unit: '次' });
  if (!isQQ && c.moments_cross) out.push({ k: 'MOMENTS', zh: '朋友圈互动', v: c.moments_cross, unit: '次' });
  if (c.shared_group_count) out.push({ k: 'GROUPS', zh: '共同群', v: c.shared_group_count, unit: '个' });
  return out;
}
