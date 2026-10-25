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
 * Look: the same instrument parts as the WeChat onboarding (ui/Dialog +
 * Stepper, onboarding/parts, onboarding.css) — no inline colours.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Stepper } from '../ui';
import type { StepItem } from '../ui';
import { IconRefresh } from '../ui/icons';
import { Lead, March, Note, Ops, PathText, Sec, Working } from '../onboarding/parts';
import {
  cancelQQScan, decryptQQ, extractQQKey, getQQProfiles, getQQScanStatus,
  saveQQKey, saveQQRoot, setActiveProfile, startQQScan,
} from '../data/api';
import type { QQProfile, QQProfilesResponse, QQScanState } from '../data/api';

type QQPhase = 'detect' | 'pick-account' | 'extract-key' | 'decrypting' | 'done' | 'no-data' | 'error';

const QQ_STEPS: StepItem[] = [
  { key: 'detect', label: '检测' },
  { key: 'pick', label: '选账号' },
  { key: 'key', label: '抓密钥' },
  { key: 'decrypt', label: '解密' },
  { key: 'done', label: '完成' },
];

const QQ_TITLE: Record<QQPhase, string> = {
  'detect': '正在检测 QQ…',
  'pick-account': '选择要导入的 QQ 账号',
  'extract-key': '抓 QQ 数据库密钥',
  'decrypting': '正在解密…',
  'done': 'QQ 数据已就绪',
  'no-data': '没找到 QQ 数据',
  'error': '出了点问题',
};

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
      const r = await extractQQKey(240, activeQQ);
      if (!r.ok || !r.key) {
        setErrMsg(r.error || '抓 key 失败 — 详细日志见 ~/Documents/Murmur/logs/');
        setPhase('error');
        return;
      }
      setKeyHex(r.key);
      const saved = await saveQQKey(activeQQ, r.key);
      if (!saved.ok) {
        setErrMsg(saved.error || 'key 校验失败，未保存');
        setPhase('error');
        return;
      }
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

  // Display only: which cell of the step bar is lit.
  const stepKey = phase === 'detect' || phase === 'no-data' ? 'detect'
    : phase === 'pick-account' ? 'pick'
      : phase === 'decrypting' ? 'decrypt'
        : phase === 'done' ? 'done'
          : phase === 'error' && !activeQQ ? 'detect' : 'key';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      accent
      closeOnScrim={false}
      className="ob-dialog ob-dialog--qq"
      eyebrow="导入 QQ 聊天"
      title={QQ_TITLE[phase]}
    >
      <Stepper className="ob-key-stepper" steps={QQ_STEPS} current={stepKey}
        error={phase === 'error' || phase === 'no-data'} />
      <div className="ob-dialog-main" key={phase}>
        {phase === 'detect' && (
          <div className="ob-probe" role="status"><i className="ui-led is-pulse" />读取 Tencent Files 目录…</div>
        )}

        {phase === 'pick-account' && data && (
          <>
            <Lead>这台电脑有 <strong>{data.profiles.length}</strong> 个 QQ 账号。先选一个开始：</Lead>
            <ul className="ob-accts">
              {data.profiles.map((p, i) => (
                <li key={p.qq_number}>
                  <button type="button" className="ob-acct"
                    onClick={() => { setActiveQQ(p.qq_number); setPhase('extract-key'); }}>
                    <span className="ob-acct__n" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                    <span>
                      <span className="ob-acct__id">QQ {p.qq_number}</span>
                      <span className="ob-acct__sub">
                        {p.has_decrypted_data ? '已解密' : '未解密'}
                        {p.has_saved_key && ' · 已保存 key'}
                      </span>
                    </span>
                    <span className="ob-acct__go" aria-hidden="true">选择 →</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {phase === 'no-data' && (
          <>
            <Lead>Murmur 在以下位置没找到 <code>&lt;QQ号&gt;/nt_qq/nt_db/nt_msg.db</code>：</Lead>
            <div className="ob-well ob-well--list">
              {searchRoots.length > 0
                ? searchRoots.map((r, i) => <div key={i}><PathText path={r} /></div>)
                : '（未列出，可能未启用 Windows）'}
            </div>

            <Sec label="A" title="手动粘贴路径">
              <p className="ob-sec__text">打开 QQ → 设置 → 通用 → 聊天记录 → 数据保存位置，把那个路径复制过来：</p>
              <div className="ob-row ui-mt-2">
                <label className="ob-field">
                  <span className="ob-field__p" aria-hidden="true">PATH</span>
                  <input
                    type="text"
                    className="ob-input"
                    aria-label="QQ 数据保存位置"
                    value={manualPath}
                    onChange={e => setManualPath(e.target.value)}
                    placeholder='例：D:\Documents\Tencent Files'
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
                <Button variant="secondary" onClick={applyManualPath} disabled={!manualPath.trim()}>保存</Button>
              </div>
            </Sec>

            <Sec label="B" title="扫描所有硬盘">
              <p className="ob-sec__text">自动遍历 C-Z 各盘找 Tencent Files 文件夹，约 10–60 秒。</p>

              {!scanState && (
                <div className="ob-actions ob-actions--row ui-mt-3">
                  <Button variant="primary" size="lg" onClick={beginScan}>开始扫描</Button>
                </div>
              )}

              {scanState && scanState.running && (
                <div className="ob-scan ui-mt-3" role="status" aria-live="polite">
                  <div className="ob-scan__read">
                    <div>
                      <div className="ui-label">DRIVES<b>盘符</b></div>
                      <div className="ob-scan__v">{scanState.drives_done}<small> / {scanState.drives_total}</small></div>
                    </div>
                    <div>
                      <div className="ui-label">DIRS<b>已扫目录</b></div>
                      <div className="ob-scan__v">{scanState.dirs_scanned.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="ui-label">FOUND<b>候选</b></div>
                      <div className="ob-scan__v">{scanState.found.length}</div>
                    </div>
                  </div>
                  <March className="ui-mt-3" />
                  <div className="ob-scan-status">扫描中… 盘符 {scanState.drives_done}/{scanState.drives_total}</div>
                  <div className="ob-scan-path">{scanState.current_path || '准备中…'}（已扫 {scanState.dirs_scanned} 个目录）</div>
                  <div className="ob-actions ob-actions--row ui-mt-3">
                    <Button variant="secondary" onClick={stopScan}>取消</Button>
                  </div>
                </div>
              )}

              {scanState && !scanState.running && scanState.found.length === 0 && (
                <Note tone="warning" label="EMPTY" className="ui-mt-3">
                  扫完了 —— 整台机器都没找到 Tencent Files 文件夹。可能你 QQ 还没在这台电脑上登录过，或者 nt_msg.db 没生成（先开一次 QQ 登录看看）。
                </Note>
              )}

              {scanState && !scanState.running && scanState.found.length > 0 && (
                <>
                  <p className="ob-sec__text">找到 {scanState.found.length} 个候选 —— 点一个保存：</p>
                  <ul className="ob-paths ui-mt-2">
                    {scanState.found.map((f, i) => (
                      <li key={i}>
                        <button type="button" className="ob-path" onClick={() => pickScanResult(f.path)}>
                          <span className="ob-path__name">{f.qq_numbers.length} 个 QQ</span>
                          <span className="ob-path__value">
                            <PathText path={f.path} />
                            <span className="ob-path__sub">
                              {f.qq_numbers.slice(0, 3).join('、')}
                              {f.qq_numbers.length > 3 && ' …'}
                            </span>
                          </span>
                          <span className="ob-path__go" aria-hidden="true">用这个 →</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Sec>

            {errMsg && (
              <Note tone="danger" label="ERR" className="ui-mt-4"><span className="ob-prewrap">{errMsg}</span></Note>
            )}
          </>
        )}

        {phase === 'extract-key' && activeQQ && (
          <QQExtractStep qq={activeQQ} progress={progress} onStart={startExtract}
            kicked={progress !== ''} />
        )}

        {phase === 'decrypting' && <Working title={progress || '正在解密…'} />}

        {phase === 'done' && (
          <>
            <Note tone="success" label="PASS" title="QQ 数据已解密 — 即将切换到 QQ 视角">
              Key 保存在 <code>~/.murmur/qq_keys.json</code>，下次启动直接读，不用重抓。Murmur 现有的所有页面（首页 / 朋友 / 关系网 / 报告）会用 QQ 数据重新加载。
            </Note>
            <div className="ob-actions ob-actions--row">
              <Button variant="primary" size="lg" onClick={finish}>进入 QQ 视角</Button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <Note tone="danger" label="ERR"><span className="ob-prewrap">{errMsg || '未知错误'}</span></Note>
            <div className="ob-actions ob-actions--row">
              <Button variant="primary" size="lg" icon={<IconRefresh size={15} />}
                onClick={() => setPhase(activeQQ ? 'extract-key' : 'detect')}>
                再试一次
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function QQExtractStep({ qq, progress, onStart, kicked }:
  { qq: string; progress: string; onStart: () => void; kicked: boolean }) {
  return (
    <>
      <Lead>QQ 账号 <strong>{qq}</strong>。点下面按钮后：</Lead>
      <Note tone="warning" label="FIRST">
        <strong>开始前请先把电脑端 QQ 完全退出</strong>（手机上确认登出 → 电脑上点退出/关闭进程）。否则 Murmur 启动的带调试器 QQ.exe 会被你已登录的实例抢走，抓不到 key。
      </Note>
      <Sec label="DOES" title="接下来会发生：">
        <Ops items={[
          <>Murmur 启动一个<strong>带调试器</strong>的 QQ.exe</>,
          <>QQ 窗口出来后请<strong>正常扫码登录</strong></>,
          '登录瞬间 Murmur 抓住数据库密钥（16 字符），断点后台触发，你看不到',
          '抓完 QQ 自动关掉，立即解密 6 个数据库（约 5–15 秒）',
        ]} />
      </Sec>
      <Note tone="info" label="NOTE" className="ui-mt-4">
        全程<strong>不需要管理员权限</strong>。如果 QQ 窗口几秒后又被自启动 helper 拉起，可忽略 — 抓到 key 后那个无所谓。
      </Note>
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" onClick={onStart} disabled={kicked} loading={kicked}>
          {kicked ? '正在抓 key…' : '开始抓 QQ key'}
        </Button>
      </div>
      {kicked && progress && (
        <div className="ob-probe ui-mt-3" role="status"><i className="ui-led is-pulse" />{progress}</div>
      )}
    </>
  );
}
