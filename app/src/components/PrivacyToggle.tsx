import { togglePrivacyMode } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';

/** Floating bottom-right pill — one click flips privacy mode on/off. */
export function PrivacyToggle({ position = 'bottom-right' }: { position?: 'bottom-right' | 'top-right' }) {
  const on = usePrivacy();
  const pos = position === 'top-right'
    ? { top: 16, right: 16 }
    : { bottom: 16, right: 16 };
  return (
    <button
      onClick={() => togglePrivacyMode()}
      title={on ? '关闭隐私模式 (展示真名)' : '开隐私模式 (脱敏，录视频用)'}
      style={{
        all: 'unset',
        position: 'fixed', zIndex: 9999, ...pos,
        cursor: 'pointer',
        padding: '6px 12px', borderRadius: 999,
        background: on ? '#1A2B4A' : 'rgba(255,255,255,0.92)',
        color: on ? '#FFE6CF' : '#5A7A99',
        border: `1px solid ${on ? '#1A2B4A' : 'rgba(26,43,74,0.18)'}`,
        boxShadow: '0 2px 12px rgba(20,24,42,0.18)',
        fontSize: 11, fontWeight: 600,
        backdropFilter: 'blur(6px)',
      }}>
      {on ? '🔒 隐私模式：开' : '🔓 隐私模式：关'}
    </button>
  );
}
