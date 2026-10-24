/* ErrorExplain — renders a backend error `code` via the error catalog as
 * 「级别 · 标题 / 原因 / 怎么办」. Returns null for unknown / missing codes so
 * callers keep showing the raw error text as before. Colors come from the
 * UI-1 semantic status tokens (bg / fg / border per level). */
import { ERROR_LEVEL_LABEL, lookupError } from '../data/errorCatalog';
import type { ErrorLevel } from '../data/errorCatalog';

const LEVEL_TONE: Record<ErrorLevel, { bg: string; fg: string; border: string }> = {
  blocking: { bg: 'var(--danger-bg)', fg: 'var(--danger-fg)', border: 'var(--danger-border)' },
  action: { bg: 'var(--accent-soft)', fg: 'var(--accent-text)', border: 'var(--accent-border)' },
  retry: { bg: 'var(--warning-bg)', fg: 'var(--warning-fg)', border: 'var(--warning-border)' },
  info: { bg: 'var(--info-bg)', fg: 'var(--info-fg)', border: 'var(--info-border)' },
};

interface Props {
  code: string | null | undefined;
  style?: React.CSSProperties;
}

export function ErrorExplain({ code, style }: Props) {
  const entry = lookupError(code);
  if (!entry || !code) return null;
  const tone = LEVEL_TONE[entry.level];
  return (
    <div data-error-code={code} style={{
      padding: '12px 14px', marginBottom: 12, borderRadius: 'var(--radius-sm)',
      background: tone.bg,
      border: `0.5px solid ${tone.border}`,
      lineHeight: 1.6,
      ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color: tone.fg, padding: '1px 8px', borderRadius: 'var(--radius-pill)',
          border: `0.5px solid ${tone.border}`,
        }}>{ERROR_LEVEL_LABEL[entry.level]}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{entry.title}</span>
        <code style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>{code}</code>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        <span style={{ color: 'var(--text-muted)' }}>原因：</span>{entry.reason}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
        <span style={{ color: 'var(--text-muted)' }}>怎么办：</span>{entry.fix}
      </div>
    </div>
  );
}
