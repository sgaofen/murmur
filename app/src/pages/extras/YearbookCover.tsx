// app/src/pages/extras/YearbookCover.tsx
//
// Round 2 — single-page shareable "year report cover".
// Designed to fit in a phone screenshot with five viral data points.
//
// Adapted from Claude Design's Round 2 deliverable with these reality-fixes:
//   - YearStat → YearData
//   - field renames: total/messages → msg_count
//   - peak_midnight_hour derived from heatmap_24x7 (no such field on YearData)
//   - Stamp prop is `label` not `text`

import { useRef } from 'react';
import type { Friend } from '../../data/types';
import type { YearData } from '../../data/api';
import { Avatar } from '../../components/Avatar';
import { Stamp } from '../../components/Stamp';
import { Postmark } from '../../components/Postmark';
import { displayName } from '../../utils/privacy';
import { Share, Download } from '../../utils/icons';

interface Props {
  // Either pass a full Friend or just the wxid + display name. The cover
  // only needs id / name / hue / glyph for the avatar — everything else on
  // Friend goes unused.
  friend?: Friend;
  friendId?: string;
  friendName?: string;
  year: YearData;
  caption?: string;
  firstWordsDate?: string;
}

function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function ensureFriend(props: Props): Friend {
  if (props.friend) return props.friend;
  const id = props.friendId || '?';
  const name = props.friendName || id;
  const cleaned = name.replace(/[^A-Za-z0-9一-鿿]/g, '');
  return {
    id,
    name,
    count: 0, last: '', tag: '', tagKind: 'faint',
    hue: hueOf(id),
    glyph: cleaned.slice(0, 2) || '?',
    knew: '', bond: '',
  };
}

