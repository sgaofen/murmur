/* Small pieces shared by the chat page (#/chat/…) and the search page
 * (#/search): keyword highlighting, message-type labels, date helpers and a
 * few message-type icons. Icons follow ui/icons.tsx drawing rules (24 grid,
 * 1.5 stroke, currentColor). Styles for .chat-mark live in pages/Chat.css. */
import type { ReactNode } from 'react';
import type { UiIconProps } from '../ui/icons';

// ——— keywords ———

/** Same split rule as the backend (search_index.split_terms): whitespace, de-duplicated. */
export function splitTerms(q: string | null | undefined): string[] {
  const out: string[] = [];
  for (const t of (q || '').split(/\s+/)) {
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Text with every (case-insensitive) occurrence of `terms` wrapped in <mark>. */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const ts = terms.filter(Boolean);
  if (!ts.length || !text) return <>{text}</>;
  const rx = new RegExp(`(${ts.sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(rx);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="chat-mark">{p}</mark> : p))}
    </>
  );
}

// ——— message types ———

export const TYPE_LABEL: Record<string, string> = {
  text: '文字',
  image: '图片',
  video: '视频',
  voice: '语音',
  emoji: '表情',
  card: '名片',
  location: '位置',
  share: '分享',
  voip: '通话',
  video_call: '视频通话',
  system: '系统消息',
  revoke: '撤回',
};

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? '消息';
}

/** True when `text` is only the backend's "[type]" stub (no real content). */
export function isStub(text: string, type: string): boolean {
  const t = (text || '').trim();
  return !t || t === `[${type}]` || /^\[type_\d+\]$/.test(t);
}

/** `[链接] 标题 — 描述` → { label, body }; null when the text has no such prefix. */
export function splitShare(text: string): { label: string; body: string } | null {
  const m = /^\[([^\]\s：:]{1,6})\]\s*([\s\S]*)$/.exec(text || '');
  return m ? { label: m[1], body: m[2] } : null;
}

/** `[引用 名字：被引用的话] 回复` → parts; null when not a quote. */
export function splitQuote(text: string): { who: string; quoted: string; reply: string } | null {
  const m = /^\[引用(?:\s+([^：\]]*))?：([\s\S]*?)\]\s*([\s\S]*)$/.exec(text || '');
  return m ? { who: m[1] || '', quoted: m[2], reply: m[3] } : null;
}

// ——— dates (backend times are ISO strings in China time, +08:00) ———

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "2024-03-02" → "2024年3月2日 周六" */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${y}年${m}月${d}日 ${WEEKDAYS[wd]}`;
}

/** ISO time → "2024-03-02" (its own calendar day, not the viewer's timezone). */
export function dayOf(iso: string): string {
  return (iso || '').slice(0, 10);
}

/** ISO time → "14:05" */
export function clockOf(iso: string): string {
  return (iso || '').slice(11, 16);
}

/** Unix seconds → "YYYY-MM-DD" in China time (matches backend dates). */
export function dayFromTs(ts: number): string {
  return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

// ——— icons ———

function Svg({ size = 16, className, children }: UiIconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}
      aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
      <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  );
}

export function IconImage(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M20.5 16l-5-5-8.5 8.5" />
    </Svg>
  );
}

export function IconVideo(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10.5l5-3v9l-5-3z" />
    </Svg>
  );
}

export function IconMic(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </Svg>
  );
}

export function IconLink(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  );
}

export function IconQuote(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M5 18V12.5C5 9 7 7 10 6.5M14 18v-5.5C14 9 16 7 19 6.5" />
    </Svg>
  );
}

export function IconSmile(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14a4.2 4.2 0 0 0 7 0" />
      <circle cx="9.3" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="10" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconPin(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </Svg>
  );
}

export function IconPhone(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7L16 13l4 1.5v3A2 2 0 0 1 18 19.5 15.5 15.5 0 0 1 4.5 6 2 2 0 0 1 6.5 4z" />
    </Svg>
  );
}

export function IconUser(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5a7 7 0 0 1 14 0" />
    </Svg>
  );
}

export function IconMessage(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5h0a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

export function IconArrowDown(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Svg>
  );
}

export function IconCalendarJump(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4M10 15h5M13 13l2 2-2 2" />
    </Svg>
  );
}

/** Icon for a message type label (image / voice / share …). */
export function TypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  switch (type) {
    case 'image': return <IconImage size={size} />;
    case 'video':
    case 'video_call': return <IconVideo size={size} />;
    case 'voice': return <IconMic size={size} />;
    case 'emoji': return <IconSmile size={size} />;
    case 'location': return <IconPin size={size} />;
    case 'voip': return <IconPhone size={size} />;
    case 'card': return <IconUser size={size} />;
    case 'share': return <IconLink size={size} />;
    default: return <IconMessage size={size} />;
  }
}
