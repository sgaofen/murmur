// Onboarding-only icons, drawn on the same grid as ui/icons.tsx
// (24px, 1.5 stroke, currentColor).
import type { UiIconProps } from '../ui/icons';

export function IconLock({ size = 16, className }: UiIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}
      aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
      <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.5v2" />
      </g>
    </svg>
  );
}
