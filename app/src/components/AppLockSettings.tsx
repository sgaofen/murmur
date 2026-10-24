/* 设置 → 应用锁: turn on / change / turn off the password, idle auto-lock,
 * lock now. Layout comes from pages/Settings.css (settings-row). */
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button, Callout, Card, CardHeader, Chip, SegmentedControl, Skeleton } from '../ui';
import { IconEye, IconEyeOff } from '../ui/icons';
import {
  APP_LOCK_STATUS_EVENT, IDLE_LABEL, disableAppLock, getAppLockStatus, requestLock, resetHint,
  setAppLockIdle, setAppLockPassword,
} from '../data/appLock';
import type { AppLockResult, AppLockStatus } from '../data/appLock';
import { maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import './AppLock.css';

type Mode = 'view' | 'enable' | 'change' | 'disable';
const IDLE_ORDER = [5, 15, 30, 0];
const MIN_LEN = 4;

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__head">
        <div className="settings-row__label">{label}</div>
        {hint && <div className="settings-row__hint">{hint}</div>}
      </div>
      <div className="settings-row__body">{children}</div>
    </div>
  );
}

function failText(r: AppLockResult): string {
  switch (r.code) {
    case 'APP_LOCK_WRONG_PASSWORD': return r.retryAfter > 0 ? `当前密码不对，请 ${r.retryAfter} 秒后再试` : '当前密码不对';
    case 'APP_LOCK_RATE_LIMITED': return `尝试次数过多，请 ${r.retryAfter} 秒后再试`;
    case 'BACKEND_UNREACHABLE': return '连不上本地服务';
    default: return r.error || '操作失败';
  }
}

export function AppLockSettings() {
  void usePrivacy();
  const [status, setStatus] = useState<AppLockStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [mode, setMode] = useState<Mode>('view');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAppLockStatus()
      .then(s => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setOffline(true); });
    const onStatus = (e: Event) => setStatus((e as CustomEvent<AppLockStatus>).detail);
    window.addEventListener(APP_LOCK_STATUS_EVENT, onStatus);
    return () => { cancelled = true; window.removeEventListener(APP_LOCK_STATUS_EVENT, onStatus); };
  }, []);

  const done = (msg: string) => { setMode('view'); setNotice(msg); window.setTimeout(() => setNotice(null), 2500); };

  const changeIdle = async (v: string) => {
    const r = await setAppLockIdle(Number(v));
    if (!r.ok) setNotice(failText(r));
  };

  return (
    <Card padding="lg" className="app-lock-settings">
      <CardHeader
        title="应用锁"
        description="打开 Murmur 或闲置一段时间后要先输入密码，解锁前不显示任何聊天内容。"
        actions={status?.enabled ? <Chip size="sm" tone="success">已开启</Chip> : status ? <Chip size="sm">未开启</Chip> : undefined}
      />
      {status === null ? (
        offline
          ? <span className="settings-muted">读不到应用锁状态（本地服务没响应）。</span>
          : <Skeleton height={44} />
      ) : !status.enabled ? (
        mode === 'enable' ? (
          <Row label="设置密码" hint={`至少 ${MIN_LEN} 位`}>
            <PasswordForm
              fields={['new', 'confirm']}
              withIdle
              submitLabel="开启应用锁"
              onCancel={() => setMode('view')}
              onSubmit={(p) => setAppLockPassword(p.next, undefined, p.idle)}
              onDone={() => done('应用锁已开启')}
            />
          </Row>
        ) : (
          <Row label="密码锁" hint="默认关闭">
            <div className="app-lock-settings__actions">
              <Button size="sm" variant="primary" onClick={() => { setNotice(null); setMode('enable'); }}>设置密码</Button>
              {notice && <span className="app-lock-settings__ok">{notice}</span>}
            </div>
          </Row>
        )
      ) : (
        <>
          <Row label="闲置自动锁定" hint="多久没操作就锁上">
            <SegmentedControl
              label="闲置自动锁定"
              size="sm"
              value={String(status.idle_minutes)}
              onChange={changeIdle}
              options={IDLE_ORDER.map(m => ({ value: String(m), label: IDLE_LABEL[m] }))}
            />
          </Row>
          <Row label="密码" hint="修改或关闭都要先输入当前密码">
            {mode === 'change' ? (
              <PasswordForm
                fields={['current', 'new', 'confirm']}
                submitLabel="保存新密码"
                onCancel={() => setMode('view')}
                onSubmit={(p) => setAppLockPassword(p.next, p.current)}
                onDone={() => done('密码已修改')}
              />
            ) : mode === 'disable' ? (
              <PasswordForm
                fields={['current']}
                submitLabel="关闭应用锁"
                danger
                onCancel={() => setMode('view')}
                onSubmit={(p) => disableAppLock(p.current)}
                onDone={() => done('应用锁已关闭')}
              />
            ) : (
              <div className="app-lock-settings__actions">
                <Button size="sm" variant="primary" onClick={requestLock}>立即锁定</Button>
                <Button size="sm" variant="secondary" onClick={() => { setNotice(null); setMode('change'); }}>修改密码</Button>
                <Button size="sm" variant="ghost" onClick={() => { setNotice(null); setMode('disable'); }}>关闭应用锁</Button>
                {notice && <span className="app-lock-settings__ok">{notice}</span>}
              </div>
            )}
          </Row>
        </>
      )}
      {status !== null && (
        <Callout tone="info" compact title="防旁人翻看，不是加密">
          {'应用锁只拦住打开 Murmur 界面和本地服务的人，'}<b>不会加密</b>
          {'电脑上已经解密的聊天数据库；能登录这台电脑账户的人仍然可以直接读取那些文件。密码只以加盐哈希（PBKDF2）保存在 '}
          <code>{maskText(resetHint(status.lock_file))}</code>
          {'。忘记密码：完全退出 Murmur，删掉这个文件再打开，应用锁就关闭了，聊天数据不受影响。Touch ID 解锁暂不支持。'}
        </Callout>
      )}
    </Card>
  );
}

