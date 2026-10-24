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
