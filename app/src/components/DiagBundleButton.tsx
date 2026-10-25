/* DiagBundleButton — one-click 「复制诊断信息」.
 *
 * Fetches /api/diag-bundle (returns pre-formatted markdown including version,
 * platform, profiles, init_error, masked paths, log tails) and copies it to
 * the clipboard. The user pastes it directly into a GitHub issue; we get a
 * full diagnostic in one round-trip without back-and-forth.
 */
import { useState } from 'react';
import { getDiagBundle } from '../data/api';
import { Button, copyText } from '../ui';
import { IconCheck, IconCopy } from '../ui/icons';

interface Props {
  /** Optional small / large variant. Default: small. */
  size?: 'sm' | 'md';
  /** Optional label override. Default: 「复制诊断信息（粘到 issue）」. */
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
      await copyText(r.markdown);
      setState('ok');
      setTimeout(() => setState('idle'), 2500);
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setState('err');
      setTimeout(() => setState('idle'), 4000);
    }
  }

  const text = state === 'ok' ? '已复制，去 GitHub issue 粘上'
              : state === 'busy' ? '收集中…'
              : state === 'err' ? `复制失败：${errMsg?.slice(0, 60) || '?'}`
              : (label ?? '复制诊断信息（粘到 issue）');

  return (
    <Button
      size={size}
      variant={state === 'err' ? 'danger' : 'secondary'}
      onClick={copy}
      loading={state === 'busy'}
      icon={state === 'ok' ? <IconCheck size={14} /> : state === 'busy' ? undefined : <IconCopy size={14} />}
      title="一键收集 version + 平台 + profiles + init_error + 日志末尾，已脱敏，可直接贴 issue"
    >
      {text}
    </Button>
  );
}
