/* 左栏：07 分级 RING · 08 核心圈 FOCUS · 09 显示 DISPLAY · 图例 LEGEND。 */
import type { Tier } from '../../components/graph3d/engine';
import { cx } from '../../ui';
import { IconSidebarCollapse } from '../../ui/icons';
import type { GraphModel } from './model';
import { TIER_LABEL, clusterName } from './model';
import { Glyph, SubHead, glyphKind } from './parts';

export interface DisplayOpts { onlySel: boolean; cloud: boolean; ground: boolean }

const TIERS: Tier[] = ['A', 'B', 'C', 'D', 'E'];

export function LeftPanel({ model, hidden, onToggleTier, focus, onFocus, display, onDisplay, autoRotate, onAutoRotate, id, onClose }: {
  model: GraphModel;
  hidden: ReadonlySet<Tier>;
  onToggleTier: (t: Tier) => void;
  focus: string | null;
  onFocus: (id: string | null) => void;
  display: DisplayOpts;
  onDisplay: (d: DisplayOpts) => void;
  autoRotate: boolean;
  onAutoRotate: (on: boolean) => void;
  id?: string;
  /** drawer mode (narrow window): a close button in the first head */
  onClose?: () => void;
}) {
  const sw = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => (
    <button type="button" role="switch" aria-checked={on} className="gx-tog" onClick={() => set(!on)} title={hint}>
      <span className="gx-tog__l">{label}</span>
      <span className={cx('ui-switch', on && 'is-on')} aria-hidden="true" />
    </button>
  );
  return (
    <aside className="ui-mod gx-left" id={id} aria-label="筛选与图例">
      <div className="gx-left__body">
        <SubHead id="07" title="分级" first right={onClose ? (
          <button type="button" className="ui-icon-btn gx-left-close" onClick={onClose} title="收起左栏" aria-label="收起左栏">
            <IconSidebarCollapse size={14} />
          </button>
        ) : 'RING'} />
        {TIERS.map(t => {
          const n = model.tierCount[t];
          const on = !hidden.has(t);
          return (
            <button key={t} type="button" role="checkbox" aria-checked={on} className={cx('gx-tog', !n && 'is-empty')}
              onClick={() => onToggleTier(t)} disabled={!n}>
              <span className={cx('gx-box', on && 'is-on')} aria-hidden="true" />
              <Glyph code={t} kind={glyphKind(t)} />
              <span className="gx-tog__l">{TIER_LABEL[t]}</span>
              {(t === 'D' || t === 'E') && <span className="gx-tag">点云</span>}
              <span className="gx-tog__n">{n}</span>
            </button>
          );
        })}

        <SubHead id="08" title="核心圈" right="FOCUS" />
        <div role="radiogroup" aria-label="聚焦核心圈">
          <button type="button" role="radio" aria-checked={!focus} className={cx('gx-tog', !focus && 'is-on')} onClick={() => onFocus(null)}>
            <span className={cx('gx-radio', !focus && 'is-on')} aria-hidden="true" />
            <span className="gx-tog__l">不聚焦</span>
            <span className="gx-tog__n">—</span>
          </button>
          {model.clusters.map(c => (
            <button key={c.id} type="button" role="radio" aria-checked={focus === c.id} className={cx('gx-tog', focus === c.id && 'is-on')}
              onClick={() => onFocus(focus === c.id ? null : c.id)}>
              <span className={cx('gx-radio', focus === c.id && 'is-on')} aria-hidden="true" />
              <span className="gx-tog__l">{clusterName(c, model)}</span>
              <span className="gx-tog__n">{c.members.length}</span>
            </button>
          ))}
          {model.clusters.length === 0 && <p className="gx-note gx-note--faint gx-pad">这张图里还没有三个人以上互相连着的圈子。</p>}
        </div>

        <SubHead id="09" title="显示" right="DISPLAY" />
        {sw('连线只亮与选中相关', display.onlySel, v => onDisplay({ ...display, onlySel: v }), '选中一个人时，其他连线压暗')}
        {sw('D / E 点云 + 扇区柱', display.cloud, v => onDisplay({ ...display, cloud: v }))}
        {sw('落线 · 赤道网格', display.ground, v => onDisplay({ ...display, ground: v }))}
        {sw('自动旋转', autoRotate, onAutoRotate)}

        <SubHead id="—" title="图例" right="LEGEND" />
        <div className="gx-legend">
          <Glyph code="KQ" kind="b" sel size="md" /><span>当前选中的人</span>
          <Glyph code="PJ" kind="b" core size="md" /><span>同在聚焦的核心圈</span>
          <svg width="28" height="10" aria-hidden="true"><line x1="0" y1="5" x2="28" y2="5" className="gx-legend__sel" /></svg><span>与选中的人有连线</span>
          <Glyph code="KD" kind="x" /><span>与选中相连的 D / E 级</span>
          <svg width="28" height="16" aria-hidden="true"><line x1="14" y1="1" x2="14" y2="12" className="gx-legend__drop" /><ellipse cx="14" cy="12.5" rx="4" ry="1.6" className="gx-legend__foot" /></svg><span>落线 · 脚点在赤道面</span>
          <svg width="28" height="12" aria-hidden="true">
            <g className="gx-legend__d"><rect x="3" y="6" width="2" height="2" /><rect x="9" y="2" width="2" height="2" /><rect x="15" y="7" width="2" height="2" /><rect x="21" y="3" width="2" height="2" /></g>
            <g className="gx-legend__e"><rect x="6" y="9" width="1.6" height="1.6" /><rect x="12" y="5" width="1.6" height="1.6" /><rect x="18" y="1" width="1.6" height="1.6" /><rect x="24" y="8" width="1.6" height="1.6" /></g>
          </svg><span>D / E 点云（深 D · 浅 E）</span>
        </div>
      </div>
    </aside>
  );
}
