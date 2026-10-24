/* ErrorExplain — renders a backend error `code` via the error catalog as
 * 「级别 · 标题 / 原因 / 怎么办」. Returns null for unknown / missing codes so
 * callers keep showing the raw error text as before. Interim, inline-styled
 * with var(--et-*) tokens until the UI-1 ErrorState component lands. */
import { ERROR_LEVEL_LABEL, lookupError } from '../data/errorCatalog';
import type { ErrorLevel } from '../data/errorCatalog';

const LEVEL_COLOR: Record<ErrorLevel, string> = {
  blocking: 'var(--et-rose)',
  action: 'var(--et-orange)',
  retry: 'var(--et-amber)',
  info: 'var(--et-sky)',
};

interface Props {
  code: string | null | undefined;
  style?: React.CSSProperties;
}

export function ErrorExplain({ code, style }: Props) {
  const entry = lookupError(code);
  if (!entry || !code) return null;
  const color = LEVEL_COLOR[entry.level];
  return (
    <div data-error-code={code} style={{
      padding: '12px 14px', marginBottom: 12, borderRadius: 8,
      background: `color-mix(in srgb, ${color} 10%, transparent)`,
      border: `0.5px solid color-mix(in srgb, ${color} 45%, transparent)`,
      lineHeight: 1.6,
      ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color, padding: '1px 8px', borderRadius: 999,
          border: `0.5px solid ${color}`,
        }}>{ERROR_LEVEL_LABEL[entry.level]}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--et-ink)' }}>{entry.title}</span>
        <code style={{ fontSize: 10, color: 'var(--et-faint)', fontFamily: 'var(--et-mono)', marginLeft: 'auto' }}>{code}</code>
      </div>
      <div style={{ fontSize: 12, color: 'var(--et-ink-soft)' }}>
        <span style={{ color: 'var(--et-mute)' }}>原因：</span>{entry.reason}
      </div>
      <div style={{ fontSize: 12, color: 'var(--et-ink-soft)', marginTop: 4 }}>
        <span style={{ color: 'var(--et-mute)' }}>怎么办：</span>{entry.fix}
      </div>
    </div>
  );
}
