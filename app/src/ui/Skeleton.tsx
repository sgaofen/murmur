import type { CSSProperties } from 'react';
import { cx } from './cx';

export interface SkeletonProps {
  /** Any CSS length; numbers are px. Default 100%. */
  width?: number | string;
  /** Any CSS length; numbers are px. Default 1em (one text line). */
  height?: number | string;
  /** Circle (avatars). Uses `width` for both sides. */
  circle?: boolean;
  /** Corner radius override; numbers are px. */
  radius?: number | string;
  className?: string;
}

/** Placeholder block with a soft shimmer. Purely decorative (aria-hidden). */
export function Skeleton({ width, height, circle, radius, className }: SkeletonProps) {
  // Sizes are data, not styling — passed as custom properties read by ui.css.
  const vars = {
    '--sk-w': toLen(width),
    '--sk-h': toLen(circle ? width : height),
    '--sk-r': toLen(radius),
  } as CSSProperties;
  return <span className={cx('ui-skeleton', circle && 'ui-skeleton--circle', className)} style={vars} aria-hidden="true" />;
}

/** A paragraph of skeleton lines; the last one is shorter. */
export function SkeletonText({ lines = 3, lastLineWidth = '62%', className }: { lines?: number; lastLineWidth?: string; className?: string }) {
  return (
    <span className={cx('ui-skeleton-text', className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? lastLineWidth : undefined} />
      ))}
    </span>
  );
}

function toLen(v: number | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'number' ? `${v}px` : v;
}