type Field = 'current' | 'new' | 'confirm';
const FIELD_LABEL: Record<Field, string> = { current: '当前密码', new: '新密码', confirm: '再输一遍' };

function PasswordForm({
  fields, withIdle, submitLabel, danger, onSubmit, onCancel, onDone,
}: {
  fields: Field[];
  withIdle?: boolean;
  submitLabel: string;
  danger?: boolean;
  onSubmit: (p: { current: string; next: string; idle?: number }) => Promise<AppLockResult>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<Field, string>>({ current: '', new: '', confirm: '' });
  const [idle, setIdle] = useState('15');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (fields.includes('current') && !values.current) { setError('请输入当前密码'); return; }
    if (fields.includes('new')) {
      if (values.new.length < MIN_LEN) { setError(`新密码至少 ${MIN_LEN} 位`); return; }
      if (values.new !== values.confirm) { setError('两次输入的新密码不一样'); return; }
    }
    setBusy(true);
    const r = await onSubmit({ current: values.current, next: values.new, idle: withIdle ? Number(idle) : undefined });
    setBusy(false);
    if (r.ok) onDone();
    else setError(failText(r));
  };

  return (
    <form className="app-lock-settings__form" onSubmit={submit}>
      {fields.map((f, i) => (
        <label key={f} className="ui-stack" style={{ gap: 4 }}>
          <span className="app-lock-settings__label">{FIELD_LABEL[f]}</span>
          <div className="app-lock-field">
            <input
              className="app-lock-input"
              type={show ? 'text' : 'password'}
              autoFocus={i === 0}
              autoComplete={f === 'current' ? 'current-password' : 'new-password'}
              value={values[f]}
              onChange={e => { setValues(v => ({ ...v, [f]: e.target.value })); setError(null); }}
            />
            {i === 0 && (
              <button type="button" className="app-lock-field__eye" onClick={() => setShow(v => !v)}
                      aria-label={show ? '隐藏密码' : '显示密码'} title={show ? '隐藏密码' : '显示密码'}>
                {show ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            )}
          </div>
        </label>
      ))}
      {withIdle && (
        <div className="ui-stack" style={{ gap: 4 }}>
          <span className="app-lock-settings__label">闲置多久自动锁定</span>
          <SegmentedControl
            label="闲置自动锁定"
            size="sm"
            value={idle}
            onChange={setIdle}
            options={IDLE_ORDER.map(m => ({ value: String(m), label: IDLE_LABEL[m] }))}
          />
        </div>
      )}
      {error && <div className="app-lock-settings__error" role="alert">{error}</div>}
      <div className="app-lock-settings__actions">
        <Button type="submit" size="sm" variant={danger ? 'danger' : 'primary'} loading={busy}>{submitLabel}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
      </div>
    </form>
  );
}
