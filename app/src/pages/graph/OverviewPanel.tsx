/* 右栏 · 没选中任何人：11 总览 · 12 各环 · 13 离你最近 · 14 圈子；聚焦核心圈时换成这一圈的成员表。 */
import { kfmt } from '../../components/graph3d/engine';
import type { SceneSummary, Tier } from '../../components/graph3d/engine';
import { Button, cx } from '../../ui';
import type { GCluster, GraphModel } from './model';
import { TIER_LABEL, clusterName, codeOf, edgeEvidence, fmt, nameOf, other } from './model';
import { Glyph, Readout, SubHead, glyphKind } from './parts';

const TIERS: Tier[] = ['A', 'B', 'C', 'D', 'E'];

export function OverviewPanel({ model, summary, topN, onSelect, onFocus }: {
  model: GraphModel;
  summary: SceneSummary;
  topN: number;
  onSelect: (id: string) => void;
  onFocus: (clusterId: string) => void;
}) {
  const total = model.nodes.length;
  const msgs = model.nodes.reduce((s, n) => s + n.privateMsgs, 0) || 1;
  const near = model.nodes.filter(n => n.tier === 'A').slice(0, 8);
  const nearList = near.length ? near : model.nodes.slice(0, 6);
  return (
    <>
      <div className="gx-right__body">
        <SubHead id="11" title="总览" right="OVERVIEW · 未选中" first />
        <div className="gx-big">
          <div className="ui-big gx-big__n">{fmt(total)}</div>
          <div className="gx-big__t">
            位联系人 · 前 {topN}
            <span>{summary.shown} 单独画出 · {summary.merged} 合并</span>
          </div>
        </div>
        <div className="gx-ro">
          <Readout en="EDGES" zh="朋友间连线">{fmt(model.edges.length)}</Readout>
          <Readout en="CIRCLES" zh="核心圈">{fmt(model.clusters.length)}</Readout>
          <Readout en="BRIDGES" zh="跨圈的人">{fmt(model.bridges)}</Readout>
          <Readout en="ISOLATED" zh="没连线的人">{fmt(model.isolates)}</Readout>
        </div>

        <SubHead id="12" title="各环" right="RING · 人数 · 私聊占比" />
        <ul className="gx-list">
          {TIERS.filter(t => model.tierCount[t] > 0).map(t => {
            const n = model.tierCount[t];
            const m = model.nodes.filter(x => x.tier === t).reduce((s, x) => s + x.privateMsgs, 0);
            return (
              <li key={t} className="gx-tr">
                <Glyph code={t} kind={glyphKind(t)} />
                <span className="gx-tr__l">{TIER_LABEL[t]}</span>
                <span className="gx-tr__bar"><i style={{ width: `${(n / total) * 100}%` }} /></span>
                <span className="gx-tr__n">{fmt(n)}</span>
                <span className="gx-tr__p">{((m / msgs) * 100).toFixed(1)}%</span>
              </li>
            );
          })}
        </ul>

        <SubHead id="13" title="离你最近" right={near.length ? 'RING A · 私聊 · 圈子' : 'TOP · 私聊'} />
        <ul className="gx-list">
          {nearList.map(n => {
            const nm = nameOf(n), c = n.cluster ? model.clusterById.get(n.cluster) : undefined;
            return (
              <li key={n.id}>
                <button type="button" className="gx-nr" onClick={() => onSelect(n.id)} title={`选中 ${nm}`}>
                  <Glyph code={codeOf(nm)} kind={glyphKind(n.tier)} />
                  <span className="gx-nr__n">{nm}</span>
                  <span className="gx-nr__v">{kfmt(n.privateMsgs)}</span>
                  <span className="gx-nr__l">{c ? clusterName(c, model) : '—'}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {model.clusters.length > 0 && (
          <>
            <SubHead id="14" title="圈子" right="A · B · C 成员" />
            <ul className="gx-list">
              {model.clusters.map(c => {
                const ms = c.members.map(id => model.byId.get(id)!).filter(Boolean).sort((x, y) => x.rank - y.rank);
                return (
                  <li key={c.id}>
                    <button type="button" className="gx-cl" onClick={() => onFocus(c.id)} title="聚焦这个核心圈">
                      <span className="gx-cl__n">{clusterName(c, model)}</span>
                      <span className="gx-cl__m" aria-hidden="true">
                        {ms.slice(0, 12).map(m => <i key={m.id} className={`is-${m.tier.toLowerCase()}`} />)}
                      </span>
                      <span className="gx-cl__c">{ms.length}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      <div className="gx-right__foot gx-right__foot--hint">
        <span className="ui-label">单击节点<b>查看一个人</b><b>·</b><b>双击聚焦他所在的核心圈</b></span>
      </div>
    </>
  );
}

export function CirclePanel({ model, cluster, onSelect, onClose }: {
  model: GraphModel;
  cluster: GCluster;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const ms = cluster.members.map(id => model.byId.get(id)!).filter(Boolean).sort((x, y) => x.rank - y.rank);
  const set = new Set(cluster.members);
  const inner = model.edges.filter(e => set.has(e.a) && set.has(e.b));
  const mix = (['A', 'B', 'C', 'D', 'E'] as Tier[]).map(t => [t, ms.filter(m => m.tier === t).length] as const).filter(([, n]) => n > 0);
  const msgs = ms.reduce((s, m) => s + m.privateMsgs, 0);
  return (
    <>
      <div className="gx-right__body">
        <SubHead id="11" title="核心圈" right={`CIRCLE · ${cluster.id.toUpperCase()}`} first />
        <div className="gx-big">
          <div className="ui-big gx-big__n">{ms.length}</div>
          <div className="gx-big__t">
            {clusterName(cluster, model)}
            <span>{mix.map(([t, n]) => `${t} ${n}`).join(' · ')}</span>
          </div>
        </div>
        <div className="gx-ro">
          <Readout en="INNER" zh="圈内连线" sub="圈里两两之间">{fmt(inner.length)}</Readout>
          <Readout en="MSG" zh="和你的私聊" sub="这一圈加起来">{kfmt(msgs)}</Readout>
        </div>
        <SubHead id="12" title="成员" right="MEMBERS · 圈内连线 · 私聊" />
        <ul className="gx-list">
          {ms.map(m => {
            const nm = nameOf(m);
            const deg = (model.adj.get(m.id) || []).filter(e => set.has(other(e, m.id)));
            const best = deg.length ? deg.reduce((x, y) => (edgeEvidence(y).value > edgeEvidence(x).value ? y : x)) : null;
            return (
              <li key={m.id}>
                <button type="button" className="gx-lk" onClick={() => onSelect(m.id)} title={`选中 ${nm}`}>
                  <Glyph code={codeOf(nm)} kind={m.tier === 'D' || m.tier === 'E' ? 'x' : glyphKind(m.tier)} core={m.tier !== 'A'} />
                  <span className="gx-lk__t">{m.tier}</span>
                  <span className="gx-lk__n">{nm}</span>
                  <span className={cx('gx-lk__g', !best && 'is-faint')}>{deg.length} 条{best ? ` · ${edgeEvidence(best).label}` : ''}</span>
                  <span className="gx-lk__v">{kfmt(m.privateMsgs)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="gx-right__foot">
        <span className="ui-label gx-right__tip">单击成员<b>选中他</b></span>
        <Button size="sm" variant="ghost" kbd="⎋" className="gx-right__end" onClick={onClose}>取消聚焦</Button>
      </div>
    </>
  );
}
