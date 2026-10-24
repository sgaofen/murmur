import { togglePrivacyMode } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { cx } from '../ui';
import { IconEye, IconEyeOff } from '../ui/icons';

/** Privacy-mode row at the bottom of the app shell's left nav (styles live in
 * shell/shell.css). One click flips privacy mode; while it is on the row stays
 * tinted so nobody forgets it before or after a recording. */
export function PrivacyToggle({ collapsed = false }: { collapsed?: boolean }) {
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
      className={cx('app-nav__item', 'app-privacy', on && 'is-on', collapsed && 'is-icon')}
    >
      <span className="app-nav__icon">{on ? <IconEyeOff size={18} /> : <IconEye size={18} />}</span>
      <span className="app-nav__label">隐私模式</span>
      <span className="app-nav__trail">
        <span className={cx('app-switch', on && 'is-on')} aria-hidden="true" />
      </span>
    </button>
  );
}
