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
 *
 * macOS adds a re-sign step and runs the lldb capture in the background
 * (the user logs in to QQ while it runs), shown as a 5-step stepper:
 *   数据目录 → 重签 QQ → 登录 QQ → 抓 key → 解密
 */
import { useEffect, useRef, useState } from 'react';
import {
  cancelQQMacExtract, cancelQQScan, decryptQQ, extractQQKey, getQQMacExtractStatus,
  getQQProfiles, getQQScanStatus, openFullDiskAccess, resignQQ, restoreQQSignature, saveQQKey,
  saveQQRoot, setActiveProfile, startQQMacExtract, startQQScan,
} from '../data/api';
import type { QQMacExtractState, QQProfile, QQProfilesResponse, QQScanState } from '../data/api';

type QQPhase = 'detect' | 'pick-account' | 'resign' | 'extract-key' | 'decrypting' | 'done' | 'no-data' | 'error';

const MAC_STEPS = ['数据目录', '重签 QQ', '登录 QQ', '抓 key', '解密'];

// lldb capture stages (MURMUR_STATUS lines) → what the user should see.
const MAC_STAGE_TEXT: Record<string, string> = {
  starting: '准备中…',
  quitting: '正在退出 QQ…',
  waiting: '等待 QQ 启动…',
  launched: 'QQ 正在启动…',
  attached: '调试器已附加，等 QQ 加载 wrapper.node…',
  module: '找到 wrapper.node，正在定位 nt_sqlite3_key_v2…',
  bp_addr: '正在下断点…',
  bp_set: '断点已就绪 —— 请在 QQ 窗口里登录',
  ready: '断点已就绪 —— 请在 QQ 窗口里登录',
  hit: 'QQ 正在打开数据库，收集候选 key…',
  key_seen: '抓到候选 key，再多收集几秒…',
  finishing: '收尾中，调试器正在从 QQ 分离…',
  cancelling: '正在取消，调试器正在从 QQ 分离…',
  done: '正在校验 key…',
};

/** Mac account ids are an opaque nt_qq_<hash> suffix; Windows ids are QQ numbers. */
function qqAccountLabel(id: string): string {
  return /^\d+$/.test(id) ? `QQ ${id}` : `QQ 账号 ${id.slice(0, 8)}${id.length > 8 ? '…' : ''}`;
}

