import { isValidElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { copyText } from './clipboard';
import { cx } from './cx';
import { redactDiagnostics } from '../utils/diagRedact';
import { IconAlertCircle, IconCheck, IconCopy, IconRefresh, IconWarning } from './icons';

export interface ErrorStateProps {
  title?: ReactNode;
  /** Stable error code, shown as a badge (e.g. "BACKEND_UNREACHABLE", "HTTP 503"). */
  code?: string;
  /** What went wrong, in plain words. */
  reason?: ReactNode;
  /** What the user can do. An array renders as a numbered list. */
  fixes?: ReactNode[] | ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  /** Text for 「复制诊断信息」. A function is only called on click. The copy is
   * always passed through redactDiagnostics() (paths, wxid, keys, phones…),
   * whether or not privacy mode is on — users paste it into public issues. */
  diagnostics?: string | (() => string | Promise<string>);
  diagnosticsLabel?: string;
  /** Extra buttons next to retry / copy. */
  actions?: ReactNode;
  /** Collapsed technical details (raw error, log tail). */
  details?: ReactNode;
  detailsLabel?: string;
  /** danger = failed · warning = degraded / needs attention. */
  tone?: 'danger' | 'warning';
  /** inline = inside a card or list · page = centered in the viewport. */
  layout?: 'inline' | 'page';
  className?: string;
}

export function ErrorState({
  title = '出了点问题', code, reason, fixes, onRetry, retryLabel = '重试', retrying,
  diagnostics, diagnosticsLabel = '复制诊断信息', actions, details, detailsLabel = '技术细节',
  tone = 'danger', layout = 'inline', className,
}: ErrorStateProps) {
  const fixList = Array.isArray(fixes) ? fixes.filter(Boolean) : null;
  const hasButtons = !!onRetry || diagnostics != null || !!actions;
  return (
    <div className={cx('ui-error-wrap', `ui-error-wrap--${layout}`)}>
      <div className={cx('ui-error', `ui-tone--${tone}`, className)} role="alert">
        <div className="ui-error__head">
          <div className="ui-error__icon">
            {tone === 'warning' ? <IconWarning size={22} /> : <IconAlertCircle size={22} />}
          </div>
          <div className="ui-error__heading">
            {code && <div className="ui-error__code">错误码 <span>{code}</span></div>}
            <div className="ui-error__title">{title}</div>
          </div>
        </div>
        {reason && (
          <section className="ui-error__section">
            <div className="ui-error__label">原因</div>
            <div className="ui-error__text">{reason}</div>
          </section>
        )}
        {fixes != null && (fixList ? fixList.length > 0 : true) && (
          <section className="ui-error__section">
            <div className="ui-error__label">怎么办</div>
            {fixList ? (
              <ol className="ui-error__fixes">
                {fixList.map((f, i) => <li key={isValidElement(f) && f.key != null ? f.key : i}>{f}</li>)}
              </ol>
            ) : (
              <div className="ui-error__text">{fixes}</div>
            )}
          </section>
        )}
        {hasButtons && (
          <div className="ui-error__actions">
            {onRetry && (
              <Button variant="primary" icon={<IconRefresh size={15} />} loading={retrying} onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
            {diagnostics != null && <CopyDiagnosticsButton source={diagnostics} label={diagnosticsLabel} />}
            {actions}
          </div>
        )}
        {details && (
          <details className="ui-error__details">
            <summary>{detailsLabel}</summary>
            <div className="ui-error__details-body">{details}</div>
          </details>
        )}
      </div>
    </div>
  );
}

function CopyDiagnosticsButton({ source, label }: { source: NonNullable<ErrorStateProps['diagnostics']>; label: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  async function copy() {
    setState('busy');
    try {
      const text = typeof source === 'function' ? await source() : source;
      await copyText(redactDiagnostics(text));
      setState('ok');
    } catch {
      setState('err');
    }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  }

  return (
    <Button variant="secondary" onClick={copy} loading={state === 'busy'}
      icon={state === 'ok' ? <IconCheck size={15} /> : <IconCopy size={15} />}
      title="复制版本、平台和报错信息（已自动去掉用户名、wxid、密钥等），可以直接贴到 GitHub issue">
      {state === 'ok' ? '已复制' : state === 'err' ? '复制失败，请手动截图' : label}
    </Button>
  );
}
