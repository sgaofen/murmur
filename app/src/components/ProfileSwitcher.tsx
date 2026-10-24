/* ProfileSwitcher — trigger + popover for switching the active
 * platform/account. Colors are the semantic tokens in `app/src/tokens.css`,
 * so the popover follows the light / dark theme. Platforms are marked with a
 * mono code square (WX / QQ), not emoji.
 *
 * Two looks: `variant="bar"` is the account key at the right end of the app
 * shell's bottom key bar (opens upwards); the default `chip` is a compact
 * inline trigger. The popover is portaled to <body> so it is never clipped
 * or covered by the shell's stacking contexts.
 *
 * The backend swaps `_MurmurAPIHandler.store` to a QQStore when the user
 * picks a QQ row, so every page that renders after the reload reads QQ data
 * through the same `EchoStore`-shape interface.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supportsQQOnboarding, switchActiveProfile, useProfiles } from '../utils/activeProfile';
import { usePrivacy } from '../utils/usePrivacy';
import type { ProfileEntry } from '../data/api';
import { Skeleton, cx } from '../ui';
import { IconChevronsUpDown } from '../ui/icons';

/** Global signal so any ProfileSwitcher can ask the App-level state to open
 * the right onboarding dialog without prop drilling.
 * App.tsx listens for this and toggles setOnboarding / setQQOnboarding. */
function requestOnboarding(platform: 'wechat' | 'qq') {
  window.dispatchEvent(new CustomEvent('murmur:requestOnboarding', { detail: { platform } }));
}

type Placement = 'below' | 'above' | 'right';

export function ProfileSwitcher({ variant = 'chip', compact = false }: {
  variant?: 'chip' | 'bar';
  /** Bar only: code square + caret, no account name (narrow windows). */
  compact?: boolean;
} = {}) {
  const { profiles, active, loading, error } = useProfiles();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const placement: Placement = variant === 'chip' ? 'below' : 'above';

  if (variant === 'bar') {
    if (loading && !profiles) {
      return (
        <span className="app-key app-account is-loading" aria-busy="true" aria-label="正在读取账号">
          <Skeleton width={16} height={16} />
          {!compact && <Skeleton width={84} height={9} />}
        </span>
      );
    }
    if (error || !profiles || profiles.length === 0) {
      return (
        <button type="button" className="app-key" onClick={() => requestOnboarding('wechat')}
          title="添加账号" aria-label="添加账号">
          <kbd className="ui-kbd" aria-hidden="true">＋</kbd>
          {!compact && <span>添加账号</span>}
        </button>
      );
    }
    const current = profiles.find(p => p.is_active) ?? profiles[0];
    return (
      <div ref={anchorRef} className="app-account-anchor">
        <BarAccountButton profile={current} count={profiles.length} open={open}
          compact={compact} onClick={() => setOpen(o => !o)} />
        {open && (
          <Popover
            profiles={profiles}
            activeId={active?.id ?? current.id}
            onClose={() => setOpen(false)}
            anchorRef={anchorRef}
            placement={placement}
          />
        )}
      </div>
    );
  }

  if (loading || error || !profiles || profiles.length === 0) {
    // Single-account installs (the common case before QQ is added) collapse to
    // an "+ add account" affordance only — surfaces the QQ flow without
    // pretending there's anything to switch.
    return (
      <button
        type="button"
        onClick={() => requestOnboarding('wechat')}
        title="添加账号"
        style={addOnlyChip}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>＋</span>
        <span>添加账号</span>
      </button>
    );
  }

  const activeProfile = profiles.find(p => p.is_active) ?? profiles[0];

  return (
    <div ref={anchorRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <CollapsedChip profile={activeProfile} open={open} onClick={() => setOpen(o => !o)} />
      {open && (
        <Popover
          profiles={profiles}
          activeId={active?.id ?? activeProfile.id}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          placement={placement}
        />
      )}
    </div>
  );
}

// ---------- bottom key bar (app shell) ----------

function BarAccountButton({ profile, count, open, compact, onClick }: {
  profile: ProfileEntry; count: number; open: boolean; compact: boolean; onClick: () => void;
}) {
  const privacyOn = usePrivacy();
  const platformLabel = profile.platform === 'wechat' ? '微信' : 'QQ';
  const display = privacyOn ? profile.display_id : displayPlain(profile);
  const meta = count > 1 ? `共 ${count} 个账号` : '切换或添加账号';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={`当前${platformLabel}账号 ${display}，点击切换`}
      title={`${platformLabel}：${display} · ${meta}`}
      className={cx('app-key', 'app-account', open && 'is-open')}
    >
      <PlatformGlyph platform={profile.platform} />
      {!compact && <span className="app-account__name">{display}</span>}
      {!compact && count > 1 && <span className="app-account__meta">×{count}</span>}
      <span className="app-account__caret" aria-hidden="true"><IconChevronsUpDown size={12} /></span>
    </button>
  );
}

