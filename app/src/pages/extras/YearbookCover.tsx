// app/src/pages/extras/YearbookCover.tsx
//
// One year with one friend as a shareable card — sized for a phone
// screenshot, saved as a PNG on request. Instrument style: flat panel, crop
// marks, mono readouts; all colours come from tokens, so the saved image
// follows the theme on screen (aluminium or graphite). Styles:
// ./YearbookCover.css (prefix ybc-).
//
// Data notes:
//   - total → YearData.msg_count
//   - the late-night hour is derived from heatmap_24x7 (no such field)

import { useRef, useState } from 'react';
import type { Friend } from '../../data/types';
import type { YearData } from '../../data/api';
import { displayName } from '../../utils/privacy';
import { Share, Download } from '../../utils/icons';
import { Button, copyText, cx } from '../../ui';
import './YearbookCover.css';

interface Props {
  // Either pass a full Friend or just the wxid + display name. The card only
  // needs the id and name.
  friend?: Friend;
  friendId?: string;
  friendName?: string;
  year: YearData;
  caption?: string;
  firstWordsDate?: string;
}

function fmtDate(d?: string) {
  if (!d) return '—';
  return d.replace(/-/g, '·');
}

/** 「朋友 PB」→ PB, otherwise the first character. */
function monogram(name: string): string {
  const m = /^(?:朋友|群)\s*(\S{1,3})$/.exec(name);
  if (m) return m[1];
  return Array.from(name.replace(/\s+/g, ''))[0] ?? '·';
}

function buildFallbackCaption(year: YearData, friendName: string): string {
  const m = year.midnight_friend_pct;
  const s = year.initiative_self_pct;
  if (typeof m === 'number' && m >= 60) return `深夜里他最常找的人，是你。`;
  if (typeof s === 'number' && s >= 60) return `这一年是你在主动追着 ${friendName}。`;
  if (typeof s === 'number' && s <= 40) return `这一年是 ${friendName} 在主动追着你。`;
  return `两个稳定地、不慌不忙地把彼此放进日子里的人。`;
}

// Find the 23-04 hour with the highest cell count in the 168-cell heatmap.
// Returns 0..23 or null when no heatmap data.
function peakMidnightHour(heat: number[] | undefined): number | null {
  if (!heat || heat.length !== 168) return null;
  // We only care about hours 23, 0, 1, 2, 3, 4 — across all 7 weekdays.
  const lateHours = [23, 0, 1, 2, 3, 4];
  let best = -1;
  let bestCount = 0;
  for (const h of lateHours) {
    let total = 0;
    for (let w = 0; w < 7; w++) total += heat[w * 24 + h] || 0;
    if (total > bestCount) {
      bestCount = total;
      best = h;
    }
  }
  return best === -1 ? null : best;
}

/** Messages per hour of day, summed over the week. */
function hourTotals(heat: number[] | undefined): number[] | null {
  if (!heat || heat.length !== 168) return null;
  const out = new Array(24).fill(0);
  heat.forEach((v, i) => { out[i % 24] += v || 0; });
  return out.some(v => v > 0) ? out : null;
}

type Status = { kind: 'ok' | 'err'; text: string } | null;

