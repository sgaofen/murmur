import { useEffect, useRef, useState } from 'react';
import { extractKey, getDiagnose, saveKey } from '../data/api';
import { maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: (key?: string) => void;
}

type Phase = 'intro' | 'restarting' | 'waiting-login' | 'success' | 'error';
type Platform = 'windows' | 'macos' | 'linux';

export function ExtractKeyDialog({ open, onClose, onSuccess }: Props) {
  void usePrivacy();
  const [phase, setPhase] = useState<Phase>('intro');
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string>('');
  const [elapsed, setElapsed] = useState(0);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [macKeysCount, setMacKeysCount] = useState(0);
  const elapsedTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setPhase('intro');
      setKey(null); setError(null); setLog(''); setElapsed(0); setMacKeysCount(0);
      if (elapsedTimer.current) { window.clearInterval(elapsedTimer.current); elapsedTimer.current = null; }
      return;
    }
    getDiagnose()
      .then(d => setPlatform(d.platform))
      .catch(() => setPlatform(navigator.userAgent.toLowerCase().includes('mac') ? 'macos' : 'windows'));
  }, [open]);

  if (!open) return null;

  async function handleStart() {
    setError(null);
    let currentPlatform: Platform;
    try {
      const diag = await getDiagnose();
      currentPlatform = diag.platform;
      setPlatform(diag.platform);
      if (diag.platform === 'windows' && diag.capabilities.weixin_running === false) {
        setError('没有检测到正在运行的微信进程。请先打开微信，退出到登录页但不要关闭微信程序，然后再回来点开始。');
        setPhase('error');
        return;
      }
    } catch {
      currentPlatform = platform || (navigator.userAgent.toLowerCase().includes('mac') ? 'macos' : 'windows');
    }

    const isMac = currentPlatform === 'macos';
    setPhase('restarting');
    // Start elapsed timer
    setElapsed(0);
    elapsedTimer.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    // Switch to waiting-login phase after 5s (microbatched)
    window.setTimeout(() => setPhase((p) => p === 'restarting' ? 'waiting-login' : p), 5000);

    try {
      // Windows: hook the running WeChat instead of kill+relaunch.
      // Mac: scan the running WeChat memory for per-DB WCDB keys.
      const r = await extractKey({ autoRestart: false, timeout: 90 });
      if (elapsedTimer.current) { window.clearInterval(elapsedTimer.current); elapsedTimer.current = null; }
      setLog(r.log || '');
      if (r.ok) {
        if (r.key) {
          // Windows path: persist one master key.
          await saveKey(r.key);
          setKey(r.key);
        } else if (isMac) {
          // Mac path: extract_key_mac writes ~/.murmur/decrypted_keys.json.
          setMacKeysCount(r.mac_keys_count || 0);
          setKey(null);
        } else {
          setError(r.log?.split('\n').slice(-3).join('\n') || '没有返回可保存的密钥');
          setPhase('error');
          return;
        }
        setPhase('success');
        onSuccess?.(r.key);
      } else {
        const fallback = isMac
          ? '没有在 WeChat 内存里扫到密钥。请保持微信登录，先点开几个聊天、群聊和朋友圈，再回来重试。'
          : '没有读到登录密钥。请先让微信停在登录页，再点开始抓密钥，然后 90 秒内回微信登录。';
        setError(r.log?.split('\n').slice(-6).join('\n') || fallback);
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
            {phase === 'intro' && (platform === 'macos' ? '现场抓取 Mac 解密密钥' : '我需要 30 秒读一下你的微信密钥')}
            {phase === 'restarting' && (platform === 'macos' ? '正在扫描 WeChat 内存…' : '正在安装微信 hook…')}
            {phase === 'waiting-login' && (platform === 'macos' ? '请在 WeChat 里点开聊天和朋友圈' : '请回微信登录一次')}
            {phase === 'success' && '✓ 密钥已就位'}
            {phase === 'error' && '没读到密钥'}
          </div>
        </div>
        <div style={{ padding: '14px 28px 24px' }}>
          {phase === 'intro' && <Intro isMac={platform === 'macos'} onStart={handleStart} />}
          {phase === 'restarting' && <Restarting isMac={platform === 'macos'} elapsed={elapsed} />}
          {phase === 'waiting-login' && <WaitingLogin isMac={platform === 'macos'} elapsed={elapsed} />}
          {phase === 'success' && <Success keyHex={key} macKeysCount={macKeysCount} isMac={platform === 'macos'} onClose={onClose} />}
          {phase === 'error' && <ErrorView isMac={platform === 'macos'} error={error || '未知错误'} log={log} onRetry={() => setPhase('intro')} />}
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

function Intro({ isMac, onStart }: { isMac: boolean; onStart: () => void }) {
  return (
    <>
      <div className="et-meta" style={{ fontSize: 13, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        {isMac
          ? 'Mac 版会现场扫描正在运行的 WeChat。请先让微信保持登录，并点开几个聊天、群聊和朋友圈。'
          : 'Windows 版抓的是登录事件。请先把微信退到登录页，但不要关闭微信程序，再回 Murmur 开始。'}
      </div>
      {isMac ? (
        <>
          <Step n={1} title="保持 WeChat 已登录" active body="不要退出微信，确保主窗口能打开。" />
          <Step n={2} title="先点开几个聊天和朋友圈" active
                body="Mac 微信会按需把每个数据库的 key 放进内存；你打开过，对应 key 才更容易被扫到。" />
          <Step n={3} title="点开始后现场扫描并保存" active
                body="成功后会生成 ~/.murmur/decrypted_keys.json，然后 Murmur 就能现场重新解密最新数据。" />
        </>
      ) : (
        <>
          <Step n={1} title="先把微信退到登录页" active body="只退出账号，不要退出/关闭微信程序；任务管理器里仍应有 Weixin.exe 或 WeChat.exe。" />
          <Step n={2} title="回 Murmur 点开始抓密钥" active
                body="我会把 hook 装到当前微信进程，然后等待下一次登录事件。" />
          <Step n={3} title="我读到密钥后会自动保存，以后再也不用做这步" active
                body="点开始后立刻回微信扫码/确认登录；密钥只存在你的电脑上，不会上传。" />
        </>
      )}
      <div style={{
        marginTop: 16, padding: '12px 14px',
        background: 'rgba(232, 181, 122, 0.18)',
        border: '0.5px solid rgba(138, 90, 28, 0.3)',
        borderRadius: 10, fontSize: 12, color: '#8a5a1c',
      }}>
        {isMac
          ? '准备好了再开始 —— 这个流程不会关闭微信，只会扫描本机 WeChat 内存。'
          : '准备好了再开始 —— 开始后请立刻回微信登录，90 秒内完成最稳。'}
      </div>
      <button onClick={onStart} style={{
        all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
        textAlign: 'center', padding: '14px 0', marginTop: 14,
        background: 'var(--et-orange)', color: '#fff',
        borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
        boxShadow: '0 6px 16px rgba(255,107,71,0.32)',
      }}>{isMac ? '开始现场抓取' : '开始抓密钥'}</button>
    </>
  );
}

function Restarting({ isMac, elapsed }: { isMac: boolean; elapsed: number }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 0' }}>
      <div style={{ display: 'inline-block', animation: 'spin 1.4s linear infinite', fontSize: 32 }}>⏳</div>
      <div className="et-h3" style={{ marginTop: 12, color: 'var(--et-ink)' }}>
        {isMac ? '正在扫描 WeChat 内存里的 WCDB key' : '正在把 hook 装到当前微信进程'}
      </div>
      <div className="et-meta" style={{ marginTop: 6 }}>
        {isMac ? `已等 ${elapsed} 秒 · 可以去微信点开更多聊天帮助 key 进入内存` : `已等 ${elapsed} 秒 · 装好后请回微信完成登录`}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function WaitingLogin({ isMac, elapsed }: { isMac: boolean; elapsed: number }) {
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
          {isMac ? '现在请到 WeChat 里点开聊天、群聊和朋友圈' : '现在请回微信完成登录'}
        </div>
        <div className="et-meta" style={{ fontSize: 12, color: 'var(--et-ink-soft)', lineHeight: 1.6 }}>
          {isMac
            ? 'Murmur 正在扫描本机 WeChat 内存。Mac 微信是按需打开数据库的：多点几个对话和朋友圈，能让更多 key 出现在内存里。'
            : 'Hook 已经在等待登录事件。请回微信扫码或确认登录；如果你还停在已登录状态，请先退出到登录页再登录一次。登录成功的瞬间，我这边会捕获密钥。'}
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
        {isMac ? (
          <>
            不需要退出登录，也不需要关闭微信。<br/>
            如果这次没扫到，回微信多打开几个聊天后再试一次。
          </>
        ) : (
          <>
            看到二维码或登录确认是正常的，按微信提示完成即可。<br/>
            看不到微信窗口？打开任务栏点一下微信图标。
          </>
        )}
      </div>
    </>
  );
}

function Success({ keyHex, macKeysCount, isMac, onClose }: { keyHex: string | null; macKeysCount: number; isMac: boolean; onClose: () => void }) {
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
          {isMac ? `✓ 已成功获取 ${macKeysCount || '多'} 个 Mac 数据库密钥` : '✓ 已成功获取并验证密钥'}
        </div>
        {!isMac && keyHex && (
          <div style={{
            fontFamily: 'var(--et-mono)', fontSize: 11,
            padding: '8px 10px', background: 'var(--et-paper-2)', borderRadius: 6,
            wordBreak: 'break-all', color: 'var(--et-ink-soft)',
          }}>{maskText(keyHex)}</div>
        )}
        <div className="et-meta" style={{ marginTop: 10, fontSize: 12 }}>
          {isMac
            ? '已保存到 ~/.murmur/decrypted_keys.json — 现在可以现场更新并重新解密最新数据。'
            : '已保存到 ~/.murmur/config.json — 以后启动 Murmur 直接用，不用再读。'}
        </div>
      </div>
      <button onClick={onClose} style={{
        all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
        textAlign: 'center', padding: '14px 0',
        background: 'var(--et-ink)', color: 'var(--et-paper)',
        borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
      }}>{isMac ? '更新最新数据' : '开始用 Murmur'}</button>
    </>
  );
}

function ErrorView({ isMac, error, log, onRetry }: { isMac: boolean; error: string; log: string; onRetry: () => void }) {
  const hookInstallFailed = !isMac && /hook (setup|install) failed|wx_key\.dll|注入到微信进程/i.test(`${error}\n${log}`);
  return (
    <>
      <div style={{
        padding: '14px 16px',
        background: 'rgba(196,90,63,0.12)',
        border: '0.5px solid rgba(196,90,63,0.4)',
        borderRadius: 8, marginBottom: 14,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-rose)', marginBottom: 8 }}>失败原因</div>
        <div className="et-meta" style={{ fontSize: 12, color: 'var(--et-ink-soft)', whiteSpace: 'pre-wrap' }}>{maskText(error)}</div>
      </div>
      <div className="et-meta" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.6 }}>
        {isMac
          ? '最常见原因：还没在 WeChat 里点开足够多的聊天/朋友圈，对应数据库 key 还没有进入内存。'
          : hookInstallFailed
            ? '这是 hook 安装失败，不是等登录超时。请先把 Murmur 安装目录加入杀毒/Defender 白名单，确认 wx_key.dll 没被隔离；然后重启电脑，微信和 Murmur 都用普通权限打开，再按登录页流程重试。'
            : '最常见原因：点开始后微信没有发生新的登录事件。Win 上 hook 等的是登录瞬间，微信一直保持已登录不会触发。'}
      </div>
      <details style={{ marginBottom: 14 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--et-mute)' }}>查看完整日志</summary>
        <pre style={{
          marginTop: 8, padding: 10, fontSize: 10,
          background: 'var(--et-paper-2)', borderRadius: 6,
          maxHeight: 200, overflow: 'auto',
        }}>{maskText(log || '（无）')}</pre>
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
