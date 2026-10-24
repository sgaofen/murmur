// macOS Frida-free / root-free key capture (private WeChat copy).
//
// An alternative to LiveKeyCapture's Frida flow for users who don't want to
// install Frida or type an admin password. The backend
// (cli/mac_private_copy.py) copies WeChat into Murmur's own directory, ad-hoc
// re-signs the copy, and launches it with Murmur's capture dylib injected via
// DYLD_INSERT_LIBRARIES. The copy reuses the current login session; the user
// just uses WeChat once inside the copy. Candidate keys / the account
// passphrase are verified against each DB's page-1 HMAC and merged into
// ~/.murmur/decrypted_keys.json — usually one round yields every DB key.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelPrivateCopy, deletePrivateCopy, getPrivateCopyStatus, startPrivateCopy,
} from '../data/api';
import type { PrivateCopyStatus } from '../data/api';

interface Props {
  /** Keys are saved — run the existing decrypt flow. */
  onDecrypt: () => void;
  /** Go back to the method chooser / Frida flow. */
  onBack?: () => void;
}

const DURATIONS = [120, 180, 300];

const CORE_DBS = ['session/session.db', 'contact/contact.db'];

const TODO: Array<[string, string]> = [
  ['在副本微信里扫码 / 确认登录（会复用你当前的登录）', '登录时就会派生各库密钥'],
  ['给文件传输助手发一条消息', '会话库和消息库'],
  ['点开几个对话，打开通讯录、朋友圈', '补齐其余分库'],
];

export function PrivateCopyCapture({ onDecrypt, onBack }: Props) {
  const [st, setSt] = useState<PrivateCopyStatus | null>(null);
  const [seconds, setSeconds] = useState(180);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

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

  const running = !!st?.job.running;

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
    setErr(null);
    setBusy(true);
    try {
      const r = await startPrivateCopy(seconds);
      if (!r.ok) setErr(r.error || '启动失败');
      await refresh(!!r.complete);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeCopy() {
    setErr(null);
    try {
      const r = await deletePrivateCopy();
      if (!r.ok) setErr(r.error === 'running' ? '抓取还在进行，先停止再删除。' : (r.error || '删除失败'));
      await refresh(false);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  if (!st) {
    return <div className="et-meta" style={{ padding: '24px 0', textAlign: 'center' }}>正在检查免 Frida 抓取环境…</div>;
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
        <div style={{
          padding: '12px 14px', background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
          borderRadius: 8, fontSize: 13, lineHeight: 1.7, marginBottom: 12,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>这个版本的 App 没带上捕获组件</div>
          <div className="et-meta">
            免 Frida 方式需要一个随 App 编译的小组件（murmur_keycap.dylib），当前这份没有打包进来。
            可以改用上一步的 Frida 实时抓取，或等带有该组件的版本。
          </div>
        </div>
        {onBack && <button onClick={onBack} style={secondaryBtn}>← 换回 Frida 方式</button>}
      </>
    );
  }

  return (
    <>
      <Intro />

      {!job.running && (
        <>
          {finished && job.phase === 'done' && (
            <RoundSummary newCount={job.new.length} matched={matched} total={total}
              missingCore={missingCore} round={job.round} passphrase={job.passphrase_found} />
          )}
          {job.phase === 'error' && <JobError error={job.error} log={job.log} />}
          {!finished && total > 0 && (
            <div className="et-meta" style={{ marginBottom: 10 }}>
              已有 <strong>{matched}</strong> / {total} 个数据库的密钥{matched > 0 ? '（之前抓到的会保留）' : ''}
            </div>
          )}
          <TodoList />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 4px', flexWrap: 'wrap' }}>
            <span className="et-meta">这一轮留的操作时间：</span>
            {DURATIONS.map(d => (
              <button key={d} onClick={() => setSeconds(d)} style={chip(seconds === d)}>{d} 秒</button>
            ))}
          </div>
          <div style={{
            padding: '10px 14px', background: 'var(--et-amber-soft, rgba(232,181,122,0.18))',
            border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
            fontSize: 11.5, color: 'var(--et-rose)', lineHeight: 1.6, margin: '10px 0 4px',
          }}>
            💡 点开始后 Murmur 会把微信复制一份到自己的目录、重签名后打开这份<strong>副本</strong>，
            不会动你的 <code>/Applications/WeChat.app</code>。副本打开后请在里面登录并随便用一下，密钥到手就行。<br/>
            风控提示：复制并重签名、注入微信进程这类操作有被腾讯检测到的可能，极端情况下可能触发账号安全提醒或限制。
            副本是独立 App，建议先退出正在运行的微信。Murmur 只处理本机、你本人的数据，不上传任何内容；介意的话请不要继续。
          </div>
          {finished && matched > 0 ? (
            <>
              <button onClick={onDecrypt} style={primaryBtn}>
                {matched >= total ? '全部抓到了 → 开始解密' : `用已抓到的 ${matched} 个开始解密`}
              </button>
              <button onClick={start} disabled={busy} style={secondaryBtn}>
                {busy ? '启动中…' : '再抓一轮（补齐剩下的）'}
              </button>
            </>
          ) : (
            <>
              <button onClick={start} disabled={busy} style={primaryBtn}>
                {busy ? '启动中…' : finished ? '再抓一轮' : '复制并打开副本，开始抓取'}
              </button>
              {!finished && matched > 0 && (
                <button onClick={onDecrypt} style={secondaryBtn}>已经够了，直接用现有的 {matched} 个解密</button>
              )}
            </>
          )}
          {job.copy_exists && (
            <button onClick={removeCopy} style={{ ...secondaryBtn, border: 'none', fontSize: 12, color: 'var(--et-mute)' }}>
              用完了，删除微信副本
            </button>
          )}
          {onBack && (
            <button onClick={onBack} style={{ ...secondaryBtn, border: 'none', fontSize: 12, color: 'var(--et-mute)' }}>
              ← 换回 Frida 方式
            </button>
          )}
        </>
      )}

      {job.running && (
        <Running status={st} matched={matched} total={total} onStop={() => {
          cancelPrivateCopy()
            .then(() => refresh(false))
            .catch((e: any) => setErr(e?.message || String(e)));
        }} />
      )}

      {err && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--et-rose)' }}>{err}</div>}
    </>
  );
}

function Intro() {
  return (
    <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 12 }}>
      <strong>免 Frida 方式</strong>：不装 Frida、不用管理员密码。Murmur 复制一份微信到自己目录、重签名后打开这份副本，
      在副本<strong>用到</strong>密钥的那一刻把它截下来。所以请在副本里登录并操作一下微信。
    </div>
  );
}

function TodoList() {
  return (
    <div style={{
      padding: '12px 14px', background: 'var(--et-paper-2)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 8,
      fontSize: 13, lineHeight: 1.8, color: 'var(--et-ink)',
    }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>副本打开后，在它里面做这些：</div>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {TODO.map(([what, why]) => (
          <li key={what}>{what} <span className="et-meta" style={{ fontSize: 11 }}>· {why}</span></li>
        ))}
      </ol>
    </div>
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
          <div style={{ fontFamily: 'var(--et-mono)', fontSize: 34, fontWeight: 600, color: 'var(--et-orange)' }}>
            {job.remaining}s
          </div>
        )}
      </div>
      <div style={{ margin: '12px 0 6px', height: 8, borderRadius: 4, background: 'var(--et-paper-2)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--et-orange)', transition: 'width .4s' }} />
      </div>
      <div className="et-meta" style={{ marginBottom: 10 }}>
        已匹配 <strong>{matched}</strong> / {total} 个数据库
        {job.new.length > 0 && <>（这轮新增 {job.new.length} 个）</>}
        {job.passphrase_found && <> · 已拿到账号口令，正在推算其余库</>}
      </div>
      {job.new.length > 0 && (
        <div style={{ fontFamily: 'var(--et-mono)', fontSize: 11, color: 'var(--et-ink-soft)', lineHeight: 1.6, marginBottom: 10 }}>
          {job.new.slice(-6).map(n => <div key={n}>✓ {n}</div>)}
        </div>
      )}
      {job.phase === 'capturing' && <TodoList />}
      <button onClick={onStop} style={secondaryBtn}>提前结束这一轮</button>
    </div>
  );
}

function RoundSummary({ newCount, matched, total, missingCore, round, passphrase }: {
  newCount: number; matched: number; total: number; missingCore: string[]; round: number; passphrase: boolean;
}) {
  const all = total > 0 && matched >= total;
  const color = all ? 'var(--et-sage)' : newCount > 0 ? 'var(--et-rose)' : 'var(--et-rose)';
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8, marginBottom: 12, lineHeight: 1.7, fontSize: 13,
      background: 'var(--et-paper-2)',
      border: `0.5px solid var(--et-line-2)`, color,
    }}>
      <div style={{ fontWeight: 600 }}>
        第 {round} 轮结束：新抓到 {newCount} 个，累计 {matched} / {total}
      </div>
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
    </div>
  );
}

