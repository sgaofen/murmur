// macOS Frida-free / root-free key capture (private WeChat copy).
//
// An alternative to LiveKeyCapture's Frida flow for users who don't want to
// install Frida or type an admin password. The backend
// (cli/mac_private_copy.py) copies WeChat into Murmur's own directory, ad-hoc
// re-signs the copy, and launches it with Murmur's capture dylib injected via
// DYLD_INSERT_LIBRARIES. The copy shares the original's data container but
// asks for one login (verified on WeChat 4.1.15). Candidate keys / the account
// passphrase are verified against each DB's page-1 HMAC and merged into
// ~/.murmur/decrypted_keys.json — usually one round yields every DB key.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelPrivateCopy, deletePrivateCopy, getPrivateCopyStatus, startPrivateCopy,
} from '../data/api';
import type { PrivateCopyStatus } from '../data/api';
import { Button, Callout, Card, SegmentedControl } from '../ui';
import { InlineError } from '../onboarding/parts';
import { privateCopyBusy } from '../onboarding/capture';

interface Props {
  /** Keys are saved — run the existing decrypt flow. */
  onDecrypt: () => void;
  /** Go back to the method chooser / Frida flow. */
  onBack?: () => void;
  /** Told whenever a round starts / ends (incl. the start request in flight),
   * so the dialog can lock its step rail and Esc. Pass a stable function. */
  onBusyChange?: (busy: boolean) => void;
}

const DURATIONS = [120, 180, 300];

const CORE_DBS = ['session/session.db', 'contact/contact.db'];

const TODO: Array<[string, string]> = [
  ['在副本微信里扫码 / 确认登录（副本会要求重新登录一次）', '登录时就会派生各库密钥'],
  ['给文件传输助手发一条消息', '会话库和消息库'],
  ['点开几个对话，打开通讯录、朋友圈', '补齐其余分库'],
];

