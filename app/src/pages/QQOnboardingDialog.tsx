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
import { useEffect, useRef, useState } from 'react';
import {
  cancelQQScan, decryptQQ, extractQQKey, getQQProfiles, getQQScanStatus,
  saveQQKey, saveQQRoot, setActiveProfile, startQQScan,
} from '../data/api';
import type { QQProfile, QQProfilesResponse, QQScanState } from '../data/api';

type QQPhase = 'detect' | 'pick-account' | 'extract-key' | 'decrypting' | 'done' | 'no-data' | 'error';

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
  const [searchRoots, setSearchRoots] = useState<string[]>([]);
  const [manualPath, setManualPath] = useState('');
  const [scanState, setScanState] = useState<QQScanState | null>(null);
  const scanPollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('detect'); setErrMsg(null); setActiveQQ(null);
    (async () => {
      try {
        const d = await getQQProfiles();
        setData(d);
        if (d.supported === false) {
          setErrMsg(d.error || 'QQ 导入目前只支持 Windows。Mac 版暂时可以继续使用微信数据，QQ for Mac 适配还在开发中。');
          setPhase('error');
          return;
        }
        const decrypted = d.profiles.find((p: QQProfile) => p.has_decrypted_data);
        if (decrypted) {
          setActiveQQ(decrypted.qq_number);
          setPhase('done');
          return;
        }
        if (d.profiles.length === 0) {
          setSearchRoots(d.search_roots || []);
          setPhase('no-data');
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

  // Stop polling on unmount or close
  useEffect(() => {
    if (!open && scanPollRef.current) {
      window.clearInterval(scanPollRef.current);
      scanPollRef.current = null;
    }
    return () => {
      if (scanPollRef.current) {
        window.clearInterval(scanPollRef.current);
        scanPollRef.current = null;
      }
    };
  }, [open]);

  if (!open) return null;

  async function refetchProfiles(savedRoot?: string) {
    try {
      const d = await getQQProfiles();
      setData(d);
      setSearchRoots(d.search_roots || []);
      if (d.profiles.length === 0) {
        setErrMsg(savedRoot
          ? `已保存「${savedRoot}」但里面没找到 <QQ号>/nt_qq/nt_db/nt_msg.db。请确认你粘的是 Tencent Files 文件夹（不是 nt_db）。`
          : '还是没找到 QQ 数据，再选个路径试试。');
        return;
      }
      if (d.profiles.length === 1) {
        setActiveQQ(d.profiles[0].qq_number);
        setPhase('extract-key');
      } else {
        setPhase('pick-account');
      }
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
    }
  }

  async function applyManualPath() {
    const path = manualPath.trim();
    if (!path) return;
    setErrMsg(null);
    try {
      const r = await saveQQRoot(path);
      if (!r.ok) {
        setErrMsg(r.error || '保存失败');
        if (r.search_roots) setSearchRoots(r.search_roots);
        return;
      }
      await refetchProfiles(r.saved);
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
    }
  }

  async function pickScanResult(rootPath: string) {
    setErrMsg(null);
    if (scanPollRef.current) {
      window.clearInterval(scanPollRef.current);
      scanPollRef.current = null;
    }
    try {
      await cancelQQScan().catch(() => {/* ignore */});
      const r = await saveQQRoot(rootPath);
      if (!r.ok) {
        setErrMsg(r.error || '保存失败');
        return;
      }
      await refetchProfiles(r.saved);
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
    }
  }

  async function beginScan() {
    setErrMsg(null);
    setScanState({
      running: true, started_at: null, finished_at: null,
      drives_total: 0, drives_done: 0, current_path: '',
      dirs_scanned: 0, found: [], error: null, cancelled: false,
    });
    try {
      await startQQScan({ max_depth: 8 });
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
      return;
    }
    scanPollRef.current = window.setInterval(async () => {
      try {
        const s = await getQQScanStatus();
        setScanState(s);
        if (!s.running) {
          if (scanPollRef.current) {
            window.clearInterval(scanPollRef.current);
            scanPollRef.current = null;
          }
        }
      } catch {/* ignore polling errors */}
    }, 800);
  }

  async function stopScan() {
    try { await cancelQQScan(); } catch {/* ignore */}
    if (scanPollRef.current) {
      window.clearInterval(scanPollRef.current);
      scanPollRef.current = null;
    }
  }

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
            {phase === 'no-data' && '没找到 QQ 数据'}
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

          {phase === 'no-data' && (
            <>
              <div className="et-serif" style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>
                Murmur 在以下位置没找到 <code>&lt;QQ号&gt;/nt_qq/nt_db/nt_msg.db</code>：
              </div>
              <div style={{
                padding: '10px 12px', background: 'var(--et-paper-2)',
                border: '0.5px solid var(--et-line-2)', borderRadius: 8,
                fontSize: 11, color: 'var(--et-mute)', maxHeight: 100, overflow: 'auto',
                fontFamily: 'monospace', marginBottom: 16, lineHeight: 1.5,
              }}>
                {searchRoots.length > 0
                  ? searchRoots.map((r, i) => <div key={i}>{r}</div>)
                  : '（未列出，可能未启用 Windows）'}
              </div>

              <div className="et-h3" style={{ marginBottom: 6, fontSize: 14 }}>方法 A：手动粘贴路径</div>
              <div className="et-meta" style={{ marginBottom: 8 }}>
                打开 QQ → 设置 → 通用 → 聊天记录 → 数据保存位置，把那个路径复制过来：
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <input
                  type="text"
                  value={manualPath}
                  onChange={e => setManualPath(e.target.value)}
                  placeholder='例：D:\Documents\Tencent Files'
                  style={{
                    flex: 1, padding: '10px 12px', fontSize: 13,
                    border: '0.5px solid var(--et-line-2)', borderRadius: 8,
                    background: 'var(--et-paper-2)', color: 'var(--et-ink)',
                    fontFamily: 'monospace',
                  }}
                />
                <button onClick={applyManualPath} disabled={!manualPath.trim()} style={{
                  ...primaryBtn, width: 'auto', padding: '0 18px', marginTop: 0,
                  opacity: manualPath.trim() ? 1 : 0.5,
                  cursor: manualPath.trim() ? 'pointer' : 'not-allowed',
                }}>
                  保存
                </button>
              </div>

              <div className="et-h3" style={{ marginBottom: 6, fontSize: 14 }}>方法 B：扫描所有硬盘</div>
              <div className="et-meta" style={{ marginBottom: 8 }}>
                自动遍历 C-Z 各盘找 Tencent Files 文件夹，约 10–60 秒。
              </div>

              {!scanState && (
                <button onClick={beginScan} style={{ ...primaryBtn, marginTop: 0 }}>
                  开始扫描
                </button>
              )}

              {scanState && scanState.running && (
                <div style={{
                  padding: '12px 14px', background: 'var(--et-paper-2)',
                  border: '0.5px solid var(--et-line-2)', borderRadius: 8, marginBottom: 12,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    扫描中… 盘符 {scanState.drives_done}/{scanState.drives_total}
                  </div>
                  <div className="et-meta" style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11, color: 'var(--et-mute)' }}>
                    {scanState.current_path || '准备中…'}（已扫 {scanState.dirs_scanned} 个目录）
                  </div>
                  <button onClick={stopScan} style={{
                    ...primaryBtn, marginTop: 10, padding: '8px 0', fontSize: 13,
                    background: 'var(--et-paper-2)', color: 'var(--et-ink)',
                    border: '0.5px solid var(--et-line-2)', boxShadow: 'none',
                  }}>
                    取消
                  </button>
                </div>
              )}

              {scanState && !scanState.running && scanState.found.length === 0 && (
                <div style={errBox}>
                  扫完了 —— 整台机器都没找到 Tencent Files 文件夹。可能你 QQ 还没在这台电脑上登录过，或者 nt_msg.db 没生成（先开一次 QQ 登录看看）。
                </div>
              )}

              {scanState && !scanState.running && scanState.found.length > 0 && (
                <>
                  <div className="et-meta" style={{ marginBottom: 8 }}>
                    找到 {scanState.found.length} 个候选 —— 点一个保存：
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {scanState.found.map((f, i) => (
                      <button key={i} onClick={() => pickScanResult(f.path)} style={accountBtn}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-ink)', fontFamily: 'monospace' }}>
                          {f.path}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--et-mute)', marginTop: 2 }}>
                          {f.qq_numbers.length} 个 QQ：{f.qq_numbers.slice(0, 3).join('、')}
                          {f.qq_numbers.length > 3 && ' …'}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {errMsg && (
                <div style={{ ...errBox, marginTop: 12, marginBottom: 0 }}>{errMsg}</div>
              )}
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
        padding: '10px 14px', background: 'rgba(196,90,63,0.10)',
        border: '0.5px solid rgba(196,90,63,0.35)', borderRadius: 8,
        fontSize: 12.5, color: 'var(--et-rose)', marginBottom: 12, lineHeight: 1.65,
      }}>
        ⚠️ <strong>开始前请先把电脑端 QQ 完全退出</strong>（手机上确认登出 → 电脑上点退出/关闭进程）。否则 Murmur 启动的带调试器 QQ.exe 会被你已登录的实例抢走，抓不到 key。
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
