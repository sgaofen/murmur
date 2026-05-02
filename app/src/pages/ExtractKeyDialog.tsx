import { useEffect, useRef, useState } from 'react';
import { extractKey, saveKey } from '../data/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: (key: string) => void;
}

type Phase = 'intro' | 'restarting' | 'waiting-login' | 'success' | 'error';

export function ExtractKeyDialog({ open, onClose, onSuccess }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string>('');
  const [elapsed, setElapsed] = useState(0);
  const elapsedTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setPhase('intro');
      setKey(null); setError(null); setLog(''); setElapsed(0);
      if (elapsedTimer.current) { window.clearInterval(elapsedTimer.current); elapsedTimer.current = null; }
    }
  }, [open]);

  if (!open) return null;

  async function handleStart() {
    setError(null);
    setPhase('restarting');
    // Start elapsed timer
    setElapsed(0);
    elapsedTimer.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    // Switch to waiting-login phase after 5s (microbatched)
    window.setTimeout(() => setPhase((p) => p === 'restarting' ? 'waiting-login' : p), 5000);

    try {
      // autoRestart=false: hook the running WeChat instead of kill+relaunch
      // (kill+relaunch makes the new Weixin.exe die before hook attaches on Win11 + WeChat 4.1.x)
      const r = await extractKey({ autoRestart: false, timeout: 90 });
      if (elapsedTimer.current) { window.clearInterval(elapsedTimer.current); elapsedTimer.current = null; }
      setLog(r.log || '');
      if (r.ok && r.key) {
        // Persist
        await saveKey(r.key);
        setKey(r.key);
        setPhase('success');
        onSuccess?.(r.key);
      } else {
        setError(r.log?.split('\n').slice(-3).join('\n') || '未知错误');
        setPhase('error');
      }
    } catch (e: any) {
      if (elapsedTimer.current) { window.clearInterval(elapsedTimer.current); elapsedTimer.current = null; }
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(20,24,42,0.55)',
      backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        width: 600, maxWidth: '94%',
        background: 'var(--et-paper)',
        borderRadius: 'var(--et-r-lg)',
        boxShadow: 'var(--et-shadow-3)',
        border: '0.5px solid var(--et-line-2)',
        overflow: 'hidden', position: 'relative',
      }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, background: 'var(--et-orange)' }} />
        <button onClick={onClose} style={{
          position: 'absolute', top: 14, right: 14, all: 'unset', cursor: 'pointer',
          width: 28, height: 28, borderRadius: 8, color: 'var(--et-mute)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round" />
          </svg>
        </button>
        <div style={{ padding: '24px 28px 4px' }}>
          <div className="et-eyebrow" style={{ color: 'var(--et-orange)' }}>初始化 · 读取密钥</div>
          <div className="et-h2" style={{ color: 'var(--et-ink)', marginTop: 6 }}>
            {phase === 'intro' && '我需要 30 秒读一下你的微信密钥'}
            {phase === 'restarting' && '正在安装微信 hook…'}
            {phase === 'waiting-login' && '请退出登录并重新登录微信'}
            {phase === 'success' && '✓ 密钥已就位'}
            {phase === 'error' && '没读到密钥'}
          </div>
        </div>
        <div style={{ padding: '14px 28px 24px' }}>
          {phase === 'intro' && <Intro onStart={handleStart} />}
          {phase === 'restarting' && <Restarting elapsed={elapsed} />}
          {phase === 'waiting-login' && <WaitingLogin elapsed={elapsed} />}
          {phase === 'success' && key && <Success keyHex={key} onClose={onClose} />}
          {phase === 'error' && <ErrorView error={error || '未知错误'} log={log} onRetry={() => setPhase('intro')} />}
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, body, active }: { n: number; title: string; body: string; active?: boolean }) {
  return (
    <div style={{
      display: 'flex', gap: 14, padding: '14px 0',
      opacity: active ? 1 : 0.55,
    }}>
      <div style={{
        flexShrink: 0,
        width: 28, height: 28, borderRadius: '50%',
        background: active ? 'var(--et-orange)' : 'var(--et-paper-2)',
        color: active ? '#fff' : 'var(--et-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--et-serif)', fontSize: 14, fontWeight: 600,
      }}>{n}</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--et-ink)' }}>{title}</div>
        <div className="et-meta" style={{ marginTop: 4, fontSize: 12, lineHeight: 1.55 }}>{body}</div>
      </div>
    </div>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <>
      <div className="et-meta" style={{ fontSize: 13, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        微信的密钥只在「登录的瞬间」会被计算。请按顺序完成下面三步：
      </div>
      <Step n={1} title="保持微信开着且已登录" active body="不要先退出，也不要关闭微信窗口。" />
      <Step n={2} title="点开始后，我会把 hook 装到当前微信进程" active
            body="看到等待提示后，再去微信里手动退出登录并重新登录一次。" />
      <Step n={3} title="我读到密钥后会自动保存，以后再也不用做这步" active
            body="密钥仅存在你的电脑上 (~/.murmur/config.json)，绝不上传任何地方。" />
      <div style={{
        marginTop: 16, padding: '12px 14px',
        background: 'rgba(232, 181, 122, 0.18)',
        border: '0.5px solid rgba(138, 90, 28, 0.3)',
        borderRadius: 10, fontSize: 12, color: '#8a5a1c',
      }}>
        💡 准备好了再开始 —— 这个流程不会自动关闭微信；开始后需要你手动退出登录再登录一次。
      </div>
      <button onClick={onStart} style={{
        all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
        textAlign: 'center', padding: '14px 0', marginTop: 14,
        background: 'var(--et-orange)', color: '#fff',
        borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
        boxShadow: '0 6px 16px rgba(255,107,71,0.32)',
      }}>开始抓密钥</button>
    </>
  );
}

function Restarting({ elapsed }: { elapsed: number }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 0' }}>
      <div style={{ display: 'inline-block', animation: 'spin 1.4s linear infinite', fontSize: 32 }}>⏳</div>
      <div className="et-h3" style={{ marginTop: 12, color: 'var(--et-ink)' }}>正在把 hook 装到当前微信进程</div>
      <div className="et-meta" style={{ marginTop: 6 }}>已等 {elapsed} 秒 · 装好后请去微信退出登录再登录</div>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function WaitingLogin({ elapsed }: { elapsed: number }) {
  return (
    <>
      <div style={{
        padding: '18px 20px',
        background: 'var(--et-orange-soft)',
        border: '0.5px solid rgba(224,83,46,0.36)',
        borderRadius: 'var(--et-r)',
        marginBottom: 14,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--et-orange-2)', marginBottom: 8 }}>
          👉 现在请到微信里退出登录，然后重新登录一次
        </div>
        <div className="et-meta" style={{ fontSize: 12, color: 'var(--et-ink-soft)', lineHeight: 1.6 }}>
          Hook 已经在等待登录事件。请到微信里手动「退出登录」，再扫码或自动登录回来。
          登录成功的瞬间，我这边会捕获密钥。
        </div>
      </div>
      <div style={{ height: 6, background: 'rgba(26,43,74,0.08)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{
          width: `${Math.min(95, elapsed * 1.2)}%`,
          height: '100%',
          background: 'linear-gradient(90deg, var(--et-orange) 0%, var(--et-rose) 100%)',
          borderRadius: 999, transition: 'width .8s ease',
        }}/>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <span className="et-meta" style={{ fontSize: 11 }}>已等 {elapsed} 秒</span>
        <span className="et-meta" style={{ fontSize: 11, color: 'var(--et-faint)' }}>最多等 90 秒</span>
      </div>
      <div className="et-meta" style={{ marginTop: 16, fontSize: 11, color: 'var(--et-faint)', textAlign: 'center', lineHeight: 1.5 }}>
        看到二维码或登录确认是正常的，按微信提示完成即可。<br/>
        看不到微信窗口？打开任务栏点一下微信图标。
      </div>
    </>
  );
}

function Success({ keyHex, onClose }: { keyHex: string; onClose: () => void }) {
  return (
    <>
      <div style={{
        padding: '18px 20px',
        background: 'rgba(72, 167, 107, 0.15)',
        border: '0.5px dashed rgba(72, 167, 107, 0.5)',
        borderRadius: 'var(--et-r)',
        marginBottom: 14,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#3a7a4f', marginBottom: 8 }}>
          ✓ 已成功获取并验证密钥
        </div>
        <div style={{
          fontFamily: 'var(--et-mono)', fontSize: 11,
          padding: '8px 10px', background: 'var(--et-paper-2)', borderRadius: 6,
          wordBreak: 'break-all', color: 'var(--et-ink-soft)',
        }}>{keyHex}</div>
        <div className="et-meta" style={{ marginTop: 10, fontSize: 12 }}>
          已保存到 ~/.murmur/config.json — 以后启动 Murmur 直接用，不用再读。
        </div>
      </div>
      <button onClick={onClose} style={{
        all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
        textAlign: 'center', padding: '14px 0',
        background: 'var(--et-ink)', color: 'var(--et-paper)',
        borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
      }}>开始用 Murmur</button>
    </>
  );
}

function ErrorView({ error, log, onRetry }: { error: string; log: string; onRetry: () => void }) {
  return (
    <>
      <div style={{
        padding: '14px 16px',
        background: 'rgba(196,90,63,0.12)',
        border: '0.5px solid rgba(196,90,63,0.4)',
        borderRadius: 8, marginBottom: 14,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-rose)', marginBottom: 8 }}>失败原因</div>
        <div className="et-meta" style={{ fontSize: 12, color: 'var(--et-ink-soft)', whiteSpace: 'pre-wrap' }}>{error}</div>
      </div>
      <div className="et-meta" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.6 }}>
        最常见原因：点开始后没有在微信里「退出登录 → 重新登录」。Win 上 hook 等的是登录事件，微信一直保持已登录不会触发。
      </div>
      <details style={{ marginBottom: 14 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--et-mute)' }}>查看完整日志</summary>
        <pre style={{
          marginTop: 8, padding: 10, fontSize: 10,
          background: 'var(--et-paper-2)', borderRadius: 6,
          maxHeight: 200, overflow: 'auto',
        }}>{log || '（无）'}</pre>
      </details>
      <button onClick={onRetry} style={{
        all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
        textAlign: 'center', padding: '12px 0',
        background: 'var(--et-orange)', color: '#fff',
        borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
      }}>再试一次</button>
    </>
  );
}
