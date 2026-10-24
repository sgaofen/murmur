import { togglePrivacyMode } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';

/** Privacy pill — one click flips privacy mode on/off. Rendered inside the
 * floating dock in App.tsx (next to the theme switcher). */
export function PrivacyToggle() {
  const on = usePrivacy();
  return (
    <button
      type="button"
      onClick={() => togglePrivacyMode()}
      aria-pressed={on}
      title={on ? '关闭隐私模式 (展示真名)' : '开隐私模式 (脱敏，录视频用)'}
      className={on ? 'ui-dock-btn is-on' : 'ui-dock-btn'}
    >
      {on ? '🔒 隐私模式：开' : '🔓 隐私模式：关'}
    </button>
  );
}
