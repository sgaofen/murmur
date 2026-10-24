// macOS live key capture (WeChat 4.1.9+, sgaofen/murmur#27).
//
// WeChat 4.1.9+ no longer keeps its SQLCipher keys in memory, so the memory
// scan in extract_key_mac.py often comes back with 0 keys. The backend can
// instead hook CommonCrypto inside WeChat with Frida (cli/hook_cc_key_frida.py)
// and catch each database key the moment WeChat uses it — which only happens
// while the user is actively using WeChat. This component walks the user
// through that: install Frida if needed, run a timed round with a countdown
// and a live matched-DB counter, offer another round, then hand off to the
// existing decrypt flow.
import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelLiveKey, getLiveKeyStatus, installFrida, startLiveKey } from '../data/api';
import type { LiveKeyStatus } from '../data/api';

interface Props {
  /** Keys are saved — run the existing decrypt flow. */
  onDecrypt: () => void;
  /** Why we got here: the memory scan found nothing, or WeChat is 4.1.9+. */
  reason?: 'scan-empty' | 'version' | 'manual';
  wechatVersion?: string | null;
  /** Optional secondary action (e.g. back to paste-key). */
  onPaste?: () => void;
}

const DURATIONS = [60, 90, 180];

// Core DBs Murmur needs to show anything at all; if these are still missing
// after a round the user should do another one rather than decrypt.
const CORE_DBS = ['session/session.db', 'contact/contact.db'];

const TODO: Array<[string, string]> = [
  ['给任意好友或文件传输助手发一条消息', '解锁会话库和消息库'],
  ['点开几个这次登录后还没点开过的对话，往上翻一翻', '每个消息分库要单独触发'],
  ['打开「通讯录」，点进一两个联系人', '联系人库'],
  ['刷一下朋友圈', '朋友圈库'],
  ['打开收藏、表情面板，发一张图片', '收藏 / 表情 / 媒体库'],
];

