/* ProfileSwitcher — collapsed pill + dropdown popover for switching the
 * active platform/account. Uses Murmur's real `app/src/tokens.css` palette
 * (cream paper + ink-blue + warm coral); QQ pages reuse `--et-sky` so the
 * magazine tone stays consistent.
 *
 * Mounts in every chrome bar (Home / Friend / Graph / Reports / Yearbook /
 * OfflineSignalsTable). The backend swaps `_MurmurAPIHandler.store` to a
 * QQStore when the user picks a QQ row, so every page that renders after
 * the reload reads QQ data through the same `EchoStore`-shape interface.
 */
import { useEffect, useRef, useState } from 'react';
import { switchActiveProfile, useProfiles } from '../utils/activeProfile';
import { usePrivacy } from '../utils/usePrivacy';
import type { ProfileEntry } from '../data/api';

/** Global signal so any ProfileSwitcher (mounted on any chrome bar) can ask
 * the App-level state to open the right onboarding dialog without prop drilling.
 * App.tsx listens for this and toggles setOnboarding / setQQOnboarding. */
function requestOnboarding(platform: 'wechat' | 'qq') {
  window.dispatchEvent(new CustomEvent('murmur:requestOnboarding', { detail: { platform } }));
}

export function ProfileSwitcher() {
  const { profiles, active, loading, error } = useProfiles();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

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
        />
      )}
    </div>
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
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        color: palette.fg,
        background: open ? palette.bgHover : palette.bg,
        border: `0.5px solid ${palette.border}`,
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