function fmtDate(d?: string) {
  if (!d) return '—';
  return d.replace(/-/g, '·');
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

export function YearbookCover(props: Props) {
  const friend = ensureFriend(props);
  const { year, caption, firstWordsDate } = props;
  const ref = useRef<HTMLDivElement>(null);
  const friendName = displayName(friend.id, friend.name);
  const yearNum = year.year ?? new Date().getFullYear();
  const total = year.msg_count ?? 0;
  const longest = year.longest_streak_days ?? null;
  const midnightHour = peakMidnightHour(year.heatmap_24x7);
  const midnightPct = year.midnight_friend_pct ?? null;
  const cap = caption || buildFallbackCaption(year, friendName);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <article
        ref={ref}
        className="et-paper-grain"
        aria-label="year cover"
        style={{
          width: 360,
          background: 'var(--et-paper)',
          border: '0.5px solid var(--et-line-2)',
          borderRadius: 18,
          boxShadow: 'var(--et-shadow-2)',
          padding: '32px 28px 28px',
          position: 'relative',
          overflow: 'hidden',
          fontFamily: 'var(--et-sans)',
        }}
      >
        <div
          style={{
            position: 'absolute', inset: 12,
            border: '0.5px solid var(--et-line)', borderRadius: 14, pointerEvents: 'none',
          }}
        />

        <div style={{ position: 'absolute', top: 18, right: 22, transform: 'rotate(-9deg)', zIndex: 2 }}>
          <Postmark size={72} text1="MURMUR · YEAR" text2="本地年度档" date={String(yearNum)} />
        </div>

        <div className="et-eyebrow" style={{ position: 'relative', zIndex: 1 }}>
          MURMUR · 年度档
        </div>
        <div
          className="et-num"
          style={{
            marginTop: 4, fontSize: 56, lineHeight: 1, color: 'var(--et-orange)',
            fontWeight: 700, letterSpacing: '-0.02em',
          }}
        >
          {yearNum}
        </div>

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar friend={friend} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="et-meta" style={{ fontSize: 11 }}>与</div>
            <div
              className="et-serif"
              style={{
                fontSize: 22, fontWeight: 600, color: 'var(--et-ink)',
                lineHeight: 1.2, marginTop: 1,
              }}
            >
              {friendName}
            </div>
          </div>
        </div>

        <div
          className="et-serif"
          style={{
            marginTop: 22,
            fontSize: 17,
            lineHeight: 1.55,
            color: 'var(--et-ink)',
            fontStyle: 'italic',
            paddingLeft: 12,
            borderLeft: '2px solid var(--et-orange)',
          }}
        >
          {cap}
        </div>

        <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column' }}>
          <CoverRow label="总消息" value={total ? total.toLocaleString() : '—'} unit="条" />
          <CoverRow label="第一次说话" value={fmtDate(firstWordsDate)} mono />
          <CoverRow
            label="最长连聊"
            value={longest != null ? String(longest) : '—'}
            unit={longest != null ? '天' : ''}
          />
          <CoverRow
            label="最深夜的时段"
            value={midnightHour != null ? String(midnightHour).padStart(2, '0') : '—'}
            unit={midnightHour != null ? ':00' : ''}
            sub={
              midnightPct != null
                ? `深夜里 ${friendName} 占 ${Math.round(midnightPct)}%`
                : undefined
            }
          />
        </div>

        <div
          style={{
            marginTop: 20,
            paddingTop: 16,
            borderTop: '0.5px dashed var(--et-line-2)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}
        >
          <div style={{ transform: 'rotate(-4deg)' }}>
            <Stamp label="LOCAL · ONLY" sub="不上云 · 仅你能看见" />
          </div>
          <div style={{ flex: 1 }}>
            <div className="et-meta" style={{ fontSize: 10, lineHeight: 1.5 }}>
              全部数据从本机聊天记录中读出。<br />
              不上传 · 不联网 · 仅你能看见。
            </div>
          </div>
        </div>

        <div
          className="et-num"
          style={{
            position: 'absolute', bottom: 16, right: 22,
            fontSize: 9, color: 'var(--et-mute)', letterSpacing: '0.16em',
          }}
        >
          NO. {String(friend.id).slice(-6).toUpperCase()}
        </div>
      </article>

      <div style={{ display: 'flex', gap: 8 }}>
        <CoverBtn label="保存为图片" icon={<Download size={13} />} onClick={() => doScreenshot(ref.current)} />
        <CoverBtn label="复制分享文案" icon={<Share size={13} />} onClick={() => copyShareText(friendName, yearNum, cap)} />
      </div>
    </div>
  );
}

function CoverRow({
  label, value, unit, sub, mono,
}: { label: string; value: string; unit?: string; sub?: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'baseline',
        gap: 12,
        padding: '10px 0',
        borderBottom: '0.5px solid var(--et-line)',
      }}
    >
      <div className="et-serif" style={{ fontSize: 12.5, color: 'var(--et-ink-soft)' }}>
        {label}
        {sub && (
          <div style={{ fontSize: 10.5, color: 'var(--et-mute)', marginTop: 1, fontFamily: 'var(--et-sans)' }}>
            {sub}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
        <span
          className={mono ? 'et-num' : 'et-num'}
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--et-ink)',
            letterSpacing: '-0.01em',
          }}
        >
          {value}
        </span>
        {unit && (
          <span className="et-serif" style={{ fontSize: 12, color: 'var(--et-mute)' }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function CoverBtn({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset', cursor: 'pointer',
        padding: '8px 14px', borderRadius: 8,
        background: 'var(--et-paper)', color: 'var(--et-ink)',
        border: '0.5px solid var(--et-line-2)',
        fontSize: 12, fontWeight: 600,
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}
    >
      <span style={{ display: 'inline-flex', color: 'var(--et-orange)' }}>{icon}</span>
      {label}
    </button>
  );
}

async function doScreenshot(node: HTMLElement | null) {
  if (!node) return;
  // Lazy-load html-to-image only if/when the user hits "save as image".
  // The import string lives behind a variable so vite's static analyzer
  // can't try to resolve it at build time — we want a runtime "package
  // not installed" failure (caught below), NOT a hard build error when
  // the optional dep isn't present in package.json.
  const pkgName = 'html-to-image';
  try {
    const mod: { toPng: (n: HTMLElement, opts?: Record<string, unknown>) => Promise<string> } =
      await import(/* @vite-ignore */ pkgName);
    const dataUrl = await mod.toPng(node, { pixelRatio: 2, backgroundColor: '#f5f3ec' });
    const a = document.createElement('a');
    a.download = `murmur-year-cover.png`;
    a.href = dataUrl;
    a.click();
  } catch (e) {
    console.warn('[YearbookCover] save-image failed (install html-to-image to enable)', e);
    alert('保存图片需要安装 html-to-image 依赖，或在浏览器中右键截图。');
  }
}

function copyShareText(friendName: string, year: number, caption: string) {
  const text = `${year} 年 · 与 ${friendName} —— ${caption}\n\n用 Murmur 本地分析，自己的微信记录自己读。`;
  navigator.clipboard.writeText(text).catch(() => {});
}
