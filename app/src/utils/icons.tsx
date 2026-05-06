// Linear 1.5px-stroke SVG icons. Replaces emoji throughout the AI analysis
// surface (drawer, report timeline, banner). Adopted from Claude Design's
// `demo/src/icons.jsx` but rewritten as proper React exports — the original
// hung everything off `window.Icons` for demo glue, which we don't want in a
// real codebase. No external dep (lucide-react etc. — explicitly off-budget).

import * as React from 'react';

interface Props {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Svg({ size = 16, className, style, children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      {children}
    </svg>
  );
}

// ——— vendor agent icons ———

export function IconClaude(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M5 14c2 -5 5 -8 7 -8s5 3 7 8" />
        <path d="M7.5 17c1.5 -4 3 -6 4.5 -6s3 2 4.5 6" />
        <circle cx="12" cy="11" r="0.7" fill="currentColor" stroke="none" />
      </g>
    </Svg>
  );
}

export function IconCodex(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M9 8l-4 4 4 4" />
        <path d="M15 8l4 4 -4 4" />
        <path d="M5 19h14" opacity="0.5" />
      </g>
    </Svg>
  );
}

export function IconGeneric(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <rect x="4" y="6" width="16" height="13" rx="1.5" />
        <path d="M4 8l8 6 8 -6" />
      </g>
    </Svg>
  );
}

// ——— stage icons ———

export function IconRead(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M4 6c2 -1 5 -1 8 0v13c-3 -1 -6 -1 -8 0z" />
        <path d="M20 6c-2 -1 -5 -1 -8 0v13c3 -1 6 -1 8 0z" />
      </g>
    </Svg>
  );
}

export function IconExtract(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M4 5h16l-6 8v6l-4 -2v-4z" />
      </g>
    </Svg>
  );
}

export function IconEvidence(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3.5" />
        <path d="M9 19l1 -2M14 19l1 -2M5 9l1.6 -.6M17.4 8.4L19 9" opacity="0.6" />
      </g>
    </Svg>
  );
}

export function IconPortrait(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <circle cx="12" cy="10" r="2.6" />
        <path d="M7 17c1 -2.5 3 -3.5 5 -3.5s4 1 5 3.5" />
      </g>
    </Svg>
  );
}

export function IconForecast(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M4 16l4 -5 4 3 5 -8" />
        <path d="M14 6h3v3" />
      </g>
    </Svg>
  );
}

// ——— UI controls ———

export function IconCheck(p: Props) {
  return (
    <Svg {...p}>
      <path d="M5 12.5L10 17l9 -10" {...STROKE} />
    </Svg>
  );
}

export function IconX(p: Props) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" {...STROKE} />
    </Svg>
  );
}

export function IconArrowRight(p: Props) {
  return (
    <Svg {...p}>
      <path d="M5 12h14M14 6l6 6 -6 6" {...STROKE} />
    </Svg>
  );
}

export function IconArrowLeft(p: Props) {
  return (
    <Svg {...p}>
      <path d="M19 12H5M10 6l-6 6 6 6" {...STROKE} />
    </Svg>
  );
}

export function IconDot(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconRefresh(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M4 12a8 8 0 0114 -5.3" />
        <path d="M14 4v3.5h3.5" />
        <path d="M20 12a8 8 0 01-14 5.3" />
        <path d="M10 20v-3.5H6.5" />
      </g>
    </Svg>
  );
}

export function IconCopy(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <rect x="8" y="8" width="11" height="12" rx="1.5" />
        <path d="M5 16V5.5A1.5 1.5 0 016.5 4H15" />
      </g>
    </Svg>
  );
}

export function IconFolder(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M4 7.5C4 6.7 4.7 6 5.5 6h4l1.5 2h7.5c.8 0 1.5 .7 1.5 1.5V18c0 .8 -.7 1.5 -1.5 1.5h-13C4.7 19.5 4 18.8 4 18z" />
      </g>
    </Svg>
  );
}

export function IconShield(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M12 4l7 3v6c0 4 -3 6.5 -7 7c-4 -.5 -7 -3 -7 -7V7z" />
      </g>
    </Svg>
  );
}

export function IconDownload(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M12 4v11M7 11l5 5 5 -5" />
        <path d="M5 19h14" />
      </g>
    </Svg>
  );
}

// ——— extra icons used by Round 2 deliverables ———

export function IconQuote(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M7 8c-2 0 -3 1.5 -3 3v3h4v-3H6c0 -1 1 -1.5 2 -1.5z" />
        <path d="M16 8c-2 0 -3 1.5 -3 3v3h4v-3h-2c0 -1 1 -1.5 2 -1.5z" />
      </g>
    </Svg>
  );
}

export function IconShare(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <circle cx="6" cy="12" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="18" cy="18" r="2" />
        <path d="M8 11l8 -4M8 13l8 4" />
      </g>
    </Svg>
  );
}

export function IconSparkle(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M12 4v6M12 14v6M4 12h6M14 12h6" />
        <path d="M12 7l1 3M12 17l1 -3M7 12l3 1M17 12l-3 1" opacity="0.6" />
      </g>
    </Svg>
  );
}

export function IconCode(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <path d="M9 8l-4 4 4 4" />
        <path d="M15 8l4 4 -4 4" />
      </g>
    </Svg>
  );
}

export function IconArchive(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <rect x="3" y="5" width="18" height="4" rx="0.5" />
        <path d="M5 9v9c0 .8 .7 1.5 1.5 1.5h11c.8 0 1.5 -.7 1.5 -1.5V9" />
        <path d="M10 13h4" />
      </g>
    </Svg>
  );
}

export function IconLock(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <rect x="5" y="11" width="14" height="9" rx="1.5" />
        <path d="M8 11V8a4 4 0 018 0v3" />
      </g>
    </Svg>
  );
}

export function IconInfo(p: Props) {
  return (
    <Svg {...p}>
      <g {...STROKE}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" />
        <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
      </g>
    </Svg>
  );
}

// ——— aliases without "Icon" prefix — what Round 2 deliverables import ———

export const ArrowLeft = IconArrowLeft;
export const ArrowRight = IconArrowRight;
export const Check = IconCheck;
export const Close = IconX;
export const Copy = IconCopy;
export const Refresh = IconRefresh;
export const Folder = IconFolder;
export const Shield = IconShield;
export const Download = IconDownload;
export const Quote = IconQuote;
export const Share = IconShare;
export const Sparkle = IconSparkle;
export const Code = IconCode;
export const Archive = IconArchive;
export const Lock = IconLock;
export const Info = IconInfo;

export function iconForCli(cli: string): React.ComponentType<Props> {
  if (cli === 'claude') return IconClaude;
  if (cli === 'codex') return IconCodex;
  return IconGeneric;
}

export function iconForStage(key: string): React.ComponentType<Props> {
  return ({
    read: IconRead,
    extract: IconExtract,
    evidence: IconEvidence,
    portrait: IconPortrait,
    forecast: IconForecast,
  } as const)[key as 'read' | 'extract' | 'evidence' | 'portrait' | 'forecast'] || IconDot;
}