// ---------- collapsed chip ----------

function CollapsedChip({ profile, open, onClick }: {
  profile: ProfileEntry; open: boolean; onClick: () => void;
}) {
  const privacyOn = usePrivacy();
  const isWeChat = profile.platform === 'wechat';
  const palette = isWeChat ? wechatPalette : qqPalette;
  const display = privacyOn ? profile.display_id : displayPlain(profile);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      title={isWeChat ? '当前微信账号 — 点击切换' : '当前 QQ 账号 — 点击切换'}
      style={{
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        padding: '5px 10px',
        height: 26,
        boxSizing: 'border-box',
        borderRadius: 'var(--radius-md)',
        fontSize: 11,
        fontWeight: 500,
        color: palette.fg,
        background: open ? palette.bgHover : palette.bg,
        border: `1px solid ${palette.border}`,
        whiteSpace: 'nowrap',
        transition: 'background 120ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = palette.bgHover; }}
      onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = palette.bg; }}
    >
      <PlatformGlyph platform={profile.platform} />
      <span style={{ fontFamily: monoStack, letterSpacing: '0.01em' }}>{display}</span>
      <Caret open={open} color={palette.fg} />
    </button>
  );
}

function PlatformGlyph({ platform, solid = false }: { platform: 'wechat' | 'qq'; solid?: boolean }) {
  return (
    <span className={cx('ui-tsq', 'app-account__code', solid && 'is-solid')} aria-hidden="true">
      {platform === 'wechat' ? 'WX' : 'QQ'}
    </span>
  );
}

function Caret({ open, color }: { open: boolean; color: string }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" style={{
      transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms ease',
      marginLeft: 1, opacity: 0.85,
    }}>
      <path d="M2 3.5 L5 6.5 L8 3.5" stroke={color} strokeWidth="1.4" fill="none"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- popover ----------

/** Fixed-position coordinates for the portaled popover, next to its anchor. */
function popoverPosition(anchor: DOMRect, placement: Placement): React.CSSProperties {
  const gap = 8;
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - POPOVER_WIDTH - margin);
  if (placement === 'right') {
    return {
      left: Math.min(anchor.right + gap, maxLeft),
      bottom: Math.max(margin, window.innerHeight - anchor.bottom),
    };
  }
  const left = Math.min(Math.max(margin, anchor.left), maxLeft);
  if (placement === 'above') return { left, bottom: window.innerHeight - anchor.top + gap };
  return { left, top: anchor.bottom + gap };
}