export function PrivateCopyCapture({ onDecrypt, onBack, onBusyChange }: Props) {
  const [st, setSt] = useState<PrivateCopyStatus | null>(null);
  const [seconds, setSeconds] = useState(180);
  const [err, setErr] = useState<string | null>(null);
  // Backend code for `err` when it has a catalog entry (data/errorCatalog.ts).
  const [errCode, setErrCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);
  const startingRef = useRef(false);

  const refresh = useCallback(async (coverage = false) => {
    try {
      const s = await getPrivateCopyStatus({ coverage });
      setSt(prev => (coverage || !prev?.coverage ? s : { ...s, coverage: prev.coverage }));
      setErr(null);
      return s;
    } catch (e: any) {
      setErr(e?.message || String(e));
      return null;
    }
  }, []);

  useEffect(() => { void refresh(true); }, [refresh]);

  const running = privateCopyBusy(st);
  const anyBusy = running || busy;

  useEffect(() => { onBusyChange?.(anyBusy); }, [anyBusy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    if (!running) return;
    pollRef.current = window.setInterval(async () => {
      const s = await refresh(false);
      if (s && !s.job.running) void refresh(true);
    }, 1000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [running, refresh]);

  async function start() {
    if (startingRef.current) return;  // double click: one start request only
    startingRef.current = true;
    setErr(null);
    setErrCode(null);
    setBusy(true);
    try {
      const r = await startPrivateCopy(seconds);
      if (!r.ok) { setErr(r.error || '启动失败'); setErrCode(r.code ?? null); }
      await refresh(!!r.complete);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  }

  async function removeCopy() {
    setErr(null);
    try {
      const r = await deletePrivateCopy();
      if (!r.ok) setErr(
        r.error === 'running' ? '抓取还在进行，先停止再删除。'
          : r.error === 'copy-running' ? '微信副本还在运行且无法自动结束，请先在程序坞里退出副本再删除。'
            : (r.error || '删除失败'));
      await refresh(false);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  if (!st) {
    return <div className="ob-working__sub" role="status">正在检查免 Frida 抓取环境…</div>;
  }

  const job = st.job;
  const cov = st.coverage;
  const total = job.round > 0 ? job.total : (cov?.total ?? 0);
  const matched = job.round > 0 && job.running ? job.matched_count : (cov?.known ?? job.matched_count);
  const pending = cov?.pending ?? [];
  const missingCore = CORE_DBS.filter(db => pending.includes(db));
  const finished = !job.running && job.round > 0;

  if (!job.dylib_available) {
    return (
      <>
        <Intro />
        <Callout tone="warning" title="这个版本的 App 没带上捕获组件">
          免 Frida 方式需要一个随 App 编译的小组件（murmur_keycap.dylib），当前这份没有打包进来。可以改用上一步的 Frida 实时抓取，或等带有该组件的版本。
        </Callout>
        {onBack && <Button variant="secondary" size="lg" block className="ui-mt-3" onClick={onBack}>← 换回 Frida 方式</Button>}
      </>
    );
  }

  return (
    <>
      <Intro />

      {!job.running && (
        <div className="ui-stack ui-stack--md">
          {finished && job.phase === 'done' && (
            <RoundSummary newCount={job.new.length} matched={matched} total={total}
              missingCore={missingCore} round={job.round} passphrase={job.passphrase_found} />
          )}
          {job.phase === 'error' && <JobError error={job.error} log={job.log} />}
          {!finished && total > 0 && (
            <div className="et-meta">
              已有 <strong>{matched}</strong> / {total} 个数据库的密钥{matched > 0 ? '（之前抓到的会保留）' : ''}
            </div>
          )}
          <TodoList />
          <div className="ui-row">
            <span className="et-meta">这一轮留的操作时间：</span>
            <SegmentedControl label="这一轮留的操作时间" size="sm" value={String(seconds)}
              onChange={v => setSeconds(Number(v))}
              options={DURATIONS.map(d => ({ value: String(d), label: `${d} 秒` }))} />
          </div>
          <Callout tone="warning" compact>
            点开始后 Murmur 会把微信复制一份到自己的目录、重签名后打开这份<strong>副本</strong>，不会动你的 <code>/Applications/WeChat.app</code>。副本打开后请在里面登录并随便用一下，密钥到手就行。<br/>
            风控提示：复制并重签名、注入微信进程这类操作有被腾讯检测到的可能，极端情况下可能触发账号安全提醒或限制。开始前<strong>必须先完全退出原版微信</strong>（副本和原版共用同一份聊天数据，不能同时运行），每轮结束时 Murmur 会自动关掉副本。Murmur 只处理本机、你本人的数据，不上传任何内容；介意的话请不要继续。
          </Callout>
          <div className="ui-stack">
            {finished && matched > 0 ? (
              <>
                <Button variant="primary" size="lg" block onClick={onDecrypt}>
                  {matched >= total ? '全部抓到了 → 开始解密' : `用已抓到的 ${matched} 个开始解密`}
                </Button>
                <Button variant="secondary" size="lg" block onClick={start} loading={busy}>
                  {busy ? '启动中…' : '再抓一轮（补齐剩下的）'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="primary" size="lg" block onClick={start} loading={busy}>
                  {busy ? '启动中…' : finished ? '再抓一轮' : '复制并打开副本，开始抓取'}
                </Button>
                {!finished && matched > 0 && (
                  <Button variant="secondary" size="lg" block onClick={onDecrypt}>已经够了，直接用现有的 {matched} 个解密</Button>
                )}
              </>
            )}
            {job.copy_exists && (
              <Button variant="ghost" block onClick={removeCopy}>用完了，删除微信副本</Button>
            )}
            {onBack && (
              <Button variant="ghost" block onClick={onBack}>← 换回 Frida 方式</Button>
            )}
          </div>
        </div>
      )}

      {job.running && (
        <Running status={st} matched={matched} total={total} onStop={() => {
          cancelPrivateCopy()
            .then(() => refresh(false))
            .catch((e: any) => setErr(e?.message || String(e)));
        }} />
      )}

      {err && <InlineError code={errCode} raw={err} className="ui-mt-3" />}
    </>
  );
}

function Intro() {
  return (
    <p className="ob-lead">
      <strong>免 Frida 方式</strong>：不装 Frida、不用管理员密码。Murmur 复制一份微信到自己目录、重签名后打开这份副本，在副本<strong>用到</strong>密钥的那一刻把它截下来。所以请在副本里登录并操作一下微信。
    </p>
  );
}

function TodoList() {
  return (
    <Card variant="sunken" padding="sm">
      <div className="ob-section-title">副本打开后，在它里面做这些：</div>
      <ol className="ob-list">
        {TODO.map(([what, why]) => (
          <li key={what}>{what}<span className="ob-list__why">· {why}</span></li>
        ))}
      </ol>
    </Card>
  );
}

function Running({ status, matched, total, onStop }: {
  status: PrivateCopyStatus; matched: number; total: number; onStop: () => void;
}) {
  const job = status.job;
  const pct = total > 0 ? Math.round((matched / total) * 100) : 0;
  const head =
    job.phase === 'copying' ? '正在复制并重签名微信副本…' :
    job.phase === 'launching' ? '正在打开副本…' :
    job.phase === 'capturing' ? '副本已打开 —— 去副本里登录 / 操作微信' :
    '准备中…';
  return (
    <div style={{ padding: '8px 0 4px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div className="et-h3">{head}</div>
        {job.phase === 'capturing' && job.remaining != null && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 600, color: 'var(--accent)' }}>
            {job.remaining}s
          </div>
        )}
      </div>
      <div style={{ margin: '12px 0 6px', height: 8, borderRadius: 4, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .4s' }} />
      </div>
      <div className="et-meta" style={{ marginBottom: 10 }}>
        已匹配 <strong>{matched}</strong> / {total} 个数据库
        {job.new.length > 0 && <>（这轮新增 {job.new.length} 个）</>}
        {job.passphrase_found && <> · 已拿到账号口令，正在推算其余库</>}
      </div>
      {job.new.length > 0 && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--success-fg)', lineHeight: 1.6, marginBottom: 10 }}>
          {job.new.slice(-6).map(n => <div key={n}>✓ {n}</div>)}
        </div>
      )}
      {job.phase === 'capturing' && <TodoList />}
      <Button variant="secondary" size="lg" block className="ui-mt-3" onClick={onStop}>提前结束这一轮</Button>
    </div>
  );
}

function RoundSummary({ newCount, matched, total, missingCore, round, passphrase }: {
  newCount: number; matched: number; total: number; missingCore: string[]; round: number; passphrase: boolean;
}) {
  const all = total > 0 && matched >= total;
  return (
    <Callout tone={all ? 'success' : newCount > 0 ? 'warning' : 'danger'}
      title={`第 ${round} 轮结束：新抓到 ${newCount} 个，累计 ${matched} / ${total}`}>
      {all && <div>全部数据库的密钥都到手了。</div>}
      {!all && newCount === 0 && (
        <div>这一轮什么都没截到。确认你在副本里完成了登录、并发过消息 / 点开过对话。</div>
      )}
      {!all && passphrase && newCount > 0 && (
        <div>已拿到账号口令，大部分库应该都推算出来了；个别没抓到的可以再抓一轮。</div>
      )}
      {!all && !passphrase && missingCore.length > 0 && (
        <div>关键库 <code>{missingCore.join('、')}</code> 还没抓到，建议再抓一轮：在副本里发条消息、打开通讯录。</div>
      )}
    </Callout>
  );
}

function JobError({ error, log }: { error: string | null; log: string }) {
  const msg =
    error === 'no-keys' ? '这一轮没截到任何密钥。确认你在副本里完成了登录并操作了微信；如果副本没能正常打开，请先退出正在运行的微信再试。' :
    (error && error.indexOf('重签名失败') === 0) ? `${error}（可尝试重装微信后再试）` :
    (error && error.indexOf('缺少捕获组件') === 0) ? '缺少捕获组件：这个版本没带上 murmur_keycap.dylib。' :
    `抓取失败：${error || '未知错误'}`;
  return (
    <Callout tone="danger" title={msg}>
      {log && (
        <details>
          <summary>查看日志</summary>
          <pre>{log.slice(-1500)}</pre>
        </details>
      )}
    </Callout>
  );
}