function PlatformGlyph({ platform }: { platform: 'wechat' | 'qq' }) {
  return <span style={{ fontSize: 12, lineHeight: 1 }}>{platform === 'wechat' ? '💬' : '🐧'}</span>;
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

function Popover({ profiles, activeId, onClose, anchorRef }: {
  profiles: ProfileEntry[];
  activeId: string;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const privacyOn = usePrivacy();

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

  return (
    <div ref={popRef} role="menu" style={popoverShell}>
      <div style={popoverHeader}>
        <span className="et-eyebrow">你的账号</span>
        <span className="et-eyebrow" style={{ letterSpacing: '0.08em', color: 'var(--et-faint)', fontSize: 9 }}>
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
      <div style={popoverFooter}>
        {!adding ? (
          <button type="button" onClick={() => setAdding(true)} style={addBtn}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--et-paper-2)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            <span style={{ fontSize: 14, lineHeight: 1, color: 'var(--et-faint)' }}>＋</span>
            <span>添加新账号</span>
          </button>
        ) : (
          <div style={{ padding: '10px 14px' }}>
            <div className="et-eyebrow" style={{ marginBottom: 8, fontSize: 9 }}>选择平台</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <PlatformPickButton
                glyph="💬" label="微信"
                onClick={() => { onClose(); requestOnboarding('wechat'); }}
              />
              <PlatformPickButton
                glyph="🐧" label="QQ"
                onClick={() => { onClose(); requestOnboarding('qq'); }}
              />
            </div>
            <button type="button" onClick={() => setAdding(false)}
              style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-faint)',
                       fontSize: 10.5, marginTop: 6, padding: 2 }}>
              ← 返回
            </button>
          </div>
        )}
      </div>
    </div>
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
      tabIndex={0}
      onClick={onClick}
      onMouseEnter={() => onHover(p.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        position: 'relative',
        display: 'flex',
        gap: 11,
        padding: '10px 14px 11px',
        borderBottom: isLast ? 'none' : '0.5px solid var(--et-line)',
        cursor: p.state === 'extracting' ? 'wait' : 'pointer',
        opacity: dim ? 0.6 : 1,
        background: isActive ? palette.bg : (hover ? 'var(--et-paper-2)' : 'transparent'),
        transition: 'background 120ms ease',
      }}
    >
      {isActive && (
        <div style={{
          position: 'absolute', left: 0, top: 6, bottom: 6, width: 3,
          background: palette.fg, borderRadius: '0 2px 2px 0',
        }} />
      )}
      <div style={{ flexShrink: 0, width: 22, paddingTop: 2,
                     display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <span style={{ fontSize: 15, lineHeight: 1 }}>{isWeChat ? '💬' : '🐧'}</span>
        {isActive && (
          <span style={{ fontSize: 9, color: palette.fg, lineHeight: 1, marginTop: 2 }}>✓</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <span style={{
            fontFamily: monoStack,
            fontSize: 12.5,
            color: dim ? 'var(--et-mute)' : 'var(--et-ink)',
            fontWeight: isActive ? 600 : 500,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>{display}</span>
          <span style={{
            fontSize: 10.5, color: 'var(--et-mute)', flexShrink: 0,
            fontFamily: 'var(--et-serif)', fontStyle: 'italic',
          }}>{humaniseLast(p.last_active_ts)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                       marginTop: 3, fontSize: 11, color: 'var(--et-mute)' }}>
          {p.state === 'ready' && (
            <span><span className="et-num" style={{ color: 'var(--et-ink-soft)' }}>
              {p.n_sessions.toLocaleString()}
            </span> 个对话</span>
          )}
          {p.state === 'needs_decrypt' && (
            <span style={{ color: 'var(--et-rose)', fontStyle: 'italic',
                            fontFamily: 'var(--et-serif)' }}>未解密 · 点击设置</span>
          )}
          {p.state === 'needs_key' && (
            <span style={{ color: 'var(--et-rose)', fontStyle: 'italic',
                            fontFamily: 'var(--et-serif)' }}>缺少密钥 · 点击引导</span>
          )}
          {p.state === 'extracting' && (
            <span style={{ fontStyle: 'italic', fontFamily: 'var(--et-serif)' }}>正在提取密钥…</span>
          )}
        </div>
      </div>
    </div>
  );
}

function PlatformPickButton({ glyph, label, onClick }:
  { glyph: string; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center',
        gap: 8, padding: '10px 12px', background: 'var(--et-paper)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r-sm)',
        fontSize: 12, color: 'var(--et-ink)',
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--et-paper-2)'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'var(--et-paper)'}>
      <span style={{ fontSize: 16 }}>{glyph}</span>
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

const monoStack = '"JetBrains Mono", "SF Mono", ui-monospace, "Sarasa Mono SC", monospace';

const wechatPalette = {
  fg: 'var(--et-orange-2)',
  bg: 'var(--et-orange-soft)',
  bgHover: 'rgba(255,107,71,0.18)',
  border: 'rgba(224, 83, 46, 0.18)',
};
const qqPalette = {
  fg: '#3a6c8c',
  bg: 'rgba(90, 122, 153, 0.10)',
  bgHover: 'rgba(90, 122, 153, 0.20)',
  border: 'rgba(90, 122, 153, 0.22)',
};

const addOnlyChip: React.CSSProperties = {
  all: 'unset', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '5px 10px', borderRadius: 999,
  fontSize: 11, fontWeight: 500, color: 'var(--et-mute)',
  background: 'transparent', border: '0.5px solid var(--et-line-2)',
};

const popoverShell: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 200,
  width: 270, background: 'var(--et-paper)',
  border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
  boxShadow: 'var(--et-shadow-2)', overflow: 'hidden',
};
const popoverHeader: React.CSSProperties = {
  padding: '11px 14px 8px',
  borderBottom: '0.5px solid var(--et-line)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
};
const popoverFooter: React.CSSProperties = {
  borderTop: '0.5px solid var(--et-line-2)', background: 'var(--et-paper-2)',
};
const addBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', display: 'flex', width: '100%',
  alignItems: 'center', gap: 9, padding: '10px 14px',
  color: 'var(--et-mute)', fontSize: 12,
  boxSizing: 'border-box',
};
