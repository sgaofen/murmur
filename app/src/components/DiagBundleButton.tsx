/* DiagBundleButton — one-click 「📋 复制诊断信息」.
 *
 * Fetches /api/diag-bundle (returns pre-formatted markdown including version,
 * platform, profiles, init_error, masked paths, log tails) and copies it to
 * the clipboard. The user pastes it directly into a GitHub issue; we get a
 * full diagnostic in one round-trip without back-and-forth.
 */
import { useState } from 'react';
import { getDiagBundle } from '../data/api';

interface Props {
  /** Optional small / large variant. Default: small. */
  size?: 'sm' | 'md';
  /** Optional label override. Default: 「📋 复制诊断信息（粘到 issue）」. */
  label?: string;
}

export function DiagBundleButton({ size = 'sm', label }: Props) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function copy() {
    setState('busy');
    setErrMsg(null);
    try {
      const r = await getDiagBundle();
      await navigator.clipboard.writeText(r.markdown);
      setState('ok');
      setTimeout(() => setState('idle'), 2500);
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
      setState('err');
      setTimeout(() => setState('idle'), 4000);
    }
  }

  const text = state === 'ok' ? '✓ 已复制，去 GitHub issue 粘上'
              : state === 'busy' ? '收集中…'
              : state === 'err' ? `复制失败：${errMsg?.slice(0, 60) || '?'}`
              : (label ?? '📋 复制诊断信息（粘到 issue）');

  const padding = size === 'md' ? '10px 16px' : '6px 12px';
  const fontSize = size === 'md' ? 13 : 11.5;

  return (
    <button
      type="button"
      onClick={copy}
      disabled={state === 'busy'}
      title="一键收集 version + 平台 + profiles + init_error + 日志末尾，已脱敏，可直接贴 issue"
      style={{
        all: 'unset', cursor: state === 'busy' ? 'wait' : 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding, fontSize, fontWeight: 500,
        borderRadius: 999,
        border: '0.5px solid var(--et-line-2)',
        background: state === 'ok' ? 'rgba(72,167,107,0.18)'
                  : state === 'err' ? 'rgba(196,90,63,0.15)'
                  : 'var(--et-paper-2)',
        color: state === 'ok' ? '#3a7a4f'
             : state === 'err' ? 'var(--et-rose)'
             : 'var(--et-ink-soft)',
        whiteSpace: 'nowrap',
        transition: 'background 120ms ease',
      }}
    >
      {text}
    </button>
  );
}