export function LiveKeyCapture({ onDecrypt, reason = 'manual', wechatVersion, onPaste }: Props) {
  const [st, setSt] = useState<LiveKeyStatus | null>(null);
  const [seconds, setSeconds] = useState(90);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async (coverage = false) => {
    try {
      const s = await getLiveKeyStatus({ coverage });
      setSt(prev => (coverage || !prev?.coverage ? s : { ...s, coverage: prev.coverage }));
      return s;
    } catch (e: any) {
      setErr(e?.message || String(e));
      return null;
    }
  }, []);

  useEffect(() => { void refresh(true); }, [refresh]);

  const running = !!st?.job.running;
  const installing = !!st?.install.running;

  // Poll while a round or the Frida install is in flight; re-read coverage
  // once it finishes so the totals include this round.
  useEffect(() => {
    if (!running && !installing) return;
    pollRef.current = window.setInterval(async () => {
      const s = await refresh(false);
      if (s && !s.job.running && !s.install.running) void refresh(true);
    }, 1000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [running, installing, refresh]);

  async function start() {
    setErr(null);
    setBusy(true);
    try {
      const r = await startLiveKey(seconds);
      if (!r.ok) {
        setErr(r.error === 'frida-missing' ? '还没装 Frida，先点上面的安装按钮。' : (r.error || '启动失败'));
      }
      await refresh(!!r.complete);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setErr(null);
    try {
      const r = await installFrida();
      if (!r.ok) setErr(r.error || '安装失败');
      await refresh(false);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  if (!st) {
    return <div className="et-meta" style={{ padding: '24px 0', textAlign: 'center' }}>正在检查实时抓取环境…</div>;
  }

  const job = st.job;
  const cov = st.coverage;
  const total = job.round > 0 ? job.total : (cov?.total ?? 0);
  const matched = job.round > 0 && job.running ? job.matched_count : (cov?.known ?? job.matched_count);
  const pending = cov?.pending ?? [];
  const missingCore = CORE_DBS.filter(db => pending.includes(db));
  const finished = !job.running && job.round > 0;

  return (
    <>
      <Intro reason={reason} wechatVersion={wechatVersion} />

      {!st.frida.installed && (
        <FridaMissing status={st} onInstall={install} />
      )}

      {st.frida.installed && !job.running && (
        <>
          {finished && job.phase === 'done' && (
            <RoundSummary newCount={job.new.length} matched={matched} total={total}
              missingCore={missingCore} round={job.round} />
          )}
          {job.phase === 'error' && <JobError error={job.error} log={job.log} />}
          {!finished && total > 0 && (
            <div className="et-meta" style={{ marginBottom: 10 }}>
              已有 <strong>{matched}</strong> / {total} 个数据库的密钥{matched > 0 ? '（之前抓到的会保留）' : ''}
            </div>
          )}
          <TodoList />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 4px', flexWrap: 'wrap' }}>
            <span className="et-meta">每轮抓取时长：</span>
            {DURATIONS.map(d => (
              <button key={d} onClick={() => setSeconds(d)} style={chip(seconds === d)}>{d} 秒</button>
            ))}
          </div>
          <div style={{
            padding: '10px 14px', background: 'rgba(232,181,122,0.18)',
            border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
            fontSize: 11.5, color: '#8a5a1c', lineHeight: 1.6, margin: '10px 0 4px',
          }}>
            💡 点开始后多半会弹 macOS 密码窗口（挂钩微信需要管理员权限），输完开机密码倒计时才开始。
            倒计时期间<strong>切到微信去操作</strong>，Murmur 这边不用看着。<br/>
            风控提示：挂钩微信进程有被腾讯检测到的可能。Murmur 只处理本机、你本人的数据，不上传任何内容。
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
                {busy ? '启动中…' : finished ? '再抓一轮' : '开始实时抓取'}
              </button>
              {!finished && matched > 0 && (
                <button onClick={onDecrypt} style={secondaryBtn}>已经够了，直接用现有的 {matched} 个解密</button>
              )}
            </>
          )}
        </>
      )}

      {job.running && (
        <Running status={st} matched={matched} total={total} onStop={() => void cancelLiveKey().then(() => refresh(false))} />
      )}

      {err && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--et-rose)' }}>{err}</div>}

      {onPaste && !job.running && (
        <button onClick={onPaste} style={{ ...secondaryBtn, border: 'none', fontSize: 12, color: 'var(--et-mute)' }}>
          或者：手动粘贴密钥
        </button>
      )}
    </>
  );
}

function Intro({ reason, wechatVersion }: { reason: Props['reason']; wechatVersion?: string | null }) {
  return (
    <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 12 }}>
      {reason === 'scan-empty' && <>内存扫描这次一个密钥都没找到 —— 微信 4.1.9 之后很常见，不是你操作的问题。<br/></>}
      {reason === 'version' && wechatVersion && <>检测到你的微信是 <strong>{wechatVersion}</strong>，这个版本密钥不再常驻内存。<br/></>}
      换个办法：我在微信<strong>用到</strong>密钥的那一刻把它截下来。所以抓取期间需要你<strong>主动去用微信</strong>，光放着是抓不到的。
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
      <div style={{ fontWeight: 600, marginBottom: 6 }}>倒计时开始后，去微信里做这些：</div>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {TODO.map(([what, why]) => (
          <li key={what}>{what} <span className="et-meta" style={{ fontSize: 11 }}>· {why}</span></li>
        ))}
      </ol>
    </div>
  );
}

