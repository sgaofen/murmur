import { togglePrivacyMode } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { cx } from '../ui';

/** Privacy-mode switch in the shell's status strip: an LED plus "PRIV ON /
 * PRIV OFF" (styles in shell/shell.css). One click flips privacy mode; while
 * it is on the LED is lit and the label turns full-strength, so nobody
 * forgets it before or after a recording. */
export function PrivacyToggle({ compact = false }: { compact?: boolean }) {
  const on = usePrivacy();
  const hint = on
    ? '隐私模式已开启：名字、wxid、本机路径都已脱敏。点击关闭'
    : '开启隐私模式：录屏 / 截图前把名字、wxid、本机路径脱敏';
  return (
    <button
      type="button"
      onClick={() => togglePrivacyMode()}
      aria-pressed={on}
      aria-label="隐私模式"
      title={hint}
      className={cx('app-strip__stat', 'app-strip__toggle', on && 'is-on')}
    >
      <i className={cx('ui-led', !on && 'is-off')} aria-hidden="true" />
      <span>PRIV</span>
      {!compact && <span className="app-strip__stat-v">{on ? 'ON' : 'OFF'}</span>}
    </button>
  );
}
