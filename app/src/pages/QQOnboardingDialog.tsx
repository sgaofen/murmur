/* QQOnboardingDialog — modal-only flow for adding a QQ account.
 *
 * After v0.3.0 the rest of QQ surfaces (home / friend / graph / etc.) are
 * the SAME pages as WeChat — backend swaps `_MurmurAPIHandler.store` to a
 * QQStore via /api/active-profile and every analysis function reads QQ
 * data through the EchoStore-shape interface.
 *
 * Flow: detect → pick-account → extract-key → decrypting → done
 *   → setActiveProfile(qq, qq_number) → reload → user lands on Home with
 *     the QQ data behind every page.
 */
import { useEffect, useState } from 'react';
import {
  decryptQQ, extractQQKey, getQQProfiles, saveQQKey, setActiveProfile,
} from '../data/api';
import type { QQProfile, QQProfilesResponse } from '../data/api';

type QQPhase = 'detect' | 'pick-account' | 'extract-key' | 'decrypting' | 'done' | 'error';

interface Props {
  open: boolean;
  onClose: () => void;
  onDone: (qq: string) => void;
}

export function QQOnboardingDialog({ open, onClose, onDone }: Props) {
  const [phase, setPhase] = useState<QQPhase>('detect');
  const [data, setData] = useState<QQProfilesResponse | null>(null);
  const [activeQQ, setActiveQQ] = useState<string | null>(null);
  const [, setKeyHex] = useState<string | null>(null);
  const [progress, setProgress] = useState('');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('detect'); setErrMsg(null); setActiveQQ(null);
    (async () => {
      try {
        const d = await getQQProfiles();
        setData(d);
        const decrypted = d.profiles.find((p: QQProfile) => p.has_decrypted_data);
        if (decrypted) {
          setActiveQQ(decrypted.qq_number);
          setPhase('done');
          return;
        }
        if (d.profiles.length === 0) {
          setErrMsg('没找到 QQNT 数据。请先在这台电脑上登录过 QQ（默认在 D:\\Documents\\Tencent Files 之类）。');
          setPhase('error');
          return;
        }
        if (d.profiles.length === 1) {
          setActiveQQ(d.profiles[0].qq_number);
          setPhase('extract-key');
        } else {
          setPhase('pick-account');
        }
      } catch (e: any) {
        setErrMsg(e?.message || String(e)); setPhase('error');
      }
    })();
  }, [open]);

  if (!open) return null;

  async function startExtract() {
    if (!activeQQ) return;
    setPhase('extract-key');
    setProgress('正在启动 QQ + 装调试器，请在 QQ 弹出窗口里扫码登录…');
    setErrMsg(null);
    try {
      const r = await extractQQKey(240);
      if (!r.ok || !r.key) {
        setErrMsg(r.error || '抓 key 失败 — 详细日志见 ~/Documents/Murmur/logs/');
        setPhase('error');
        return;
      }
      setKeyHex(r.key);
      await saveQQKey(activeQQ, r.key);
      setPhase('decrypting');
      setProgress(`抓到 key (${r.key.slice(0, 4)}…)，正在解密 6 个数据库…`);
      const dec = await decryptQQ(activeQQ, r.key);
      if (!dec.ok) {
        setErrMsg(dec.error || '解密失败');
        setPhase('error');
        return;
      }
      setPhase('done');
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
      setPhase('error');
    }
  }

  async function finish() {
    if (!activeQQ) {
      onClose();
      return;
    }
    try {
      await setActiveProfile('qq', activeQQ);
      localStorage.setItem('murmur.activeProfile',
        JSON.stringify({ platform: 'qq', id: activeQQ }));
    } catch {/* ignore — reload will resync */}
    onClose();
    onDone(activeQQ);
    setTimeout(() => window.location.reload(), 50);
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={accentBar} />
        <button onClick={onClose} title="关闭" style={closeBtn}>×</button>
        <div style={{ padding: '28px 32px 0' }}>
          <div className="et-eyebrow" style={{ color: 'var(--et-orange)' }}>导入 QQ 聊天</div>
          <div className="et-h1" style={{ color: 'var(--et-ink)', marginTop: 8, fontSize: 30 }}>
            {phase === 'detect' && '正在检测 QQ…'}
            {phase === 'pick-account' && '选择要导入的 QQ 账号'}
            {phase === 'extract-key' && '抓 QQ 数据库密钥'}
            {phase === 'decrypting' && '正在解密…'}
            {phase === 'done' && '✓ QQ 数据已就绪'}
            {phase === 'error' && '出了点问题'}
          </div>
        </div>
        <div style={{ padding: '14px 32px 28px' }}>
          {phase === 'detect' && <Spinner text="读取 Tencent Files 目录…" />}

          {phase === 'pick-account' && data && (
            <>
              <div className="et-serif" style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 14 }}>
                这台电脑有 <strong>{data.profiles.length}</strong> 个 QQ 账号。先选一个开始：
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.profiles.map(p => (
                  <button key={p.qq_number}
                    onClick={() => { setActiveQQ(p.qq_number); setPhase('extract-key'); }}
                    style={accountBtn}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--et-ink)' }}>
                      🐧 QQ {p.qq_number}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--et-mute)', marginTop: 2 }}>
                      {p.has_decrypted_data ? '已解密' : '未解密'}
                      {p.has_saved_key && ' · 已保存 key'}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {phase === 'extract-key' && activeQQ && (
            <QQExtractStep qq={activeQQ} progress={progress} onStart={startExtract}
              kicked={progress !== ''} />
          )}

          {phase === 'decrypting' && <Spinner text={progress || '正在解密…'} />}

          {phase === 'done' && (
            <>
              <div style={successBox}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#3a7a4f' }}>
                  ✓ QQ 数据已解密 — 即将切换到 QQ 视角
                </div>
                <div className="et-meta" style={{ marginTop: 6 }}>
                  Key 保存在 <code>~/.murmur/qq_keys.json</code>，下次启动直接读，不用重抓。Murmur 现有的所有页面（首页 / 朋友 / 关系网 / 报告）会用 QQ 数据重新加载。
                </div>
              </div>
              <button onClick={finish} style={primaryBtn}>
                进入 QQ 视角
              </button>
            </>
          )}

          {phase === 'error' && (
            <>
              <div style={errBox}>{errMsg || '未知错误'}</div>
              <button onClick={() => setPhase(activeQQ ? 'extract-key' : 'detect')} style={primaryBtn}>
                再试一次
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function QQExtractStep({ qq, progress, onStart, kicked }:
  { qq: string; progress: string; onStart: () => void; kicked: boolean }) {
  return (
    <>
      <div className="et-serif" style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>
        QQ 账号 <strong>{qq}</strong>。点下面按钮后：
      </div>
      <div style={{
        padding: '12px 14px', background: 'var(--et-paper-2)',
        border: '0.5px solid var(--et-line-2)', borderRadius: 8,
        fontSize: 13, lineHeight: 1.85, color: 'var(--et-ink)', marginBottom: 12,
      }}>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>Murmur 启动一个<strong>带调试器</strong>的 QQ.exe</li>
          <li>QQ 窗口出来后请<strong>正常扫码登录</strong></li>
          <li>登录瞬间 Murmur 抓住数据库密钥（16 字符），断点后台触发，你看不到</li>
          <li>抓完 QQ 自动关掉，立即解密 6 个数据库（约 5–15 秒）</li>
        </ol>
      </div>
      <div style={hintBox}>
        💡 全程<strong>不需要管理员权限</strong>。如果 QQ 窗口几秒后又被自启动 helper 拉起，可忽略 — 抓到 key 后那个无所谓。
      </div>
      <button onClick={onStart} disabled={kicked} style={{
        ...primaryBtn, opacity: kicked ? 0.6 : 1, cursor: kicked ? 'wait' : 'pointer',
      }}>
        {kicked ? '正在抓 key…' : '开始抓 QQ key'}
      </button>
      {kicked && progress && (
        <div className="et-meta" style={{ marginTop: 12, color: 'var(--et-mute)', textAlign: 'center' }}>
          {progress}
        </div>
      )}
    </>
  );
}

// ---- styles ----

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 200,
  background: 'rgba(20,24,42,0.62)', backdropFilter: 'blur(10px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
};
const modal: React.CSSProperties = {
  width: 640, maxWidth: '94%', background: 'var(--et-paper)',
  borderRadius: 'var(--et-r-lg)', boxShadow: 'var(--et-shadow-3)',
  border: '0.5px solid var(--et-line-2)', overflow: 'hidden', position: 'relative',
};
const accentBar: React.CSSProperties = {
  position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, background: 'var(--et-orange)',
};
const closeBtn: React.CSSProperties = {
  position: 'absolute', top: 14, right: 14, all: 'unset', cursor: 'pointer',
  width: 28, height: 28, borderRadius: 8, color: 'var(--et-mute)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
};
const accountBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', display: 'block',
  padding: '12px 14px', background: 'var(--et-paper-2)',
  border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
  textAlign: 'left',
};
const primaryBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
  textAlign: 'center', padding: '14px 0', marginTop: 8,
  background: 'var(--et-orange)', color: '#fff',
  borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
  boxShadow: '0 6px 16px rgba(255,107,71,0.32)',
};
const successBox: React.CSSProperties = {
  padding: '16px 18px', background: 'rgba(72,167,107,0.15)',
  border: '0.5px dashed rgba(72,167,107,0.5)', borderRadius: 10, marginBottom: 16,
};
const errBox: React.CSSProperties = {
  padding: '12px 14px', background: 'rgba(196,90,63,0.10)',
  border: '0.5px solid rgba(196,90,63,0.35)', borderRadius: 8,
  fontSize: 12.5, color: 'var(--et-rose)', marginBottom: 14,
  whiteSpace: 'pre-wrap',
};
const hintBox: React.CSSProperties = {
  padding: '10px 14px', background: 'rgba(232,181,122,0.18)',
  border: '0.5px solid rgba(138,90,28,0.3)', borderRadius: 8,
  fontSize: 11.5, color: '#8a5a1c', lineHeight: 1.6, marginBottom: 14,
};

function Spinner({ text }: { text: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '32px 0' }}>
      <div style={{ display: 'inline-block', animation: 'spin 1.4s linear infinite', fontSize: 32 }}>⏳</div>
      <div className="et-h3" style={{ marginTop: 16 }}>{text}</div>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