function Popover({ profiles, activeId, onClose, anchorRef, placement }: {
  profiles: ProfileEntry[];
  activeId: string;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  placement: Placement;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const privacyOn = usePrivacy();
  const qqSupported = supportsQQOnboarding();
  const focusedOnce = useRef(false);
  const focusInside = useRef(false);

  const menuItems = () =>
    Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Keyboard: the menu is portaled to <body>, so Tab from the trigger would
  // never reach it. Move focus to the first item once it is placed…
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    menuItems()[0]?.focus({ preventScroll: true });
  }, [pos]);

  // …and hand it back to the trigger when the menu closes (Esc, Tab, a pick).
  useEffect(() => {
    const anchor = anchorRef.current;
    return () => {
      const a = document.activeElement;
      if (focusInside.current || !a || a === document.body) {
        anchor?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
      }
    };
  }, [anchorRef]);

  // Swapping 「添加新账号」 for the platform buttons removes the focused node:
  // keep focus in the footer (first platform button, or 「添加新账号」 again).
  const footerRef = useRef<HTMLDivElement>(null);
  const addingSeen = useRef(false);
  useEffect(() => {
    if (!addingSeen.current) { addingSeen.current = true; return; }
    footerRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [adding]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const list = menuItems();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      // Menu pattern: Tab leaves the menu (focus returns to the trigger).
      e.preventDefault();
      onClose();
    }
  };

  // Track the anchor while open (window resize, page scroll, nav collapse).
  useLayoutEffect(() => {
    const place = () => {
      const el = anchorRef.current;
      if (el) setPos(popoverPosition(el.getBoundingClientRect(), placement));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef, placement]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorRef]);

  const handleRowClick = async (p: ProfileEntry) => {
    if (busy) return;
    if (p.state === 'needs_decrypt' || p.state === 'needs_key') {
      onClose();
      requestOnboarding(p.platform);
      return;
    }
    if (p.state === 'extracting') return;
    if (p.id === activeId) { onClose(); return; }
    setBusy(true);
    try {
      await switchActiveProfile({ platform: p.platform, id: idForBackend(p) });
      onClose();
    } catch (e) {
      setBusy(false);
      alert('切换失败：' + (e as Error).message);
    }
  };

  return createPortal(
    <div ref={popRef} role="menu" aria-label="切换账号" className="app-account-menu"
      onKeyDown={onMenuKeyDown}
      onFocus={() => { focusInside.current = true; }}
      onBlur={(e) => { focusInside.current = !!popRef.current?.contains(e.relatedTarget as Node | null); }}
      style={{ ...popoverShell, ...pos, visibility: pos ? 'visible' : 'hidden' }}>
      <div style={popoverHeader}>
        <span className="et-eyebrow">你的账号</span>
        <span className="et-eyebrow" style={{ letterSpacing: '0.08em', color: 'var(--text-faint)', fontSize: 9 }}>
          {profiles.length} · murmur
        </span>
      </div>
      <div>
        {profiles.map((p, i) => (
          <ProfileRow
            key={p.id}
            p={p}
            isActive={p.id === activeId}
            isLast={i === profiles.length - 1}
            hover={hoverId === p.id}
            privacyOn={privacyOn}
            onHover={setHoverId}
            onClick={() => handleRowClick(p)}
          />
        ))}
      </div>
      <div ref={footerRef} style={popoverFooter}>
        {!adding ? (
          <button type="button" role="menuitem" onClick={() => setAdding(true)} style={addBtn}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-sunken)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            <kbd className="ui-kbd" aria-hidden="true">＋</kbd>
            <span>添加新账号</span>
          </button>
        ) : (
          <div style={{ padding: '10px 14px' }}>
            <div className="et-eyebrow" style={{ marginBottom: 8, fontSize: 9 }}>选择平台</div>
            <div style={{ display: 'grid', gridTemplateColumns: qqSupported ? '1fr 1fr' : '1fr', gap: 8 }}>
              <PlatformPickButton
                platform="wechat" label="微信"
                onClick={() => { onClose(); requestOnboarding('wechat'); }}
              />
              {qqSupported && (
                <PlatformPickButton
                  platform="qq" label="QQ"
                  onClick={() => { onClose(); requestOnboarding('qq'); }}
                />
              )}
            </div>
            <button type="button" role="menuitem" onClick={() => setAdding(false)}
              style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-faint)',
                       fontSize: 10.5, marginTop: 6, padding: 2 }}>
              ← 返回
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ProfileRow({ p, isActive, isLast, hover, privacyOn, onHover, onClick }: {
  p: ProfileEntry; isActive: boolean; isLast: boolean; hover: boolean;
  privacyOn: boolean; onHover: (id: string | null) => void; onClick: () => void;
}) {
  const isWeChat = p.platform === 'wechat';
  const palette = isWeChat ? wechatPalette : qqPalette;
  const dim = p.state === 'needs_decrypt' || p.state === 'needs_key';
  const display = privacyOn ? p.display_id : displayPlain(p);

  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-current={isActive || undefined}
      aria-disabled={p.state === 'extracting' || undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
      onMouseEnter={() => onHover(p.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        position: 'relative',
        display: 'flex',
        gap: 11,
        padding: '10px 14px 11px',
        borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)',
        cursor: p.state === 'extracting' ? 'wait' : 'pointer',
        opacity: dim ? 0.6 : 1,
        background: isActive ? palette.bg : (hover ? 'var(--surface-sunken)' : 'transparent'),
        transition: 'background 120ms ease',
      }}
    >
      {isActive && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 2,
          background: 'var(--signal)',
        }} />
      )}
      <div style={{ flexShrink: 0, width: 22, paddingTop: 2,
                     display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <PlatformGlyph platform={p.platform} solid={isActive} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <span style={{
            fontFamily: monoStack,
            fontSize: 12.5,
            color: dim ? 'var(--text-muted)' : 'var(--text-primary)',
            fontWeight: isActive ? 600 : 500,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>{display}</span>
          <span style={{
            fontSize: 10.5, color: 'var(--text-faint)', flexShrink: 0,
            fontFamily: 'var(--font-mono)',
          }}>{humaniseLast(p.last_active_ts)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                       marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>
          {p.state === 'ready' && (
            <span><span className="et-num" style={{ color: 'var(--text-secondary)' }}>
              {p.n_sessions.toLocaleString()}
            </span> 个对话</span>
          )}
          {p.state === 'needs_decrypt' && (
            <span style={{ color: 'var(--danger-fg)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>未解密 · 点击设置</span>
          )}
          {p.state === 'needs_key' && (
            <span style={{ color: 'var(--danger-fg)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>缺少密钥 · 点击引导</span>
          )}
          {p.state === 'extracting' && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>正在提取密钥…</span>
          )}
        </div>
      </div>
    </div>
  );
}

function PlatformPickButton({ platform, label, onClick }:
  { platform: 'wechat' | 'qq'; label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      style={{
        all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center',
        gap: 8, padding: '8px 10px', background: 'var(--surface-card)',
        border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
        fontSize: 12, color: 'var(--text-primary)',
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-sunken)'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface-card)'}>
      <PlatformGlyph platform={platform} />
      <span>{label}</span>
    </button>
  );
}

// ---------- helpers ----------

function displayPlain(p: ProfileEntry): string {
  // Prefer the nickname pulled from xwechat_files/all_users/config/global_config
  // (decoded by cli/global_config.py) — friendlier than the bare wxid.
  if (p.nick_name && p.nick_name.trim()) return p.nick_name.trim();
  if (p.platform === 'qq' && p.qq_number) return `QQ ${p.qq_number}`;
  return p.id;
}

function humaniseLast(ts: number | null | undefined): string {
  if (ts == null || ts === 0) return '—';
  const now = Date.now() / 1000;
  const dt = now - ts;
  if (dt < 60) return '刚刚';
  if (dt < 3600) return `${Math.floor(dt / 60)} 分钟前`;
  if (dt < 86400) return '今天';
  if (dt < 86400 * 2) return '昨天';
  if (dt < 86400 * 7) return `${Math.floor(dt / 86400)} 天前`;
  if (dt < 86400 * 30) return `${Math.floor(dt / 86400 / 7)} 周前`;
  if (dt < 86400 * 365) return `${Math.floor(dt / 86400 / 30)} 个月前`;
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function idForBackend(p: ProfileEntry): string {
  // wechat: backend stores by wxid; qq: backend stores by qq_number
  if (p.platform === 'qq') return p.qq_number || p.id.replace(/^qq:/, '');
  return p.id;
}

// ---------- palette + style constants ----------

const monoStack = 'var(--font-mono)';

// Both platforms share the instrument greys; the active row is marked by the
// signal rule and the filled code square, not by a platform colour.
const wechatPalette = {
  fg: 'var(--text-primary)',
  bg: 'var(--signal-dim)',
  bgHover: 'var(--surface-pressed)',
  border: 'var(--border-default)',
};
const qqPalette = wechatPalette;

const addOnlyChip: React.CSSProperties = {
  all: 'unset', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '4px 9px', borderRadius: 'var(--radius-md)',
  fontSize: 11, fontWeight: 500, color: 'var(--text-muted)',
  background: 'transparent', border: '1px solid var(--border-default)',
};

const POPOVER_WIDTH = 270;

// Portaled to <body>; coordinates come from popoverPosition(). Sits above the
// app shell (nav 40 / top bar 30 / full-bleed pages 45) but below dialogs.
const popoverShell: React.CSSProperties = {
  position: 'fixed', zIndex: 300,
  width: POPOVER_WIDTH, maxWidth: 'calc(100vw - 16px)', background: 'var(--surface-raised)',
  border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-md)', overflow: 'hidden',
};
const popoverHeader: React.CSSProperties = {
  padding: '10px 14px 9px',
  borderBottom: '1px solid var(--border-subtle)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
};
const popoverFooter: React.CSSProperties = {
  borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-sunken)',
};
const addBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', display: 'flex', width: '100%',
  alignItems: 'center', gap: 9, padding: '10px 14px',
  color: 'var(--text-muted)', fontSize: 12,
  boxSizing: 'border-box',
};
