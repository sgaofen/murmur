import { useEffect, useState } from 'react';
import { extractKey, getDiagnose, openFullDiskAccess, refreshData, resignWechat, saveKey } from '../data/api';
import type { Diagnose } from '../data/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

type Phase = 'welcome' | 'diagnose' | 'mac-no-data' | 'mac-paste-key' | 'mac-auto-extract' | 'mac-resign-prompt' | 'mac-resigning' | 'mac-wait-login' | 'mac-fda-needed' | 'win-need-key' | 'win-decrypt' | 'extract-key' | 'done' | 'error';

export function OnboardingDialog({ open, onClose, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('welcome');
  const [diag, setDiag] = useState<Diagnose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setPhase('welcome');
    setError(null);
  }, [open]);

  if (!open) return null;

  async function startDiagnose() {
    setPhase('diagnose');
    try {
      const d = await getDiagnose();
      setDiag(d);
      const hasDecrypted = d.profiles.some(p => p.has_decrypted_data);
      const hasWeChatData = d.profiles.length > 0;
      // Decision tree:
      if (hasDecrypted) {
        setPhase('done');  // existing data — just enter the app
      } else if (d.platform === 'windows' && hasWeChatData && !d.saved_key) {
        setPhase('win-need-key');  // Win can auto-extract key
      } else if (d.platform === 'windows' && hasWeChatData && d.saved_key) {
        // Win with key but no decrypted yet — go straight to decrypt
        await runDecrypt();
      } else if (d.platform === 'macos' && d.capabilities.tcc_blocked) {
        // Highest-priority Mac branch: TCC blocked the backend from reading
        // ~/Library/Containers/<wechat>. Without this permission nothing else
        // can succeed — show the FDA-grant flow first.
        setPhase('mac-fda-needed');
      } else if (d.platform === 'macos' && hasWeChatData) {
        if (d.saved_key) {
          await runDecrypt();
        } else if (d.capabilities.can_extract_key) {
          setPhase('mac-auto-extract');
        } else if (d.capabilities.wechat_hardened === true) {
          setPhase('mac-resign-prompt');
        } else {
          setPhase('mac-paste-key');
        }
      } else if (d.platform === 'macos' && !hasWeChatData) {
        setPhase('mac-no-data');
      } else {
        setError('看起来你还没在这台电脑上登录过微信，请先用微信登录一次。');
        setPhase('error');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function runDecrypt() {
    setProgress('正在解密所有微信数据库…');
    setPhase('win-decrypt');
    try {
      const r = await refreshData();
      if (r.ok) setPhase('done');
      else { setError(r.details || '解密失败'); setPhase('error'); }
    } catch (e: any) {
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function submitMacKey(key: string) {
    const cleaned = key.trim().toLowerCase();
    if (cleaned.length !== 64 || !/^[0-9a-f]+$/.test(cleaned)) {
      setError('密钥格式不对：必须是 64 位十六进制字符（0-9a-f）');
      setPhase('error');
      return;
    }
    try {
      const sr = await saveKey(cleaned);
      if (!sr.ok) {
        setError(sr.error || '保存密钥失败');
        setPhase('error');
        return;
      }
      await runDecrypt();
    } catch (e: any) {
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function startKeyExtract() {
    setPhase('extract-key');
    setProgress(diag?.platform === 'windows'
      ? 'Hook 正在等待登录事件：请保持微信在登录页，然后去微信点击登录 / 扫码登录…'
      : '扫描 WeChat 进程内存中…');
    try {
      // autoRestart=false: hook the existing WeChat instead of kill+relaunch.
      // Kill+relaunch on Win11 + WeChat 4.1.x sometimes makes the new Weixin.exe die
      // before the hook can attach. The reliable flow is: user logs out first
      // and leaves WeChat at the login page, then Murmur installs the hook, then
      // the user logs in so the hook can catch the login event.
      const r = await extractKey({ autoRestart: false, timeout: 90 });
      // On Mac, extract_key_mac.py writes ~/.murmur/decrypted_keys.json directly.
      // r.ok=true with no r.key means the per-DB JSON was written.
      // On Win, r.key holds the password we still need to save.
      if (!r.ok) {
        const fallback = diag?.platform === 'windows'
          ? '没读到密钥 — 请确认微信程序没有关闭：先让微信停在登录页，再点 Murmur 的开始抓密钥，然后在 90 秒内回微信完成登录。'
          : '没读到密钥 — 请确保已登录微信并点开几个对话';
        setError(r.log?.split('\n').slice(-6).join('\n') || fallback);
        setPhase('error');
        return;
      }
      if (r.key) {
        // Windows path
        await saveKey(r.key);
      }
      setProgress('密钥已就位，开始解密…');
      setPhase('win-decrypt');
      const r2 = await refreshData();
      if (r2.ok) {
        setPhase('done');
      } else {
        setError(r2.details || '解密失败');
        setPhase('error');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function startResign() {
    setPhase('mac-resigning');
    setProgress('退出 WeChat 并重签名…（系统会弹窗要开机密码）');
    try {
      const r = await resignWechat({ relaunch: true });
      if (!r.ok) {
        setError(r.error || r.stderr || '重签名失败 — 你可能取消了授权');
        setPhase('error');
        return;
      }
      setPhase('mac-wait-login');
    } catch (e: any) {
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function openFDAAndWait() {
    try {
      await openFullDiskAccess();
    } catch (e: any) {
      // If endpoint fails (rare), still show the manual instructions
      console.warn('open-fda failed', e);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(20,24,42,0.62)',
      backdropFilter: 'blur(10px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        width: 640, maxWidth: '94%',
        background: 'var(--et-paper)',
        borderRadius: 'var(--et-r-lg)',
        boxShadow: 'var(--et-shadow-3)',
        border: '0.5px solid var(--et-line-2)',
        overflow: 'hidden', position: 'relative',
      }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, background: 'var(--et-orange)' }} />
        <button onClick={onClose} title="跳过引导（不推荐）" style={{
          position: 'absolute', top: 14, right: 14, all: 'unset', cursor: 'pointer',
          width: 28, height: 28, borderRadius: 8, color: 'var(--et-mute)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round" />
          </svg>
        </button>
        <div style={{ padding: '28px 32px 0' }}>
          <div className="et-eyebrow" style={{ color: 'var(--et-orange)' }}>欢迎来到 Murmur</div>
          <div className="et-h1" style={{ color: 'var(--et-ink)', marginTop: 8, fontSize: 32 }}>
            {phase === 'welcome' && '回顾你的微信故事'}
            {phase === 'diagnose' && '正在检测你的电脑…'}
            {phase === 'mac-no-data' && 'Mac 上需要先从 Windows 同步数据'}
            {phase === 'mac-auto-extract' && '一切就绪 — 一键抓密钥'}
            {phase === 'mac-resign-prompt' && '一次性给 WeChat 重签名（不需要关 SIP）'}
            {phase === 'mac-resigning' && '正在重签名…'}
            {phase === 'mac-wait-login' && '微信已重启，请登录 → 然后回来抓密钥'}
            {phase === 'mac-fda-needed' && '第一步：给 Murmur 完全磁盘访问权限'}
            {phase === 'win-need-key' && '只需要 30 秒，读取一次密钥'}
            {phase === 'extract-key' && '正在读取密钥…'}
            {phase === 'win-decrypt' && '正在解密最新数据…'}
            {phase === 'done' && '✓ 一切就绪'}
            {phase === 'error' && '出了点小问题'}
          </div>
        </div>
        <div style={{ padding: '14px 32px 28px' }}>
          {phase === 'welcome' && <Welcome onNext={startDiagnose} />}
          {phase === 'diagnose' && <Diagnosing />}
          {phase === 'mac-no-data' && diag && <MacNoData diag={diag} onClose={onClose} />}
          {phase === 'mac-paste-key' && diag && <MacPasteKey diag={diag} onSubmit={submitMacKey} />}
          {phase === 'mac-auto-extract' && diag && <MacAutoExtract diag={diag} onStart={startKeyExtract} onPaste={() => setPhase('mac-paste-key')} />}
          {phase === 'mac-resign-prompt' && diag && <MacResignPrompt diag={diag} onConsent={startResign} onPaste={() => setPhase('mac-paste-key')} />}
          {phase === 'mac-resigning' && <Working text={progress || '正在重签名…'} />}
          {phase === 'mac-wait-login' && <MacWaitLogin onContinue={startKeyExtract} />}
          {phase === 'mac-fda-needed' && <MacFDANeeded onOpenSettings={openFDAAndWait} onRetry={startDiagnose} />}
          {phase === 'win-need-key' && diag && <WinNeedKey diag={diag} onStart={startKeyExtract} />}
          {phase === 'extract-key' && <Working text={progress} />}
          {phase === 'win-decrypt' && <Working text={progress || "正在解密所有微信数据库…"} />}
          {phase === 'done' && <Done onDone={() => { onClose(); onDone?.(); }} />}
          {phase === 'error' && <ErrorView error={error || ''} diag={diag} onRetry={startDiagnose} />}
        </div>
      </div>
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className="et-serif" style={{ fontSize: 17, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 18 }}>
        Murmur 是一本关于你这些年聊天的<strong>本地</strong>纪念册 ——
        所有数据从微信读出，分析后只在你的电脑上呈现，不会上传到任何地方。
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
        {[
          ['🔒', '完全本地', '从读取密钥到分析，一切在你的电脑上完成。'],
          ['🤖', '可选 AI 分析', '检测到本机的 Claude Code / Codex，可以让 AI 直接读你的关系档案。'],
          ['📓', '杂志风回顾', '不是冰冷的统计，是你和老朋友之间故事的体面整理。'],
        ].map(([icon, title, body]) => (
          <div key={title} style={{ display: 'flex', gap: 14, padding: '12px 14px',
            background: 'var(--et-paper-2)', borderRadius: 12 }}>
            <div style={{ fontSize: 22 }}>{icon}</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--et-ink)' }}>{title}</div>
              <div className="et-meta" style={{ fontSize: 12, marginTop: 2 }}>{body}</div>
            </div>
          </div>
        ))}
      </div>
      <button onClick={onNext} style={primaryBtn}>开始</button>
    </>
  );
}

function Diagnosing() {
  return (
    <div style={{ textAlign: 'center', padding: '40px 0' }}>
      <div style={{ display: 'inline-block', animation: 'spin 1.4s linear infinite', fontSize: 32 }}>⚙️</div>
      <div className="et-meta" style={{ marginTop: 16 }}>检测系统、微信安装、已有数据…</div>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function CapabilityList({ diag }: { diag: Diagnose }) {
  const rows: Array<[string, string, boolean]> = [
    ['平台', diag.platform === 'windows' ? 'Windows ✓' : diag.platform === 'macos' ? 'macOS' : diag.platform, true],
    ['微信安装', diag.capabilities.has_wechat_installed ? '已安装 ✓' : '未找到', diag.capabilities.has_wechat_installed],
    ['微信数据', diag.capabilities.has_wechat_data ? '已找到 ✓' : '没有 ❌', diag.capabilities.has_wechat_data],
    ['可解密数据库', diag.capabilities.can_decrypt_db ? '可以 ✓' : '不行 ⚠', diag.capabilities.can_decrypt_db],
    ['可抓取密钥', diag.capabilities.can_extract_key ? '可以 ✓' : '不行 ⚠', diag.capabilities.can_extract_key],
  ];
  if (diag.platform === 'macos') {
    if (diag.capabilities.wechat_hardened !== null && diag.capabilities.wechat_hardened !== undefined) {
      rows.push(['WeChat 签名状态', diag.capabilities.wechat_hardened ? 'hardened（默认）' : 'ad-hoc ✓', !diag.capabilities.wechat_hardened]);
    }
    if (diag.capabilities.sip_enabled !== null && diag.capabilities.sip_enabled !== undefined) {
      rows.push(['SIP（系统完整性保护）', diag.capabilities.sip_enabled ? '开启（默认）' : '已关闭', true]);
    }
    if (diag.capabilities.weixin_running !== null && diag.capabilities.weixin_running !== undefined) {
      rows.push(['微信进程', diag.capabilities.weixin_running ? '运行中 ✓' : '未运行', !!diag.capabilities.weixin_running]);
    }
  }
  if (diag.wechat_search_roots?.length) {
    rows.push(['扫描路径', `${diag.wechat_search_roots.length} 个`, true]);
  }
  rows.push(['本机 AI agents', `${diag.agents_found} 个 ✓`, true]);
  return (
    <div style={{ background: 'var(--et-paper-2)', padding: '12px 16px', borderRadius: 10, fontSize: 12 }}>
      {rows.map(([k, v, ok]) => (
        <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
          <span style={{ color: 'var(--et-mute)' }}>{k}</span>
          <span style={{ color: ok ? 'var(--et-ink)' : 'var(--et-rose)', fontWeight: 500 }}>{v}</span>
        </div>
      ))}
      {diag.profiles.length === 0 && diag.wechat_search_roots?.length ? (
        <details open style={{ marginTop: 8, borderTop: '0.5px solid var(--et-line)', paddingTop: 8 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--et-mute)', marginBottom: 6 }}>已扫描的微信数据位置</summary>
          <div style={{ maxHeight: 140, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {diag.wechat_search_roots.slice(0, 30).map((p) => (
              <code key={p} style={{ fontFamily: 'var(--et-mono)', color: 'var(--et-ink-soft)', wordBreak: 'break-all' }}>{p}</code>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function MacNoData({ diag, onClose }: { diag: Diagnose; onClose: () => void }) {
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 16 }}>
        在 Mac 上没找到微信数据。两个选项：
      </div>
      <ol style={{ paddingLeft: 20, lineHeight: 1.8, fontSize: 13, color: 'var(--et-ink)' }}>
        <li>在这台 Mac 上登录一次微信，让它生成数据</li>
        <li>从 Windows 拷过来：<code style={{ background: 'var(--et-paper-2)', padding: '2px 6px', borderRadius: 4, fontFamily: 'var(--et-mono)' }}>~/Documents/Murmur/decrypted/</code></li>
      </ol>
      <CapabilityList diag={diag} />
      <button onClick={onClose} style={{ ...primaryBtn, background: 'var(--et-ink)' }}>知道了</button>
    </>
  );
}

function MacPasteKey({ diag, onSubmit }: { diag: Diagnose; onSubmit: (key: string) => void }) {
  const [key, setKey] = useState('');
  const cleaned = key.trim().toLowerCase();
  const valid = cleaned.length === 64 && /^[0-9a-f]+$/.test(cleaned);
  const sipOn = diag.capabilities.sip_enabled === true;
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        {sipOn
          ? <>Mac 默认开着 <strong>SIP（系统完整性保护）</strong>，导致无法自动从微信进程内存抓密钥。<br/>三种办法可以拿到 64 位 SQLCipher 密钥，任选一个：</>
          : <>把 64 位 SQLCipher 密钥粘进来，解密在你这台 Mac 上跑。</>}
      </div>
      <div style={{
        padding: '12px 14px', background: 'rgba(255,107,71,0.08)',
        border: '0.5px solid rgba(224,83,46,0.30)', borderRadius: 8,
        fontSize: 12.5, color: 'var(--et-ink-soft)', lineHeight: 1.7, marginBottom: 14,
      }}>
        <div style={{ marginBottom: 6 }}><strong style={{ color: 'var(--et-orange-2)' }}>① 有 Windows 电脑（最快）</strong></div>
        <div style={{ paddingLeft: 14, marginBottom: 10 }}>
          在 Win 上 <code>git clone</code> 这个仓库 → 运行 <code>start-windows.bat</code>。引导跑完后，密钥就在 <code>~/.murmur/config.json</code> 里 <code>decrypt_key</code> 字段，拷过来粘到下面。
        </div>
        <div style={{ marginBottom: 6 }}><strong style={{ color: 'var(--et-orange-2)' }}>② 关掉 Mac 的 SIP（一次性）</strong></div>
        <div style={{ paddingLeft: 14, marginBottom: 10 }}>
          重启进恢复模式（开机长按电源键）→ 终端运行 <code>csrutil disable</code> → 重启 → 在这个仓库根目录运行：
          <pre style={{ background: 'var(--et-paper-2)', padding: '6px 10px', borderRadius: 4, marginTop: 4, fontSize: 11, fontFamily: 'var(--et-mono)' }}>sudo python3 cli/extract_key_mac.py</pre>
          密钥会打印在终端里。<em style={{ color: 'var(--et-mute)' }}>注意：关 SIP 是系统级操作，请权衡。</em>
        </div>
        <div style={{ marginBottom: 6 }}><strong style={{ color: 'var(--et-orange-2)' }}>③ 借朋友的 Win 跑一次</strong></div>
        <div style={{ paddingLeft: 14 }}>
          在朋友 Win 上短时间登录你的微信 → 跑 <code>cli/extract_key_dll.py</code> → 拷密钥回来。微信账号是同一个，密钥相同。
        </div>
      </div>
      <input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="把 64 位 hex 密钥粘到这里"
        spellCheck={false}
        autoFocus
        style={{
          all: 'unset', width: '100%', boxSizing: 'border-box',
          padding: '10px 14px', borderRadius: 8,
          border: `1px solid ${valid ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
          background: 'var(--et-paper-2)', fontFamily: 'var(--et-mono)',
          fontSize: 12, color: 'var(--et-ink)', marginBottom: 8,
        }}
      />
      <div style={{ fontSize: 11, color: 'var(--et-mute)', marginBottom: 14 }}>
        {key && (valid ? '✓ 格式正确（64 位 hex）' : `${cleaned.length}/64 位 hex`)}
      </div>
      <CapabilityList diag={diag} />
      <button onClick={() => onSubmit(key)} disabled={!valid} style={{
        ...primaryBtn,
        opacity: valid ? 1 : 0.4,
        cursor: valid ? 'pointer' : 'not-allowed',
      }}>解密 + 进入</button>
    </>
  );
}

function MacFDANeeded({ onOpenSettings, onRetry }: { onOpenSettings: () => void; onRetry: () => void }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        macOS 出于隐私保护，不让普通 App 直接读 <code>~/Library/Containers/</code> 里其他 App 的数据。
        <br/>
        Murmur 需要读你电脑上的微信加密数据库 —— 必须由你手动给一次「<strong>完全磁盘访问</strong>」权限。
      </div>
      <div style={{
        padding: '12px 16px', background: 'var(--et-paper-2)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 8,
        fontSize: 13, lineHeight: 1.8, marginBottom: 14, color: 'var(--et-ink)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>3 步搞定（约 30 秒）：</div>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>点下面 <strong>「打开系统设置」</strong> → 自动跳到「完全磁盘访问」面板</li>
          <li>找到 <strong>Murmur</strong>，把右边开关打 <strong>开</strong>（如果没列出来，点 <strong>+</strong> 选 <code>/Applications/Murmur.app</code>）</li>
          <li>授权完后，<strong>完全退出 Murmur 再重新打开</strong>（macOS 必须重启进程才生效）</li>
        </ol>
      </div>
      <div style={{
        padding: '10px 14px', background: 'rgba(232,181,122,0.18)',
        border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
        fontSize: 11.5, color: '#8a5a1c', lineHeight: 1.6, marginBottom: 14,
      }}>
        💡 这是 macOS 的硬性要求 —— 任何想读微信数据的 Mac 工具都得过这一步。授权后只这一次。
      </div>
      <button onClick={() => { setOpened(true); onOpenSettings(); }} style={primaryBtn}>
        打开系统设置 → 完全磁盘访问
      </button>
      <button onClick={onRetry} style={{
        ...primaryBtn, marginTop: 8, background: 'transparent',
        color: 'var(--et-ink)', boxShadow: 'none',
        border: '1px solid var(--et-line-2)',
        opacity: opened ? 1 : 0.5,
      }}>
        我已经授权 + 重启过了 — 重新检测
      </button>
    </>
  );
}

function MacResignPrompt({ diag, onConsent, onPaste }: { diag: Diagnose; onConsent: () => void; onPaste: () => void }) {
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        macOS 默认给 WeChat 加了 <strong>hardened runtime</strong> 标记，导致系统拒绝任何调试器附加 ——
        所以也不能从内存里抓 SQLCipher 密钥。<br/>
        但有个不需要重启、不需要关 SIP 的优雅做法：<strong>给 WeChat 重新做一次 ad-hoc 签名</strong>。
      </div>
      <div style={{
        padding: '12px 14px', background: 'var(--et-paper-2)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 8,
        fontSize: 13, color: 'var(--et-ink)', lineHeight: 1.85, marginBottom: 12,
      }}>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>点确认后我会做这几件事：</div>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li style={{ marginBottom: 4 }}>退出 WeChat（在跑的话）</li>
          <li style={{ marginBottom: 4 }}>弹 macOS 系统认证窗 — <strong>输入开机密码</strong></li>
          <li style={{ marginBottom: 4 }}>对 WeChat 主可执行文件做 <code>codesign --remove-signature</code> + 重新 ad-hoc 签名</li>
          <li>重启 WeChat → <strong>停在你这里等你下一步</strong>，不会自动跑抓 key</li>
        </ol>
        <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(72,167,107,0.10)',
          borderRadius: 6, fontSize: 12, color: '#3a7a4f' }}>
          重签名完成后会到下一页「请扫码登录 + 点开几个对话」，<strong>那一步没有时间限制</strong>，
          慢慢操作 — 你点完按钮我才开始抓密钥。
        </div>
      </div>
      <div style={{
        padding: '10px 14px', background: 'rgba(232,181,122,0.18)',
        border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
        fontSize: 11.5, color: '#8a5a1c', lineHeight: 1.6, marginBottom: 14,
      }}>
        ⚠ 重签名是合法但属于「修改 App」操作。WeChat 自己升级时会把签名重置回原样，不影响后续使用。
        如果不想动 WeChat，下面有「手动粘贴密钥」的备选路径。
      </div>
      <CapabilityList diag={diag} />
      <button onClick={onConsent} style={primaryBtn}>确认重签名（系统会弹密码窗口）</button>
      <button onClick={onPaste} style={{
        ...primaryBtn, marginTop: 8, background: 'transparent',
        color: 'var(--et-ink)', boxShadow: 'none',
        border: '1px solid var(--et-line-2)',
      }}>不用，我手动粘贴密钥</button>
    </>
  );
}

function MacWaitLogin({ onContinue }: { onContinue: () => void }) {
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        ✓ 重签名成功 — 微信已经重新启动。
      </div>
      <div style={{
        padding: '12px 14px', background: 'var(--et-paper-2)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 8,
        fontSize: 14, lineHeight: 1.85, marginBottom: 12, color: 'var(--et-ink)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>下一步要做的（不急，慢慢来）：</div>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li style={{ marginBottom: 6 }}>到微信窗口，<strong>用手机扫码登录</strong></li>
          <li style={{ marginBottom: 6 }}>等左边联系人列表加载完，<strong>点开 3-5 个对话</strong>，每个滑两下</li>
          <li style={{ marginBottom: 6 }}>顺手翻一下朋友圈 / 收藏 / 联系人页</li>
          <li>都做完了再回来点下面按钮 — <strong>不需要赶时间</strong></li>
        </ol>
      </div>
      <div style={{
        padding: '10px 14px', background: 'rgba(72,167,107,0.10)',
        border: '0.5px solid rgba(72,167,107,0.30)', borderRadius: 8,
        fontSize: 12, color: '#3a7a4f', marginBottom: 14, lineHeight: 1.6,
      }}>
        💡 为啥要点开对话？WCDB 是「点哪个 DB 才解锁哪个 DB」的，没点开 → 那个 DB 的 key 不在内存里 → 我抓出来会缺几个库。<br/>
        点完再来按下面按钮，会弹密码窗口（要 root 权限扫内存），输完就开始扫。
      </div>
      <button onClick={onContinue} style={primaryBtn}>WeChat 都准备好了 → 开始抓密钥</button>
    </>
  );
}

function MacAutoExtract({ diag, onStart, onPaste }: { diag: Diagnose; onStart: () => void; onPaste: () => void }) {
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 12 }}>
        我会附加到微信进程扫内存抓 SQLCipher 密钥。<br/>
      </div>
      <div style={{
        padding: '12px 14px', background: 'var(--et-paper-2)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 8,
        fontSize: 13, lineHeight: 1.8, marginBottom: 12, color: 'var(--et-ink)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>点确认前请先做完这几步：</div>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li><strong>WeChat 已经登录</strong>（不是登录界面，是已经能看消息列表）</li>
          <li><strong>点开 3-5 个对话</strong>、翻一下朋友圈 — 让 WCDB 把每个 DB 的 key 派生到内存。不点开 → 抓出来的 key 数会少</li>
          <li>WeChat 别关掉，继续在跑</li>
        </ol>
      </div>
      <div style={{
        padding: '10px 14px', background: 'rgba(232,181,122,0.18)',
        border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
        fontSize: 11.5, color: '#8a5a1c', lineHeight: 1.6, marginBottom: 14,
      }}>
        💡 准备好了再点下面 — 一旦点确认，30 秒内会弹一次 macOS 系统密码窗口，输入开机密码后立刻开扫。
      </div>
      <CapabilityList diag={diag} />
      <button onClick={onStart} style={primaryBtn}>WeChat 已就绪 → 开始抓取</button>
      <button onClick={onPaste} style={{
        ...primaryBtn, marginTop: 8, background: 'transparent',
        color: 'var(--et-ink)', boxShadow: 'none',
        border: '1px solid var(--et-line-2)',
      }}>或者：手动粘贴密钥</button>
    </>
  );
}

function WinNeedKey({ diag, onStart }: { diag: Diagnose; onStart: () => void }) {
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        Windows 抓密钥要卡准登录那一刻，请按这个顺序做：
      </div>
      <ol style={{ paddingLeft: 20, lineHeight: 1.9, fontSize: 13, color: 'var(--et-ink)', marginBottom: 14 }}>
        <li>先去微信里<strong>退出登录</strong>，让微信停在登录页；<strong>不要关闭微信程序</strong></li>
        <li>回到 Murmur，点下面的「开始抓密钥」—— 我会把 hook 装到当前微信进程</li>
        <li>看到「等待登录事件」后，立刻回微信点<strong>登录 / 扫码登录</strong></li>
        <li>读到密钥后，立即解密所有数据，进入 Murmur 主界面</li>
      </ol>
      <div style={{
        padding: '10px 14px', background: 'rgba(232,181,122,0.18)',
        border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
        fontSize: 12, color: '#8a5a1c', marginBottom: 14,
      }}>
        💡 关键点：先停在登录页，再点开始扫描，最后去微信登录。已经登录着不动，hook 抓不到那一瞬间的 key。
      </div>
      <CapabilityList diag={diag} />
      <button onClick={onStart} style={primaryBtn}>开始抓密钥</button>
    </>
  );
}

function Working({ text }: { text: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '32px 0' }}>
      <div style={{ display: 'inline-block', animation: 'spin 1.4s linear infinite', fontSize: 32 }}>⏳</div>
      <div className="et-h3" style={{ marginTop: 16 }}>{text}</div>
      <div className="et-meta" style={{ marginTop: 8 }}>过程中如果看到微信弹窗，记得点「登录」。</div>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Done({ onDone }: { onDone: () => void }) {
  return (
    <>
      <div style={{
        padding: '16px 18px',
        background: 'rgba(72,167,107,0.15)',
        border: '0.5px dashed rgba(72,167,107,0.5)',
        borderRadius: 10, marginBottom: 16,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#3a7a4f' }}>
          一切就绪 — 你的关系档案已经就位
        </div>
        <div className="et-meta" style={{ marginTop: 6 }}>
          密钥保存在 ~/.murmur/config.json，下次启动直接读取，不用再重新抓。
        </div>
      </div>
      <button onClick={onDone} style={primaryBtn}>进入年代记</button>
    </>
  );
}

function ErrorView({ error, diag, onRetry }: { error: string; diag: Diagnose | null; onRetry: () => void }) {
  return (
    <>
      <div style={{
        padding: '12px 14px', background: 'rgba(196,90,63,0.12)',
        border: '0.5px solid rgba(196,90,63,0.4)',
        borderRadius: 8, marginBottom: 14,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-rose)', marginBottom: 6 }}>失败原因</div>
        <pre className="et-meta" style={{ fontSize: 11, color: 'var(--et-ink-soft)',
          whiteSpace: 'pre-wrap', margin: 0 }}>{error}</pre>
      </div>
      {diag && (
        <details style={{ marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--et-mute)' }}>查看诊断信息（请提交 issue 时附上）</summary>
          <CapabilityList diag={diag} />
        </details>
      )}
      <button onClick={onRetry} style={primaryBtn}>再试一次</button>
    </>
  );
}

const primaryBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
  textAlign: 'center', padding: '14px 0', marginTop: 8,
  background: 'var(--et-orange)', color: '#fff',
  borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
  boxShadow: '0 6px 16px rgba(255,107,71,0.32)',
};
