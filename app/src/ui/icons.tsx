// Icons used by the ui/ primitives. Same drawing rules as utils/icons.tsx
// (24px grid, 1.5px round stroke, currentColor) so they mix freely.
import type { ReactNode } from 'react';

export interface UiIconProps {
  size?: number;
  className?: string;
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Svg({ size = 16, className, children }: UiIconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}
      aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
      <g {...STROKE}>{children}</g>
    </svg>
  );
}

export function IconSun(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </Svg>
  );
}

export function IconMoon(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" />
    </Svg>
  );
}

export function IconSystem(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </Svg>
  );
}

export function IconInfoCircle(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconCheckCircle(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.3l2.7 2.7L16 9.5" />
    </Svg>
  );
}

export function IconWarning(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.5" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconAlertCircle(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <circle cx="12" cy="16.3" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconClose(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconCheck(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12.5L10 17l9-10" />
    </Svg>
  );
}

export function IconRefresh(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M4 12a8 8 0 0 1 14-5.3" />
      <path d="M14 4v3.5h3.5" />
      <path d="M20 12a8 8 0 0 1-14 5.3" />
      <path d="M10 20v-3.5H6.5" />
    </Svg>
  );
}

export function IconCopy(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="8" y="8" width="11" height="12" rx="1.5" />
      <path d="M5 16V5.5A1.5 1.5 0 0 1 6.5 4H15" />
    </Svg>
  );
}

export function IconInbox(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 13.5l2.6-7.2A1.5 1.5 0 0 1 7.5 5.3h9a1.5 1.5 0 0 1 1.4 1l2.6 7.2" />
      <path d="M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5h-5l-1.5 2.5h-4L8.5 13.5z" />
    </Svg>
  );
}

export function IconKey(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2" />
    </Svg>
  );
}

export function IconSparkle(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.5l1.7 5.3a2 2 0 0 0 1.3 1.3l5.3 1.7-5.3 1.7a2 2 0 0 0-1.3 1.3L12 20.5l-1.7-5.3a2 2 0 0 0-1.3-1.3L3.7 12.2l5.3-1.7a2 2 0 0 0 1.3-1.3z" />
    </Svg>
  );
}

// ——— app shell (sidebar nav, top bar, settings) ———

export function IconHome(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 10.5L12 4l8.5 6.5" />
      <path d="M6 9v10a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9" />
    </Svg>
  );
}

export function IconNetwork(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="5.5" r="2.5" />
      <circle cx="5.5" cy="17.5" r="2.5" />
      <circle cx="18.5" cy="17.5" r="2.5" />
      <path d="M10.8 7.7l-4 7.6M13.2 7.7l4 7.6M8 17.5h8" />
    </Svg>
  );
}

export function IconCalendar(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      <path d="M8 13.5h2M14 13.5h2M8 16.5h2" />
    </Svg>
  );
}

export function IconReport(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M8.5 12.5h7M8.5 16h5" />
    </Svg>
  );
}

export function IconTable(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" />
    </Svg>
  );
}

export function IconSearch(p: UiIconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  );
}

/** Settings, drawn as two sliders. */
export function IconSettings(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </Svg>
  );
}

export function IconEye(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function IconEyeOff(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.5 16.5 0 0 1-2.4 3.2" />
      <path d="M6.5 7.2C4 8.9 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.2-.5 4.5-1.2" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3.5 3.5l17 17" />
    </Svg>
  );
}

export function IconChevronLeft(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M14.5 6l-6 6 6 6" />
    </Svg>
  );
}

export function IconChevronsUpDown(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4" />
    </Svg>
  );
}

export function IconSidebarCollapse(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15M16 10l-2 2 2 2" />
    </Svg>
  );
}

export function IconSidebarExpand(p: UiIconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15M14 10l2 2-2 2" />
    </Svg>
  );
}

export function IconFolder(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z" />
    </Svg>
  );
}

export function IconPlay(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M8 5.5v13l10-6.5z" />
    </Svg>
  );
}

export function IconPause(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M9 5.5v13M15 5.5v13" />
    </Svg>
  );
}

export function IconPlus(p: UiIconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}
