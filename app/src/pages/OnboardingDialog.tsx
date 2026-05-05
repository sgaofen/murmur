import { useEffect, useState } from 'react';
import { extractKey, getDiagnose, openFullDiskAccess, refreshData, resignWechat, saveKey, saveWeChatRoot, startDiskScan, getDiskScanStatus, cancelDiskScan } from '../data/api';
import type { Diagnose, ScanState, ScanFound } from '../data/api';
import { maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';

interface Props {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  onPickQQ?: () => void;
}

type Phase = 'welcome' | 'diagnose' | 'mac-no-data' | 'mac-paste-key' | 'mac-auto-extract' | 'mac-resign-prompt' | 'mac-resigning' | 'mac-wait-login' | 'mac-fda-needed' | 'win-no-data' | 'win-need-key' | 'win-decrypt' | 'extract-key' | 'done' | 'error';

export function OnboardingDialog({ open, onClose, onDone, onPickQQ }: Props) {
  void usePrivacy();
  const [phase, setPhase] = useState<Phase>('welcome');
  const [diag, setDiag] = useState<Diagnose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setPhase('welcome');
    setError(null);
  }, [open]);

  useEffect(() => {
    if (
      !open ||
      phase !== 'win-need-key' ||
      diag?.platform !== 'windows' ||
      diag.capabilities.weixin_running !== false
    ) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const d = await getDiagnose();
        if (!cancelled) setDiag(d);
      } catch {
        // Keep the current diagnostic card visible; the manual button can still retry.
      }
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, phase, diag?.platform, diag?.capabilities.weixin_running]);

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
      } else if (d.platform === 'windows' && !hasWeChatData) {
        setPhase('win-no-data');
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
    try {
      if (diag?.platform === 'windows') {
        const latest = await getDiagnose();
        setDiag(latest);
        if (latest.capabilities.weixin_running === false) {
          setError('没有检测到正在运行的 Weixin.exe / WeChat.exe。请先打开微信，让它停在登录页但不要关闭程序；然后回到 Murmur 点「再次检测微信」。');
          setPhase('error');
          return;
        }
      }
      setPhase('extract-key');
      setProgress(diag?.platform === 'windows'
        ? 'Hook 正在等待登录事件：请保持微信在登录页，然后去微信点击登录 / 扫码登录…'
        : '扫描 WeChat 进程内存中…');
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
        setError(r.log?.split('\n').slice(-12).join('\n') || fallback);
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
        setError([r.error, r.stderr].filter(Boolean).join('\n') || '重签名失败：请确认系统密码窗口没有被取消。');
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
            {phase === 'mac-no-data' && 'Mac 上还没找到微信数据'}
            {phase === 'mac-auto-extract' && '一切就绪 — 一键抓密钥'}
            {phase === 'mac-resign-prompt' && '一次性给 WeChat 重签名（不需要关 SIP）'}
            {phase === 'mac-resigning' && '正在重签名…'}
            {phase === 'mac-wait-login' && '微信已重启，请登录 → 然后回来抓密钥'}
            {phase === 'mac-fda-needed' && '第一步：给 Murmur 完全磁盘访问权限'}
            {phase === 'win-no-data' && '没找到微信数据目录'}
            {phase === 'win-need-key' && '只需要 30 秒，读取一次密钥'}
            {phase === 'extract-key' && '正在读取密钥…'}
            {phase === 'win-decrypt' && '正在解密最新数据…'}
            {phase === 'done' && '✓ 一切就绪'}
            {phase === 'error' && '出了点小问题'}
          </div>
        </div>
        <div style={{ padding: '14px 32px 28px' }}>
          {phase === 'welcome' && <Welcome onNext={startDiagnose} onPickQQ={onPickQQ} />}
          {phase === 'diagnose' && <Diagnosing />}
          {phase === 'mac-no-data' && diag && <MacNoData diag={diag} onSaved={startDiagnose} onRetry={startDiagnose} onOpenSettings={openFDAAndWait} />}
          {phase === 'mac-paste-key' && diag && <MacPasteKey diag={diag} onSubmit={submitMacKey} />}
          {phase === 'mac-auto-extract' && diag && <MacAutoExtract diag={diag} onStart={startKeyExtract} onPaste={() => setPhase('mac-paste-key')} />}
          {phase === 'mac-resign-prompt' && diag && <MacResignPrompt diag={diag} onConsent={startResign} onPaste={() => setPhase('mac-paste-key')} />}
          {phase === 'mac-resigning' && <Working text={progress || '正在重签名…'} />}
          {phase === 'mac-wait-login' && <MacWaitLogin onContinue={startKeyExtract} />}
          {phase === 'mac-fda-needed' && <MacFDANeeded onOpenSettings={openFDAAndWait} onRetry={startDiagnose} />}
          {phase === 'win-no-data' && diag && <WinNoData diag={diag} onSaved={startDiagnose} />}
          {phase === 'win-need-key' && diag && <WinNeedKey diag={diag} onStart={startKeyExtract} onRetry={startDiagnose} />}
          {phase === 'extract-key' && <Working text={progress} />}
          {phase === 'win-decrypt' && <Working text={progress || "正在解密所有微信数据库…"} />}
          {phase === 'done' && <Done onDone={() => { onClose(); onDone?.(); }} />}
          {phase === 'error' && <ErrorView error={error || ''} diag={diag} onRetry={startDiagnose} />}
        </div>
      </div>
    </div>
  );
}

