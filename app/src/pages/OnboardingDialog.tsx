import { useEffect, useState } from 'react';
import { extractKey, getDiagnose, refreshData, saveKey } from '../data/api';
import type { Diagnose } from '../data/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

type Phase = 'welcome' | 'diagnose' | 'mac-no-data' | 'mac-paste-key' | 'win-need-key' | 'win-decrypt' | 'extract-key' | 'done' | 'error';

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
      } else if (d.platform === 'macos' && hasWeChatData) {
        setPhase('mac-paste-key');  // Mac: needs manual key paste
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
    setProgress('准备重启微信…');
    try {
      const r = await extractKey({ autoRestart: true, timeout: 90 });
      if (!r.ok || !r.key) {
        setError(r.log?.split('\n').slice(-3).join('\n') || '没读到密钥');
        setPhase('error');
        return;
      }
      await saveKey(r.key);
      setProgress('密钥已就位，开始解密最新数据…');
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
  const rows = [
    ['平台', diag.platform === 'windows' ? 'Windows ✓' : diag.platform === 'macos' ? 'macOS' : diag.platform, true],
    ['微信安装', diag.capabilities.has_wechat_installed ? '已安装 ✓' : '未找到', diag.capabilities.has_wechat_installed],
    ['微信数据', diag.capabilities.has_wechat_data ? '已找到 ✓' : '没有 ❌', diag.capabilities.has_wechat_data],
    ['可解密数据库', diag.capabilities.can_decrypt_db ? '可以 ✓' : '不行 ⚠', diag.capabilities.can_decrypt_db],
    ['可抓取密钥', diag.capabilities.can_extract_key ? '可以 ✓' : '不行 ⚠', diag.capabilities.can_extract_key],
    ['本机 AI agents', `${diag.agents_found} 个 ✓`, true],
  ];
  return (
    <div style={{ background: 'var(--et-paper-2)', padding: '12px 16px', borderRadius: 10, fontSize: 12 }}>
      {rows.map(([k, v, ok]) => (
        <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
          <span style={{ color: 'var(--et-mute)' }}>{k}</span>
          <span style={{ color: ok ? 'var(--et-ink)' : 'var(--et-rose)', fontWeight: 500 }}>{v}</span>
        </div>
      ))}
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
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        Mac 上微信进程内存读取受 SIP 限制，没法自动抓密钥。但**解密本身能在 Mac 上跑**——你只需要把 64 位 SQLCipher 密钥粘进来。
      </div>
      <div style={{
        padding: '12px 16px', background: 'rgba(255,107,71,0.10)',
        border: '0.5px solid rgba(224,83,46,0.35)', borderRadius: 8,
        fontSize: 12.5, color: 'var(--et-ink-soft)', lineHeight: 1.6, marginBottom: 14,
      }}>
        <strong style={{ color: 'var(--et-orange-2)' }}>怎么获取密钥：</strong>
        <ul style={{ marginTop: 6, paddingLeft: 18, marginBottom: 0 }}>
          <li>有 Windows 电脑 → 在 Windows 上跑一次 Murmur，密钥会保存在 <code>~/.murmur/config.json</code>，把 <code>decrypt_key</code> 字段拷过来</li>
          <li>没 Windows → 用 lldb 附加到 Mac WeChat 进程扫内存（高级用法，文档稍后补）</li>
        </ul>
      </div>
      <input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="把 64 位 hex 密钥粘到这里"
        spellCheck={false}
        style={{
          all: 'unset', width: '100%', boxSizing: 'border-box',
          padding: '10px 14px', borderRadius: 8,
          border: `1px solid ${valid ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
          background: 'var(--et-paper-2)', fontFamily: 'var(--et-mono)',
          fontSize: 12, color: 'var(--et-ink)', marginBottom: 8,
        }}
      />
      <div style={{ fontSize: 11, color: 'var(--et-mute)', marginBottom: 14 }}>
        {key && (valid ? '✓ 格式正确' : `${cleaned.length}/64 位 hex`)}
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

function WinNeedKey({ diag, onStart }: { diag: Diagnose; onStart: () => void }) {
  return (
    <>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--et-ink-soft)', marginBottom: 14 }}>
        我会帮你做 3 件事：
      </div>
      <ol style={{ paddingLeft: 20, lineHeight: 1.9, fontSize: 13, color: 'var(--et-ink)', marginBottom: 14 }}>
        <li>关掉微信，立即帮你重新打开（你的所有窗口会消失几秒）</li>
        <li><strong>请在弹出的微信窗口里点一下「登录」按钮</strong> —— 这是整个过程里你唯一要做的</li>
        <li>读到密钥后，立即解密所有数据，进入 Murmur 主界面</li>
      </ol>
      <div style={{
        padding: '10px 14px', background: 'rgba(232,181,122,0.18)',
        border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
        fontSize: 12, color: '#8a5a1c', marginBottom: 14,
      }}>
        💡 准备好了再开始 —— 微信会立刻被关掉。如果你正在打字或传文件，先存一下。
      </div>
      <CapabilityList diag={diag} />
      <button onClick={onStart} style={primaryBtn}>开始（30 秒）</button>
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
