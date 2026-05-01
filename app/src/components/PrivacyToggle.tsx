import { useEffect, useState } from 'react';
import { isPrivacyMode, togglePrivacyMode, subscribePrivacy } from '../utils/privacy';

/** A floating toggle button + a hook for components that want to react to changes. */
export function usePrivacy(): boolean {
  const [v, setV] = useState(isPrivacyMode());
  useEffect(() => subscribePrivacy(setV), []);
  return v;
}

/** Floating bottom-right pill — one click flips privacy mode on/off (and forces a re-render). */
export function PrivacyToggle({ position = 'bottom-right' }: { position?: 'bottom-right' | 'top-right' }) {
  const on = usePrivacy();
  const pos = position === 'top-right'
    ? { top: 16, right: 16 }
    : { bottom: 70, right: 16 };  // sit above the dev controls bar
  return (
    <button
      onClick={() => togglePrivacyMode()}
      title={on ? '关闭隐私模式 (展示真名)' : '开隐私模式 (脱敏，录视频用)'}
      style={{
        position: 'fixed', zIndex: 9999, ...pos,
        all: 'unset', cursor: 'pointer',
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
