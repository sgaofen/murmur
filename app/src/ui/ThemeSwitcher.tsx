import type { ReactNode } from 'react';
import { SegmentedControl } from './SegmentedControl';
import { IconMoon, IconSun, IconSystem } from './icons';
import { THEME_MODES, useTheme } from './theme';
import type { ThemeMode } from './theme';

const ICONS: Record<ThemeMode, (size: number) => ReactNode> = {
  light: s => <IconSun size={s} />,
  dark: s => <IconMoon size={s} />,
  system: s => <IconSystem size={s} />,
};

/** 浅色 / 深色 / 跟随系统 picker. `compact` = icons only (floating dock). */
export function ThemeSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { mode, setMode } = useTheme();
  const iconSize = compact ? 14 : 15;
  return (
    <SegmentedControl
      label="外观"
      value={mode}
      onChange={setMode}
      size={compact ? 'sm' : 'md'}
      iconOnly={compact}
      className={className}
      options={THEME_MODES.map(({ mode: m, label }) => ({
        value: m,
        label,
        title: `外观：${label}`,
        icon: ICONS[m](iconSize),
      }))}
    />
  );
}