function macStepIndex(phase: QQPhase, capture: QQMacExtractState | null, errStep: number): number {
  switch (phase) {
    case 'detect': case 'no-data': case 'pick-account': return 0;
    case 'resign': return 1;
    case 'extract-key': {
      const st = capture?.stage || '';
      return ['hit', 'key_seen', 'finishing', 'done'].includes(st) ? 3 : 2;
    }
    case 'decrypting': return 4;
    case 'done': return 5;
    default: return errStep;
  }
}

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
  // macOS-only state
  const [macCapture, setMacCapture] = useState<QQMacExtractState | null>(null);
  const [resignBusy, setResignBusy] = useState(false);
  const [resignLog, setResignLog] = useState<string[]>([]);
  const [errStep, setErrStep] = useState(0);
  const [macNotice, setMacNotice] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const capturePollRef = useRef<number | null>(null);
  // The backend hands the verified key out only once, so never let two
  // status polls overlap.
  const pollBusyRef = useRef(false);
  const isMac = data?.os === 'macos';

  // Next phase once an account is chosen: Mac needs QQ.app re-signed first.
  function phaseAfterPick(d: QQProfilesResponse | null): QQPhase {
    if (d?.os === 'macos' && d.mac?.debuggable !== true) return 'resign';
    return 'extract-key';
  }

  useEffect(() => {
    if (!open) return;
    setPhase('detect'); setErrMsg(null); setActiveQQ(null);
    setMacCapture(null); setResignLog([]); setMacNotice(null); setRestoreMsg(null);
    (async () => {
      try {
        const d = await getQQProfiles();
        setData(d);
        if (d.supported === false) {
          setErrMsg(d.error || 'QQ 导入目前只支持 Windows 和 macOS。');
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
          setPhase(phaseAfterPick(d));
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
    const stopAll = () => {
      if (scanPollRef.current) {
        window.clearInterval(scanPollRef.current);
        scanPollRef.current = null;
      }
      if (capturePollRef.current) {
        window.clearInterval(capturePollRef.current);
        capturePollRef.current = null;
      }
    };
    if (!open) stopAll();
    return stopAll;
  }, [open]);

  if (!open) return null;

  function fail(msg: string, step: number) {
    setErrMsg(msg);
    setErrStep(step);
    setPhase('error');
  }

  async function refetchProfiles(savedRoot?: string) {
    try {
      const d = await getQQProfiles();
      setData(d);
      setSearchRoots(d.search_roots || []);
      if (d.profiles.length === 0) {
        setErrMsg(savedRoot
          ? (d.os === 'macos'
            ? `已保存「${savedRoot}」但里面没找到 nt_qq_<编号>/nt_db/nt_msg.db。请确认你粘的是 QQ 数据目录（里面有 nt_qq_ 开头的文件夹）。`
            : `已保存「${savedRoot}」但里面没找到 <QQ号>/nt_qq/nt_db/nt_msg.db。请确认你粘的是 Tencent Files 文件夹（不是 nt_db）。`)
          : '还是没找到 QQ 数据，再选个路径试试。');
        return;
      }
      if (d.profiles.length === 1) {
        setActiveQQ(d.profiles[0].qq_number);
        setPhase(phaseAfterPick(d));
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
      const r = await extractQQKey(240, activeQQ);
      if (!r.ok || !r.key) {
        setErrMsg(r.error || '抓 key 失败 — 详细日志见 ~/Documents/Murmur/logs/');
        setPhase('error');
        return;
      }
      await saveAndDecrypt(activeQQ, r.key);
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
      setPhase('error');
    }
  }

  // Shared tail of both platforms: persist the HMAC-verified key, decrypt.
  async function saveAndDecrypt(qq: string, key: string) {
    setKeyHex(key);
    const saved = await saveQQKey(qq, key);
    if (!saved.ok) {
      fail(saved.error || 'key 校验失败，未保存', 3);
      return;
    }
    setPhase('decrypting');
    setProgress(`抓到 key (${key.slice(0, 4)}…)，正在解密 6 个数据库…`);
    const dec = await decryptQQ(qq, key);
    if (!dec.ok) {
      fail(dec.error || '解密失败', 4);
      return;
    }
    setPhase('done');
  }

  // ---- macOS ----

  async function doResign() {
    setResignBusy(true);
    setErrMsg(null);
    setRestoreMsg(null);
    setResignLog(['正在退出 QQ、备份原签名并重签名，稍后会弹出 macOS 授权窗口…']);
    try {
      const r = await resignQQ();
      setResignLog(r.log || []);
      if (r.backup_dir) {
        setData(d => (d && d.mac
          ? { ...d, mac: { ...d.mac, backup: { ...(d.mac.backup || {}), exists: true, dir: r.backup_dir } } }
          : d));
      }
      if (!r.ok) {
        if (r.rolled_back) {
          setData(d => (d && d.mac ? { ...d, mac: { ...d.mac, debuggable: false } } : d));
        }
        setErrMsg([r.error || '重签名失败', r.stderr].filter(Boolean).join('\n\n'));
        return;
      }
      setData(d => (d && d.mac ? { ...d, mac: { ...d.mac, debuggable: true } } : d));
      setProgress('');
      setPhase('extract-key');
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
    } finally {
      setResignBusy(false);
    }
  }

  async function doRestore() {
    setRestoreBusy(true);
    setRestoreMsg(null);
    try {
      const r = await restoreQQSignature();
      if (r.ok) {
        setRestoreMsg({ ok: true, text: r.message || '已恢复腾讯原签名，QQ 可以照常使用。' });
        setData(d => (d && d.mac ? { ...d, mac: { ...d.mac, debuggable: false } } : d));
        setMacCapture(null);
        setErrMsg(null);
        setPhase('resign');
      } else {
        setRestoreMsg({ ok: false, text: [r.error || '恢复失败', r.stderr].filter(Boolean).join('\n\n') });
      }
    } catch (e: any) {
      setRestoreMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setRestoreBusy(false);
    }
  }

  function stopCapturePoll() {
    if (capturePollRef.current) {
      window.clearInterval(capturePollRef.current);
      capturePollRef.current = null;
    }
  }

  async function startMacExtract() {
    if (!activeQQ) return;
    const qq = activeQQ;
    setErrMsg(null);
    setMacNotice(null);
    setRestoreMsg(null);
    setMacCapture({ running: true, stage: 'starting', hits: 0, started_at: null, finished_at: null, result: null });
    try {
      const r = await startQQMacExtract(qq, 240);
      if (!r.ok) {
        fail(r.error || '启动抓 key 失败', 2);
        return;
      }
    } catch (e: any) {
      fail(e?.message || String(e), 2);
      return;
    }
    stopCapturePoll();
    pollBusyRef.current = false;
    capturePollRef.current = window.setInterval(async () => {
      if (pollBusyRef.current) return;
      pollBusyRef.current = true;
      let s: QQMacExtractState;
      try {
        s = await getQQMacExtractStatus();
      } catch {
        pollBusyRef.current = false;
        return; // transient — keep polling
      }
      if (s.running || !s.result) {
        setMacCapture(s);
        pollBusyRef.current = false;
        return;
      }
      stopCapturePoll();
      pollBusyRef.current = false;
      const res = s.result;
      if (res.cancelled) {
        setMacCapture(null);
        setMacNotice('已取消。调试器已经从 QQ 分离，可以随时重新开始抓 key。');
        return;
      }
      setMacCapture(s);
      if (!res.ok || !res.key) {
        fail(res.error || '抓 key 失败', 3);
        return;
      }
      try {
        await saveAndDecrypt(qq, res.key);
      } catch (e: any) {
        fail(e?.message || String(e), 4);
      }
    }, 1000);
  }

  async function cancelMacExtract() {
    setMacCapture(c => (c ? { ...c, stage: 'cancelling' } : c));
    try { await cancelQQMacExtract(); } catch {/* ignore — poll picks up the final state */}
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
            {phase === 'resign' && '重签 QQ，允许调试器附加'}
            {phase === 'extract-key' && (isMac ? '登录 QQ 并抓数据库密钥' : '抓 QQ 数据库密钥')}
            {phase === 'decrypting' && '正在解密…'}
            {phase === 'done' && '✓ QQ 数据已就绪'}
            {phase === 'no-data' && '没找到 QQ 数据'}
            {phase === 'error' && '出了点问题'}
          </div>
          {isMac && <MacStepper active={macStepIndex(phase, macCapture, errStep)} failed={phase === 'error'} />}
        </div>
        <div style={{ padding: '14px 32px 28px', maxHeight: '70vh', overflow: 'auto' }}>
          {phase === 'detect' && <Spinner text="读取 QQ 数据目录…" />}

          {phase === 'pick-account' && data && (
            <>
              <div className="et-serif" style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 14 }}>
                这台电脑有 <strong>{data.profiles.length}</strong> 个 QQ 账号。先选一个开始：
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.profiles.map(p => (
                  <button key={p.qq_number}
                    onClick={() => { setActiveQQ(p.qq_number); setPhase(phaseAfterPick(data)); }}
                    style={accountBtn}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--et-ink)' }}>
                      🐧 {qqAccountLabel(p.qq_number)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--et-mute)', marginTop: 2 }}>
                      {p.has_decrypted_data ? '已解密' : '未解密'}
                      {p.has_saved_key && ' · 已保存 key'}
                    </div>
                    {isMac && (
                      <div style={{ fontSize: 10.5, color: 'var(--et-faint)', marginTop: 2, fontFamily: 'var(--et-mono)', wordBreak: 'break-all' }}>
                        {p.encrypted_root}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {phase === 'no-data' && (
            <>
              {isMac && data?.tcc_blocked && (
                <div style={riskBox}>
                  <strong>macOS 拦住了 QQ 的数据目录。</strong>QQ 的数据在
                  <code> ~/Library/Containers/com.tencent.qq</code> 里，读它需要权限：在「系统设置 → 隐私与安全性 → 完全磁盘访问」给 Murmur 打勾，然后<strong>完全退出 Murmur 再打开</strong>。
                  <button onClick={() => { openFullDiskAccess().catch(() => {/* ignore */}); }} style={{ ...secondaryBtn, marginTop: 10 }}>
                    打开系统设置 → 完全磁盘访问
                  </button>
                </div>
              )}
              <div className="et-serif" style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>
                {isMac
                  ? <>Murmur 在以下位置没找到 <code>nt_qq_&lt;编号&gt;/nt_db/nt_msg.db</code>：</>
                  : <>Murmur 在以下位置没找到 <code>&lt;QQ号&gt;/nt_qq/nt_db/nt_msg.db</code>：</>}
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
                {isMac
                  ? '在 Finder 里按 ⌘⇧G 打开 QQ 的数据目录（里面有 nt_qq_ 开头的文件夹），把路径复制过来；粘 nt_qq_xxx 或 nt_db 也行：'
                  : '打开 QQ → 设置 → 通用 → 聊天记录 → 数据保存位置，把那个路径复制过来：'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <input
                  type="text"
                  value={manualPath}
                  onChange={e => setManualPath(e.target.value)}
                  placeholder={isMac
                    ? '例：~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ'
                    : '例：D:\\Documents\\Tencent Files'}
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

              {/* Whole-disk scan walks drive letters — Windows only. */}
              {!isMac && (<>
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
              </>)}

              {errMsg && (
                <div style={{ ...errBox, marginTop: 12, marginBottom: 0 }}>{errMsg}</div>
              )}
            </>
          )}

          {phase === 'resign' && activeQQ && (
            <QQMacResignStep data={data} busy={resignBusy} log={resignLog} errMsg={errMsg}
              onResign={doResign}
              onSkip={() => { setErrMsg(null); setPhase('extract-key'); }}
              restore={<RestoreSignature data={data} busy={restoreBusy || resignBusy}
                msg={restoreMsg} onRestore={doRestore} />} />
          )}

          {phase === 'extract-key' && activeQQ && isMac && (
            <QQMacExtractStep qq={activeQQ} data={data} capture={macCapture} notice={macNotice}
              onStart={startMacExtract} onCancel={cancelMacExtract}
              onResign={() => { setErrMsg(null); setMacNotice(null); setPhase('resign'); }}
              restore={<RestoreSignature data={data} busy={restoreBusy}
                msg={restoreMsg} onRestore={doRestore} />} />
          )}

          {phase === 'extract-key' && activeQQ && !isMac && (
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
              <button onClick={() => {
                setErrMsg(null);
                setMacCapture(null);
                setProgress('');
                setPhase(activeQQ ? 'extract-key' : 'detect');
              }} style={primaryBtn}>
                再试一次
              </button>
              {isMac && activeQQ && (
                <button onClick={() => { setErrMsg(null); setMacCapture(null); setPhase('resign'); }}
                  style={{ ...secondaryBtn, marginTop: 8 }}>
                  回到「重签 QQ」（QQ 更新后需要重签）
                </button>
              )}
              {isMac && (
                <RestoreSignature data={data} busy={restoreBusy} msg={restoreMsg} onRestore={doRestore} />
              )}
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

// ---- macOS steps ----

function MacStepper({ active, failed }: { active: number; failed: boolean }) {
  return (
    <ol aria-label="QQ 导入步骤" style={{
      listStyle: 'none', margin: '16px 0 0', padding: 0,
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    }}>
      {MAC_STEPS.map((label, i) => {
        const done = i < active;
        const current = i === active;
        const color = current && failed ? 'var(--et-rose)'
          : current ? 'var(--et-orange)'
          : done ? 'var(--et-sage)' : 'var(--et-faint)';
        return (
          <li key={label} aria-current={current ? 'step' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 20, height: 20, borderRadius: 10, flex: '0 0 auto',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
              color: done || current ? 'var(--et-paper)' : 'var(--et-mute)',
              background: done || current ? color : 'transparent',
              border: `1px solid ${done || current ? color : 'var(--et-line-2)'}`,
            }}>
              {done ? '✓' : i + 1}
            </span>
            <span style={{
              fontSize: 12, fontWeight: current ? 600 : 400,
              color: current ? 'var(--et-ink)' : 'var(--et-mute)',
            }}>
              {label}
            </span>
            {i < MAC_STEPS.length - 1 && (
              <span aria-hidden style={{ width: 14, height: 1, background: 'var(--et-line-2)', margin: '0 2px' }} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function MacRiskNotice() {
  return (
    <div style={riskBox}>
      ⚠️ <strong>先了解风险再继续：</strong>Murmur 会给 <code>QQ.app</code> 重新做一个本机签名（去掉 hardened runtime、加上允许调试的 <code>get-task-allow</code>），
      再用系统自带的 lldb 调试器在 QQ 打开数据库的一瞬间读出密钥。改签名和调试 QQ 进程<strong>有被腾讯安全机制检测到的可能</strong>（理论上存在账号风控风险），
      QQ 也可能提示「已被修改」。<strong>只用来处理这台 Mac 上、你本人的 QQ 数据。</strong>
      <br />
      改之前 Murmur 会把腾讯原签名备份到 <code>~/.murmur/qq-backup/</code>，之后随时可以点「恢复原签名」还原；
      重签后会先试启动一次 QQ，起不来就自动还原。
    </div>
  );
}

/** "恢复原签名" — only shown once a backup of the Tencent signature exists. */
function RestoreSignature({ data, busy, msg, onRestore }: {
  data: QQProfilesResponse | null; busy: boolean;
  msg: { ok: boolean; text: string } | null; onRestore: () => void;
}) {
  const backup = data?.mac?.backup;
  if (!backup?.exists && !msg) return null;
  return (
    <div style={{ marginTop: 8 }}>
      {msg && (
        <div role="status" style={msg.ok ? { ...okBox } : { ...errBox, marginBottom: 8 }}>{msg.text}</div>
      )}
      {backup?.exists && (
        <button onClick={onRestore} disabled={busy} style={{
          ...secondaryBtn, opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer',
        }} title={backup.dir ? `备份位置：${backup.dir}` : undefined}>
          {busy ? '正在恢复，请留意系统授权窗口…' : '恢复 QQ 原签名（需要开机密码）'}
        </button>
      )}
    </div>
  );
}

function QQMacResignStep({ data, busy, log, errMsg, onResign, onSkip, restore }: {
  data: QQProfilesResponse | null; busy: boolean; log: string[]; errMsg: string | null;
  onResign: () => void; onSkip: () => void; restore: React.ReactNode;
}) {
  const mac = data?.mac;
  const noApp = !mac?.qq_app;
  return (
    <>
      <MacRiskNotice />
      <div style={stepBox}>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>Murmur <strong>先退出 QQ</strong>（正在聊天的话先收个尾）</li>
          <li>把 QQ 主程序和原签名<strong>备份</strong>到 <code>~/.murmur/qq-backup/&lt;QQ 版本&gt;/</code></li>
          <li>只重签 QQ 的主程序 <code>QQ.app/Contents/MacOS/QQ</code>，不需要关闭 SIP</li>
          <li>macOS 会弹出授权窗口，输入<strong>这台 Mac 的开机密码</strong>（不是 Apple ID）</li>
          <li>在后台<strong>试启动一次 QQ</strong>再退出；起不来就自动恢复原签名（会再弹一次授权窗口）</li>
          <li>QQ 更新后签名会被覆盖，到时候回来再点一次就行</li>
        </ol>
      </div>
      {noApp && (
        <div style={errBox}>没找到 QQ.app。请先从 QQ 官网安装 macOS 版 QQ（装在「应用程序」里），然后关掉这个窗口重新打开。</div>
      )}
      {mac?.lldb_error && (
        <div style={hintBox}>💡 {mac.lldb_error}（重签名可以先做，抓 key 时需要它。）</div>
      )}
      {log.length > 0 && (
        <div style={logBox}>{log.map((l, i) => <div key={i}>{l}</div>)}</div>
      )}
      {errMsg && <div style={errBox}>{errMsg}</div>}
      <button onClick={onResign} disabled={busy || noApp} style={{
        ...primaryBtn, opacity: busy || noApp ? 0.6 : 1, cursor: busy ? 'wait' : noApp ? 'not-allowed' : 'pointer',
      }}>
        {busy ? '正在重签名，请留意系统授权窗口…' : '我了解风险，退出 QQ 并重签（需要开机密码）'}
      </button>
      {mac?.debuggable == null && !noApp && (
        <button onClick={onSkip} disabled={busy} style={{ ...secondaryBtn, marginTop: 8 }}>
          我已经重签过了，直接去抓 key
        </button>
      )}
      {restore}
    </>
  );
}

function QQMacExtractStep({ qq, data, capture, notice, onStart, onCancel, onResign, restore }: {
  qq: string; data: QQProfilesResponse | null; capture: QQMacExtractState | null;
  notice: string | null; onStart: () => void; onCancel: () => void; onResign: () => void;
  restore: React.ReactNode;
}) {
  const running = !!capture?.running;
  const stage = capture?.stage || '';
  const waitingLogin = stage === 'bp_set' || stage === 'ready';
  const cancelling = stage === 'cancelling';
  const lldbErr = data?.mac?.lldb_error;
  return (
    <>
      <div className="et-serif" style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>
        {qqAccountLabel(qq)}。点下面按钮后：
      </div>
      <div style={stepBox}>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>Murmur 退出 QQ，再用 lldb 调试器重新打开它（可能会弹「开发者工具」授权窗口，输入开机密码）</li>
          <li>QQ 窗口出来后<strong>正常登录你要导入的这个账号</strong>；自动登录的话什么都不用做</li>
          <li>QQ 打开数据库的瞬间 Murmur 记下候选 key，并用 nt_msg.db 校验，只保留对的那个</li>
          <li>调试器自动从 QQ 分离，QQ 继续正常运行，然后解密 6 个数据库</li>
        </ol>
      </div>
      <div style={hintBox}>
        💡 如果 QQ 自动登录了却一直没抓到：在 QQ 里点头像 →「退出账号」再重新登录。不要用菜单栏的「切换账号」，它会重启 QQ 进程。
      </div>
      {lldbErr && <div style={errBox}>{lldbErr}</div>}
      {notice && !running && <div role="status" style={okBox}>{notice}</div>}
      {running ? (
        <div style={{ ...stepBox, borderColor: waitingLogin ? 'var(--et-orange)' : 'var(--et-line-2)' }} role="status">
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--et-ink)' }}>
            {MAC_STAGE_TEXT[stage] || '正在抓 key…'}
          </div>
          <div className="et-meta" style={{ marginTop: 4, color: 'var(--et-mute)' }}>
            断点命中 {capture?.hits ?? 0} 次 · 最长等 4 分钟
          </div>
          <button onClick={onCancel} disabled={cancelling} style={{
            ...secondaryBtn, marginTop: 10, opacity: cancelling ? 0.6 : 1, cursor: cancelling ? 'wait' : 'pointer',
          }}>
            {cancelling ? '正在取消…' : '取消'}
          </button>
        </div>
      ) : (
        <>
          <button onClick={onStart} disabled={!!lldbErr} style={{
            ...primaryBtn, opacity: lldbErr ? 0.6 : 1, cursor: lldbErr ? 'not-allowed' : 'pointer',
          }}>
            开始抓 QQ key
          </button>
          <button onClick={onResign} style={{ ...secondaryBtn, marginTop: 8 }}>
            回到「重签 QQ」
          </button>
          {restore}
        </>
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
  // Tall Mac steps (risk notice + log + restore button) must stay reachable.
  maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
};
const accentBar: React.CSSProperties = {
  position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, background: 'var(--et-orange)',
};
const closeBtn: React.CSSProperties = {
  // `all: 'unset'` first, or it resets `position` and the × lands top-left.
  all: 'unset', position: 'absolute', top: 14, right: 14, cursor: 'pointer',
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
const okBox: React.CSSProperties = {
  padding: '10px 14px', marginBottom: 12, fontSize: 12.5, lineHeight: 1.6,
  background: 'color-mix(in srgb, var(--et-sage) 14%, transparent)',
  border: '0.5px solid color-mix(in srgb, var(--et-sage) 45%, transparent)',
  borderRadius: 8, color: 'var(--et-ink)', whiteSpace: 'pre-wrap',
};
const riskBox: React.CSSProperties = {
  padding: '10px 14px', marginBottom: 12, lineHeight: 1.65, fontSize: 12.5,
  background: 'color-mix(in srgb, var(--et-rose) 10%, transparent)',
  border: '0.5px solid color-mix(in srgb, var(--et-rose) 40%, transparent)',
  borderRadius: 8, color: 'var(--et-ink)',
};
const stepBox: React.CSSProperties = {
  padding: '12px 14px', background: 'var(--et-paper-2)',
  border: '0.5px solid var(--et-line-2)', borderRadius: 8,
  fontSize: 13, lineHeight: 1.85, color: 'var(--et-ink)', marginBottom: 12,
};
const logBox: React.CSSProperties = {
  padding: '8px 12px', background: 'var(--et-paper-2)',
  border: '0.5px solid var(--et-line-2)', borderRadius: 8, marginBottom: 12,
  fontFamily: 'var(--et-mono)', fontSize: 11, lineHeight: 1.6, color: 'var(--et-mute)',
  whiteSpace: 'pre-wrap',
};
const secondaryBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', display: 'block', width: '100%', boxSizing: 'border-box',
  textAlign: 'center', padding: '9px 0', fontSize: 13,
  background: 'var(--et-paper-2)', color: 'var(--et-ink)',
  border: '0.5px solid var(--et-line-2)', borderRadius: 'var(--et-r)',
};
const hintBox: React.CSSProperties = {
  padding: '10px 14px',
  background: 'color-mix(in srgb, var(--et-amber) 18%, transparent)',
  border: '0.5px solid color-mix(in srgb, var(--et-amber) 45%, transparent)', borderRadius: 8,
  fontSize: 11.5, color: 'var(--et-ink-soft)', lineHeight: 1.6, marginBottom: 14,
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