function Running({ status, matched, total, onStop }: {
  status: LiveKeyStatus; matched: number; total: number; onStop: () => void;
}) {
  const job = status.job;
  const pct = total > 0 ? Math.round((matched / total) * 100) : 0;
  const head =
    job.phase === 'auth' ? '请在系统弹窗里输入开机密码…' :
    job.phase === 'capturing' ? '正在抓取 —— 现在去微信里操作' :
    '正在挂钩微信…';
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
        {job.phase === 'capturing' && <> · 已截获 {job.hits} 次加解密调用</>}
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

function RoundSummary({ newCount, matched, total, missingCore, round }: {
  newCount: number; matched: number; total: number; missingCore: string[]; round: number;
}) {
  const all = total > 0 && matched >= total;
  const color = all ? '#3a7a4f' : newCount > 0 ? '#8a5a1c' : 'var(--et-rose)';
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8, marginBottom: 12, lineHeight: 1.7, fontSize: 13,
      background: all ? 'rgba(72,167,107,0.10)' : 'rgba(232,181,122,0.18)',
      border: `0.5px solid ${all ? 'rgba(72,167,107,0.30)' : 'rgba(138,90,28,0.3)'}`, color,
    }}>
      <div style={{ fontWeight: 600 }}>
        第 {round} 轮结束：新抓到 {newCount} 个，累计 {matched} / {total}
      </div>
      {all && <div>全部数据库的密钥都到手了。</div>}
      {!all && newCount === 0 && (
        <div>这一轮什么都没截到。确认倒计时期间你在微信里发了消息、点开了新对话；如果弹密码窗时点了取消，也会这样。</div>
      )}
      {!all && missingCore.length > 0 && (
        <div>关键库 <code>{missingCore.join('、')}</code> 还没抓到，建议再抓一轮：发条消息、打开通讯录。</div>
      )}
      {!all && newCount > 0 && missingCore.length === 0 && (
        <div>剩下的多半是你这次没碰到的功能（某些聊天分库、收藏、表情）。可以直接解密，缺的以后再补一轮。</div>
      )}
    </div>
  );
}

function JobError({ error, log }: { error: string | null; log: string }) {
  const msg =
    error === 'frida-missing' ? '找不到 Frida（后端进程里 import 失败）。' :
    error === 'attach-denied' ? '没能挂到微信进程上：请先在引导里做「重签名」，并确认微信是重签名之后重新打开的。' :
    error === 'auth-cancelled' ? '系统密码窗口被取消了。再点一次开始，输入开机密码即可。' :
    error === 'wechat-not-running' ? '微信没在运行，请先打开并登录微信。' :
    `抓取失败：${error || '未知错误'}`;
  return (
    <div style={{
      padding: '12px 14px', background: 'rgba(196,90,63,0.12)', border: '0.5px solid rgba(196,90,63,0.4)',
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

function FridaMissing({ status, onInstall }: { status: LiveKeyStatus; onInstall: () => void }) {
  const inst = status.install;
  if (status.frida.installable) {
    return (
      <div style={{
        padding: '12px 14px', background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
        borderRadius: 8, fontSize: 13, lineHeight: 1.7, marginBottom: 12,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>需要先装一个组件：Frida</div>
        <div className="et-meta">实时抓取靠 Frida 挂钩微信的加密调用，只装一次（下载约 45 MB，装在当前 Python 的用户目录）。</div>
        {inst.ok === false && (
          <details open style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--et-rose)' }}>安装失败，查看输出</summary>
            <pre style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{inst.log.slice(-1200)}</pre>
            <div className="et-meta">也可以在终端手动装：<code>python3 -m pip install --user "frida&gt;=17"</code>，装完回来刷新。</div>
          </details>
        )}
        <button onClick={onInstall} disabled={inst.running} style={primaryBtn}>
          {inst.running ? '正在安装 Frida…（一般 1 分钟内）' : inst.ok === false ? '重试安装' : '一键安装 Frida'}
        </button>
      </div>
    );
  }
  return (
    <div style={{
      padding: '12px 14px', background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
      borderRadius: 8, fontSize: 13, lineHeight: 1.7, marginBottom: 12,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>这个版本的 App 没带上 Frida，先用终端抓一次</div>
      <div className="et-meta" style={{ marginBottom: 6 }}>下载源码后在仓库目录里运行（抓的时候按下面的清单去用微信）：</div>
      <pre style={{ background: 'var(--et-paper)', padding: '8px 10px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--et-mono)', whiteSpace: 'pre-wrap', margin: 0 }}>
{`python3.12 -m pip install -r requirements-mac-keyextract.txt
python3.12 cli/hook_cc_key_frida.py --seconds 90`}
      </pre>
      <div className="et-meta" style={{ marginTop: 6 }}>如果提示 attach / permission 失败，在第二条命令前面加 <code>sudo</code>。一轮抓不全就多跑几次，已经抓到的会保留。</div>
      <div className="et-meta" style={{ marginTop: 6 }}>抓到的密钥会存到 <code>~/.murmur/decrypted_keys.json</code>，回到 Murmur 重新检测即可解密。</div>
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