function JobError({ error, log }: { error: string | null; log: string }) {
  const msg =
    error === 'no-keys' ? '这一轮没截到任何密钥。确认你在副本里完成了登录并操作了微信；如果副本没能正常打开，请先退出正在运行的微信再试。' :
    (error && error.indexOf('重签名失败') === 0) ? `${error}（可尝试重装微信后再试）` :
    (error && error.indexOf('缺少捕获组件') === 0) ? '缺少捕获组件：这个版本没带上 murmur_keycap.dylib。' :
    `抓取失败：${error || '未知错误'}`;
  return (
    <div style={{
      padding: '12px 14px', background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
      borderRadius: 8, marginBottom: 12,
    }}>
      <div style={{ fontSize: 13, color: 'var(--et-rose)', fontWeight: 600 }}>{msg}</div>
      {log && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--et-mute)' }}>查看日志</summary>
          <pre style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 160, overflow: 'auto' }}>{log.slice(-1500)}</pre>
        </details>
      )}
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
  textAlign: 'center', padding: '14px 0', marginTop: 8,
  background: 'var(--et-orange)', color: '#fff',
  borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
  boxShadow: '0 6px 16px rgba(255,107,71,0.32)',
};

const secondaryBtn: React.CSSProperties = {
  ...primaryBtn, background: 'transparent', color: 'var(--et-ink)', boxShadow: 'none',
  border: '1px solid var(--et-line-2)', padding: '12px 0',
};

function chip(active: boolean): React.CSSProperties {
  return {
    all: 'unset', cursor: 'pointer', padding: '4px 12px', borderRadius: 999, fontSize: 12,
    border: `1px solid ${active ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
    color: active ? 'var(--et-orange)' : 'var(--et-ink-soft)',
    background: active ? 'rgba(255,107,71,0.08)' : 'transparent',
  };
}