export function YearbookCover(props: Props) {
  const { year, caption, firstWordsDate } = props;
  const id = props.friend?.id ?? props.friendId ?? '?';
  const rawName = props.friend?.name ?? props.friendName ?? id;
  const ref = useRef<HTMLElement>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const friendName = displayName(id, rawName);
  const yearNum = year.year ?? new Date().getFullYear();
  const total = year.msg_count ?? 0;
  const longest = year.longest_streak_days ?? null;
  const midnightHour = peakMidnightHour(year.heatmap_24x7);
  const midnightPct = year.midnight_friend_pct ?? null;
  const hours = hourTotals(year.heatmap_24x7);
  const hourMax = hours ? Math.max(...hours) : 0;
  const cap = caption || buildFallbackCaption(year, friendName);
  const code = monogram(friendName);

  const save = async () => {
    if (!ref.current || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      await saveCardPng(ref.current);
      setStatus({ kind: 'ok', text: '已保存为 murmur-year-cover.png' });
    } catch (e) {
      console.warn('[YearbookCover] save-image failed', e);
      setStatus({ kind: 'err', text: '没能生成图片，可以直接截图这张卡片。' });
    } finally {
      setSaving(false);
    }
  };

  const share = async () => {
    try {
      await copyText(shareText(friendName, yearNum, cap));
      setStatus({ kind: 'ok', text: '分享文案已复制' });
    } catch {
      setStatus({ kind: 'err', text: '没能写入剪贴板' });
    }
  };

  return (
    <div className="ybc-wrap">
      <article ref={ref} className="ybc" aria-label={`${yearNum} 年度卡 · 你与 ${friendName}`}>
        <div className="ybc__top">
          <span className="ybc__brand">MURMUR<b>年度档</b></span>
          <span className="ybc__no">NO. {String(id).slice(-6).toUpperCase()}</span>
        </div>

        <div className="ybc__year">
          <span className="ybc__yn">{yearNum}</span>
          <span className="ybc__yl"><i />YEAR</span>
        </div>

        <div className="ybc__who">
          <span className={cx('ybc__mono', Array.from(code).length > 2 && 'is-long')} aria-hidden="true">{code}</span>
          <span className="ybc__who-t">
            <span className="ybc__with">与</span>
            <span className="ybc__name">{friendName}</span>
          </span>
        </div>

        <p className="ybc__cap">{cap}</p>

        {hours && (
          <div className="ybc__hours" aria-hidden="true">
            <div className="ybc__bars">
              {hours.map((v, h) => (
                <i key={h} className={cx(v === hourMax && 'is-peak')} style={{ height: `${Math.max(v > 0 ? 6 : 0, (v / hourMax) * 100)}%` }} />
              ))}
            </div>
            <div className="ybc__ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
          </div>
        )}

        <dl className="ybc__rows">
          <CoverRow label="总消息" value={total ? total.toLocaleString('en-US') : '—'} unit="条" />
          <CoverRow label="第一次说话" value={fmtDate(firstWordsDate)} />
          <CoverRow label="最长连聊" value={longest != null ? String(longest) : '—'} unit={longest != null ? '天' : ''} />
          <CoverRow
            label="最深夜的时段"
            value={midnightHour != null ? String(midnightHour).padStart(2, '0') : '—'}
            unit={midnightHour != null ? ':00' : ''}
            sub={midnightPct != null ? `深夜里 ${friendName} 占 ${Math.round(midnightPct)}%` : undefined}
          />
        </dl>

        <div className="ybc__foot">
          <span className="ybc__local"><i />LOCAL · ONLY</span>
          <span className="ybc__note">全部数据从本机聊天记录中读出。<br />不上传 · 不联网 · 仅你能看见。</span>
        </div>
        <span className="ui-crop" aria-hidden="true" />
      </article>

      <div className="ybc-acts">
        <Button size="sm" icon={<Download size={13} />} loading={saving} onClick={save}>保存为图片</Button>
        <Button size="sm" variant="ghost" icon={<Share size={13} />} onClick={share}>复制分享文案</Button>
      </div>
      <div className={cx('ybc-status', status?.kind === 'err' && 'is-err')} role="status" aria-live="polite">
        {status?.text ?? ' '}
      </div>
    </div>
  );
}

function CoverRow({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="ybc__row">
      <dt>
        {label}
        {sub && <span className="ybc__row-sub">{sub}</span>}
      </dt>
      <dd><span className="ybc__row-v">{value}</span>{unit && <span className="ybc__row-u">{unit}</span>}</dd>
    </div>
  );
}

/** Render the card to a PNG and hand it to the browser as a download. The
 * background is read from the card itself, so a graphite card saves as a
 * graphite image (not dark text on a light canvas). */
async function saveCardPng(node: HTMLElement) {
  // Lazy chunk: html-to-image is only loaded when someone saves a card.
  const { toPng } = await import('html-to-image');
  const backgroundColor = getComputedStyle(node).backgroundColor;
  const dataUrl = await toPng(node, { pixelRatio: 2, backgroundColor, cacheBust: true });
  const a = document.createElement('a');
  a.download = 'murmur-year-cover.png';
  a.href = dataUrl;
  a.click();
}

function shareText(friendName: string, year: number, caption: string) {
  return `${year} 年 · 与 ${friendName} —— ${caption}\n\n用 Murmur 本地分析，自己的微信记录自己读。`;
}