function Welcome({ onNext, onPickQQ }: { onNext: () => void; onPickQQ?: () => void }) {
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
      <button onClick={onNext} style={primaryBtn}>开始（微信）</button>
      {onPickQQ && (
        <button onClick={onPickQQ} style={{
          ...primaryBtn, marginTop: 8, background: 'transparent',
          color: 'var(--et-ink)', boxShadow: 'none',
          border: '1px solid var(--et-line-2)',
        }}>🐧 切换到 QQ</button>
      )}
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
  }
  if (diag.capabilities.weixin_running !== null && diag.capabilities.weixin_running !== undefined) {
    rows.push(['微信进程', diag.capabilities.weixin_running ? '运行中 ✓' : '未运行', !!diag.capabilities.weixin_running]);
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
              <code key={p} style={{ fontFamily: 'var(--et-mono)', color: 'var(--et-ink-soft)', wordBreak: 'break-all' }}>{maskText(p)}</code>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function MacNoData({ diag, onSaved, onRetry, onOpenSettings }: {
  diag: Diagnose;
  onSaved: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    const cleaned = path.trim();
    if (!cleaned) {
      setMsg('请先粘贴一个路径。');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const r = await saveWeChatRoot(cleaned);
      if (!r.ok) {
        setMsg(r.error || '这个路径里没有找到微信数据。');
        return;
      }
      setMsg(`✓ 已找到 ${r.profiles?.length || 1} 个微信账号，正在重新检测…`);
      window.setTimeout(onSaved, 450);
    } catch (e: any) {
      setMsg(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 16 }}>
        Murmur 没在当前可读取的位置找到微信数据。通常是这几种情况：
      </div>
      <ul style={{ paddingLeft: 20, lineHeight: 1.8, fontSize: 13, color: 'var(--et-ink)', marginBottom: 14 }}>
        <li>这台 Mac 还没登录过微信，或微信还没完成首次同步</li>
        <li>macOS 权限挡住了微信容器目录，需要给 Murmur 完全磁盘访问</li>
        <li>微信数据被迁移到了自定义目录，需要手动告诉 Murmur</li>
      </ul>
      <CapabilityList diag={diag} />
      <div style={{
        padding: '12px 14px', background: 'var(--et-paper-2)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 8,
        fontSize: 12.5, color: 'var(--et-ink-soft)', lineHeight: 1.7,
        marginTop: 14, marginBottom: 12,
      }}>
        <div style={{ fontWeight: 600, color: 'var(--et-ink)', marginBottom: 6 }}>手动指定微信数据位置</div>
        可以粘贴 <code>.../xwechat_files</code>、<code>.../wxid_xxx</code>、<code>.../db_storage</code>，Murmur 会自动向上/向下找正确层级。
      </div>
      <input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="/Users/你/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"
        spellCheck={false}
        onKeyDown={(e) => { if (e.key === 'Enter' && !saving) submit(); }}
        style={{
          all: 'unset', width: '100%', boxSizing: 'border-box',
          padding: '10px 14px', borderRadius: 8,
          border: '1px solid var(--et-line-2)', background: 'var(--et-paper-2)',
          fontFamily: 'var(--et-mono)', fontSize: 12, color: 'var(--et-ink)',
          marginBottom: 10,
        }}
      />
      {msg && (
        <div className="et-meta" style={{
          color: msg.startsWith('✓') ? '#3a7a4f' : 'var(--et-rose)',
          marginBottom: 12, whiteSpace: 'pre-wrap',
        }}>{maskText(msg)}</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
        <button onClick={onRetry} style={{
          ...primaryBtn, marginTop: 0, background: 'transparent',
          color: 'var(--et-ink)', boxShadow: 'none', border: '1px solid var(--et-line-2)',
        }}>重新检测</button>
        <button onClick={onOpenSettings} style={{
          ...primaryBtn, marginTop: 0, background: 'transparent',
          color: 'var(--et-ink)', boxShadow: 'none', border: '1px solid var(--et-line-2)',
        }}>打开权限设置</button>
      </div>
      <button onClick={submit} disabled={saving} style={{
        ...primaryBtn,
        opacity: saving ? 0.65 : 1,
        cursor: saving ? 'wait' : 'pointer',
      }}>{saving ? '正在检查…' : '保存路径并重新检测'}</button>
    </>
  );
}

type WinNoDataMode = 'home' | 'scan' | 'manual';

function WinNoData({ diag, onSaved }: { diag: Diagnose; onSaved: () => void }) {
  const [mode, setMode] = useState<WinNoDataMode>('home');

  if (mode === 'scan') return <WinNoDataScan onSaved={onSaved} onBack={() => setMode('home')} onManual={() => setMode('manual')} />;
  if (mode === 'manual') return <WinNoDataManual diag={diag} onSaved={onSaved} onBack={() => setMode('home')} />;

  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        Murmur 已经扫了常见位置（盘根、Documents、OneDrive、注册表里 WeChat 设的路径），都没找到 <code>xwechat_files</code>。
        <br/>你大概率是：
      </div>
      <ul style={{ paddingLeft: 20, lineHeight: 1.8, fontSize: 13, color: 'var(--et-ink)', marginBottom: 18 }}>
        <li>把数据放在了非常规盘符 / 自定义文件夹里</li>
        <li>从来没在这台电脑登录过微信</li>
        <li>装的是企业微信（暂不支持）</li>
      </ul>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 18,
      }}>
        <button onClick={() => setMode('scan')} style={{
          all: 'unset', cursor: 'pointer', display: 'block', padding: '14px 16px',
          background: 'var(--et-orange-soft)', border: '1px solid var(--et-orange)',
          borderRadius: 'var(--et-r)', color: 'var(--et-orange-2)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>🔎 全盘扫描微信数据 <span style={{ fontWeight: 500, opacity: 0.75 }}>（推荐 · 通常 30 秒以内）</span></div>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            Murmur 用名字匹配的方式扫所有本地盘，跳过 Windows、Program Files、node_modules 等明显无关目录。**不读文件内容**，**不需要管理员权限**。
          </div>
        </button>
        <button onClick={() => setMode('manual')} style={{
          all: 'unset', cursor: 'pointer', display: 'block', padding: '14px 16px',
          background: 'var(--et-paper-2)', border: '1px solid var(--et-line-2)',
          borderRadius: 'var(--et-r)', color: 'var(--et-ink)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>✍ 我知道路径，手动输入</div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--et-ink-soft)' }}>
            从微信「设置 → 文件管理 → 打开文件夹」复制路径粘过来。
          </div>
        </button>
      </div>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--et-mute)' }}>看 Murmur 已经扫过哪些位置（点开展开）</summary>
        <CapabilityList diag={diag} />
      </details>
    </>
  );
}

function WinNoDataScan({ onSaved, onBack, onManual }: { onSaved: () => void; onBack: () => void; onManual: () => void }) {
  const [state, setState] = useState<ScanState | null>(null);
  const [stage, setStage] = useState<'starting' | 'scanning' | 'done' | 'error'>('starting');
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Bumped on user click to trigger a fresh scan via the useEffect below.
  const [scanEpoch, setScanEpoch] = useState(0);

  // Start a scan whenever scanEpoch changes (initial mount + 「重新扫描」 clicks),
  // poll until done or unmounted.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    setStage('starting');
    setState(null);
    setErrMsg(null);

    const poll = async () => {
      try {
        const s = await getDiskScanStatus();
        if (cancelled) return;
        setState(s);
        if (!s.running) {
          setStage(s.error ? 'error' : 'done');
          return;
        }
        timer = window.setTimeout(poll, 600);
      } catch (e: any) {
        if (cancelled) return;
        setErrMsg(e?.message || String(e));
        setStage('error');
      }
    };

    (async () => {
      try {
        const initial = await startDiskScan({});
        if (cancelled) return;
        setState(initial);
        setStage('scanning');
        timer = window.setTimeout(poll, 600);
      } catch (e: any) {
        if (cancelled) return;
        setErrMsg(e?.message || String(e));
        setStage('error');
      }
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [scanEpoch]);

  async function pickFound(found: ScanFound) {
    setSavingPath(found.path);
    setErrMsg(null);
    try {
      const r = await saveWeChatRoot(found.path);
      if (!r.ok) {
        setErrMsg(r.error || '保存失败');
        setSavingPath(null);
        return;
      }
      window.setTimeout(onSaved, 350);
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
      setSavingPath(null);
    }
  }

  async function handleCancel() {
    try { await cancelDiskScan(); } catch {}
    onBack();
  }

  const dirsScanned = state?.dirs_scanned ?? 0;
  const drivesDone = state?.drives_done ?? 0;
  const drivesTotal = state?.drives_total ?? 0;
  const found = state?.found ?? [];
  const elapsed = state?.started_at ? Math.max(0, ((state.finished_at ?? Math.floor(Date.now() / 1000)) - state.started_at)) : 0;

  return (
    <>
      <div style={{
        padding: '14px 16px', background: 'var(--et-paper-2)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 8,
        marginBottom: 14, fontSize: 13, color: 'var(--et-ink)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontWeight: 600 }}>
            {stage === 'starting' && '⏳ 正在启动扫描…'}
            {stage === 'scanning' && `🔎 扫描中 — ${drivesDone}/${drivesTotal} 个盘完成`}
            {stage === 'done' && `✓ 扫描完成 · 耗时 ${elapsed}s · 找到 ${found.length} 个候选`}
            {stage === 'error' && '✗ 扫描失败'}
          </div>
          <span className="et-meta" style={{ color: 'var(--et-mute)' }}>
            已查 {dirsScanned.toLocaleString()} 个目录
          </span>
        </div>
        {stage === 'scanning' && (
          <>
            <div className="et-meta" style={{ color: 'var(--et-mute)', fontSize: 11.5, marginBottom: 4 }}>
              ⏱ 还在扫，请等所有盘都标记完成再下结论 — 找到的候选会陆续出现在下面
            </div>
            {state?.current_path && (
              <div className="et-meta" style={{
                fontFamily: 'var(--et-mono)', fontSize: 11,
                color: 'var(--et-mute)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {state.current_path}
              </div>
            )}
          </>
        )}
      </div>

      {stage === 'error' && (
        <div style={{
          padding: '10px 14px', background: 'rgba(196,90,63,0.10)',
          border: '0.5px solid rgba(196,90,63,0.35)', borderRadius: 8,
          fontSize: 12, color: 'var(--et-rose)', marginBottom: 14, lineHeight: 1.6,
        }}>
          {state?.error || errMsg || '未知错误'}
        </div>
      )}

      {found.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-ink)', marginBottom: 8 }}>
            点候选项就用它（找到 {found.length} 个）：
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {found.map((f) => (
              <button key={f.path} onClick={() => pickFound(f)} disabled={savingPath === f.path} style={{
                all: 'unset', cursor: savingPath === f.path ? 'wait' : 'pointer',
                padding: '10px 12px', background: 'var(--et-paper-2)',
                border: '0.5px solid var(--et-line-2)', borderRadius: 6,
                fontSize: 11.5, fontFamily: 'var(--et-mono)', color: 'var(--et-ink)',
                opacity: savingPath && savingPath !== f.path ? 0.5 : 1,
                wordBreak: 'break-all', lineHeight: 1.5,
              }}>
                <span style={{ color: f.kind === 'wxid' ? 'var(--et-orange)' : 'var(--et-ink-soft)', fontWeight: 600, marginRight: 6 }}>
                  [{f.kind === 'wxid' ? '账号' : '数据根'}]
                </span>
                {maskText(f.path)}
              </button>
            ))}
          </div>
        </>
      )}

      {stage === 'done' && found.length === 0 && (
        <div style={{
          padding: '14px 16px', background: 'rgba(232,181,122,0.18)',
          border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
          fontSize: 13, color: '#8a5a1c', lineHeight: 1.7, marginBottom: 14,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>扫完了，0 个候选。</div>
          可能的原因：
          <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
            <li>这台电脑从来没登录过微信</li>
            <li>数据藏在 Murmur 默认跳过的目录里（<code>Windows\</code>、<code>Program Files\</code>、<code>node_modules\</code>、<code>$Recycle.Bin\</code> 等）</li>
            <li>装的是企业微信（暂不支持）</li>
          </ul>
          <strong>「手动输入路径」可以绕过所有跳过规则</strong> — 不管你的数据在哪个角落都能进。
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {stage === 'scanning' && (
          <button onClick={handleCancel} style={{
            ...primaryBtn, marginTop: 0, flex: 1, background: 'transparent',
            color: 'var(--et-ink)', boxShadow: 'none', border: '1px solid var(--et-line-2)',
          }}>取消</button>
        )}
        {(stage === 'done' || stage === 'error') && (
          <>
            <button onClick={onBack} style={{
              ...primaryBtn, marginTop: 0, flex: 1, background: 'transparent',
              color: 'var(--et-ink)', boxShadow: 'none', border: '1px solid var(--et-line-2)',
            }}>返回</button>
            <button onClick={() => setScanEpoch((n) => n + 1)} disabled={savingPath !== null} style={{
              ...primaryBtn, marginTop: 0, flex: 1, background: 'transparent',
              color: 'var(--et-ink)', boxShadow: 'none', border: '1px solid var(--et-line-2)',
              opacity: savingPath !== null ? 0.5 : 1,
            }}>重新扫描</button>
            {found.length === 0 && (
              <button onClick={onManual} style={{
                ...primaryBtn, marginTop: 0, flex: 2,
              }}>手动输入路径</button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function WinNoDataManual({ diag, onSaved, onBack }: { diag: Diagnose; onSaved: () => void; onBack: () => void }) {
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function submit() {
    const cleaned = path.trim();
    if (!cleaned) {
      setMsg('请先粘贴一个路径。');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const r = await saveWeChatRoot(cleaned);
      if (!r.ok) {
        setMsg(r.error || '这个路径里没有找到微信数据。');
        return;
      }
      setMsg(`✓ 已找到 ${r.profiles?.length || 1} 个微信账号，正在重新检测…`);
      window.setTimeout(onSaved, 450);
    } catch (e: any) {
      setMsg(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 12 }}>
        三步教你拿到正确路径：
      </div>
      <div style={{
        padding: '12px 14px', background: 'var(--et-paper-2)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 8,
        fontSize: 13, lineHeight: 1.85, color: 'var(--et-ink)', marginBottom: 12,
      }}>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>打开桌面版微信</li>
          <li>左下角 <strong>三横线菜单 → 设置 → 文件管理</strong></li>
          <li>点「<strong>打开文件夹</strong>」按钮 — Win 资源管理器会跳出来，地址栏显示的就是路径</li>
          <li>地址栏里点一下 → <kbd>Ctrl+C</kbd> 复制 → 回这里 <kbd>Ctrl+V</kbd> 粘到下面</li>
        </ol>
      </div>
      <div style={{
        padding: '10px 14px', background: 'rgba(72,167,107,0.10)',
        border: '0.5px solid rgba(72,167,107,0.30)', borderRadius: 8,
        fontSize: 12, color: '#3a7a4f', marginBottom: 12, lineHeight: 1.65,
      }}>
        💡 这些粘贴格式 Murmur 都认 — 多复制了或少复制了几层都会自动处理：
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontFamily: 'var(--et-mono)', fontSize: 11 }}>
          <li>D:\Tencent\Weixin\xwechat_files</li>
          <li>...\xwechat_files\wxid_xxx</li>
          <li>...\xwechat_files\wxid_xxx\db_storage  <span style={{ fontFamily: 'var(--et-sans)' }}>← 多了 db_storage 也行</span></li>
          <li>...\session\session.db  <span style={{ fontFamily: 'var(--et-sans)' }}>← 直接粘文件路径也行，会自动找 wxid_*</span></li>
        </ul>
      </div>
      <input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder={'粘到这里，不用清理多余的引号 / 反斜杠'}
        spellCheck={false}
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter' && !saving) submit(); }}
        style={{
          all: 'unset', width: '100%', boxSizing: 'border-box',
          padding: '10px 14px', borderRadius: 8,
          border: '1px solid var(--et-line-2)', background: 'var(--et-paper-2)',
          fontFamily: 'var(--et-mono)', fontSize: 12, color: 'var(--et-ink)',
          marginBottom: 10,
        }}
      />
      {msg && (
        <div className="et-meta" style={{
          color: msg.startsWith('✓') ? '#3a7a4f' : 'var(--et-rose)',
          marginBottom: 12, whiteSpace: 'pre-wrap',
        }}>{maskText(msg)}</div>
      )}
      <details style={{ marginBottom: 14 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--et-mute)' }}>看 Murmur 之前已经扫过哪些位置</summary>
        <CapabilityList diag={diag} />
      </details>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onBack} style={{
          ...primaryBtn, marginTop: 0, flex: 1, background: 'transparent',
          color: 'var(--et-ink)', boxShadow: 'none', border: '1px solid var(--et-line-2)',
        }}>返回</button>
        <button onClick={submit} disabled={saving} style={{
          ...primaryBtn, marginTop: 0, flex: 2,
          opacity: saving ? 0.65 : 1, cursor: saving ? 'wait' : 'pointer',
        }}>{saving ? '正在检查…' : '保存路径'}</button>
      </div>
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

function WinNeedKey({ diag, onStart, onRetry }: { diag: Diagnose; onStart: () => void; onRetry: () => void }) {
  const wechatRunning = diag.capabilities.weixin_running !== false;
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
      {!wechatRunning && (
        <div style={{
          padding: '10px 14px', background: 'rgba(196,90,63,0.10)',
          border: '0.5px solid rgba(196,90,63,0.35)', borderRadius: 8,
          fontSize: 12, color: 'var(--et-rose)', marginBottom: 14, lineHeight: 1.6,
        }}>
          现在没有检测到微信进程。请打开微信，让它停在登录页；Murmur 会每 2.5 秒自动重检，也可以点下面的「再次检测微信」立刻重试。
        </div>
      )}
      <CapabilityList diag={diag} />
      <button onClick={onStart} disabled={!wechatRunning} style={{
        ...primaryBtn,
        opacity: wechatRunning ? 1 : 0.45,
        cursor: wechatRunning ? 'pointer' : 'not-allowed',
      }}>开始抓密钥</button>
      {!wechatRunning && (
        <button onClick={onRetry} style={{
          ...primaryBtn, marginTop: 8, background: 'transparent',
          color: 'var(--et-ink)', boxShadow: 'none',
          border: '1px solid var(--et-line-2)',
        }}>再次检测微信</button>
      )}
    </>
  );
}

function Working({ text }: { text: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '32px 0' }}>
      <div style={{ display: 'inline-block', animation: 'spin 1.4s linear infinite', fontSize: 32 }}>⏳</div>
      <div className="et-h3" style={{ marginTop: 16 }}>{maskText(text)}</div>
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
  const isWinHookInstallFailure = diag?.platform === 'windows' &&
    /hook (setup|install) failed|wx_key\.dll|注入到微信进程/i.test(error);
  return (
    <>
      <div style={{
        padding: '12px 14px', background: 'rgba(196,90,63,0.12)',
        border: '0.5px solid rgba(196,90,63,0.4)',
        borderRadius: 8, marginBottom: 14,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-rose)', marginBottom: 6 }}>失败原因</div>
        <pre className="et-meta" style={{ fontSize: 11, color: 'var(--et-ink-soft)',
          whiteSpace: 'pre-wrap', margin: 0 }}>{maskText(error)}</pre>
      </div>
      {diag && (
        <details style={{ marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--et-mute)' }}>查看诊断信息（请提交 issue 时附上）</summary>
          <CapabilityList diag={diag} />
        </details>
      )}
      {isWinHookInstallFailure && (
        <div style={{
          padding: '10px 14px', background: 'rgba(232,181,122,0.18)',
          border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
          fontSize: 12, color: '#8a5a1c', lineHeight: 1.7, marginBottom: 14,
        }}>
          这是 Windows hook 安装失败：先把 Murmur 安装目录加入杀毒/Defender 白名单，确认 <code>wx_key.dll</code> 没被隔离；
          然后重启电脑，微信和 Murmur 都普通打开，不要一个管理员一个普通权限。
        </div>
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
