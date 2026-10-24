// 「读取密钥」 from the home page: grab the WeChat key again (Windows: login
// hook; Mac: memory scan, or live capture on 4.1.9+), then the caller runs
// the decrypt. Same pieces as the onboarding (onboarding/*): UI-1 Dialog +
// Stepper, the shared Mac method choice, and catalog-driven errors — laid out
// as a compact instrument panel (step bar across, readouts, labelled notes).
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { extractKey, getDiagnose, saveKey } from '../data/api';
import type { Diagnose } from '../data/api';
import { maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { LiveKeyCapture } from '../components/LiveKeyCapture';
import { Button, Dialog, Stepper } from '../ui';
import type { StepItem } from '../ui';
import { keyExtractFailureCode, liveRecommended } from '../onboarding/flow';
import { createActionGuard } from '../onboarding/guard';
import { clock, describeError, Lead, logTail, Note, Ops, Segs, StepError, Working } from '../onboarding/parts';
import { MacKeyChoice } from '../onboarding/KeySteps';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: (key?: string) => void;
}

type Phase = 'intro' | 'restarting' | 'waiting-login' | 'success' | 'error' | 'live';
type Platform = 'windows' | 'macos' | 'linux';

const STEPS: StepItem[] = [
  { key: 'prep', label: '准备' },
  { key: 'read', label: '读取密钥' },
  { key: 'done', label: '完成' },
];

function guessPlatform(): Platform {
  return navigator.userAgent.toLowerCase().includes('mac') ? 'macos' : 'windows';
}

export function ExtractKeyDialog({ open, onClose, onSuccess }: Props) {
  void usePrivacy();
  const [phase, setPhase] = useState<Phase>('intro');
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Stable backend error code for `error` (data/errorCatalog.ts).
  const [errCode, setErrCode] = useState<string | null>(null);
  const [log, setLog] = useState<string>('');
  const [elapsed, setElapsed] = useState(0);
  const [diag, setDiag] = useState<Diagnose | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [macKeysCount, setMacKeysCount] = useState(0);
  const [liveReason, setLiveReason] = useState<'scan-empty' | 'version' | 'manual'>('manual');
  // A Frida round / Frida install / private-copy round is running (LiveKeyCapture).
  const [captureBusy, setCaptureBusy] = useState(false);
  // Drops a second 「开始」 click while the first extract request is in flight.
  const [guard] = useState(createActionGuard);
  const elapsedTimer = useRef<number | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  function stopTimer() {
    if (elapsedTimer.current) { window.clearInterval(elapsedTimer.current); elapsedTimer.current = null; }
  }

  useEffect(() => {
    if (!open) {
      setPhase('intro');
      setKey(null); setError(null); setErrCode(null); setLog(''); setElapsed(0); setMacKeysCount(0);
      stopTimer();
      return;
    }
    getDiagnose()
      .then(d => { setDiag(d); setPlatform(d.platform); })
      .catch(() => setPlatform(guessPlatform()));
  }, [open]);

  useEffect(() => stopTimer, []);

  // New phase → start at the top of the scrolling dialog body.
  useEffect(() => {
    mainRef.current?.closest('.ui-dialog__body')?.scrollTo({ top: 0 });
  }, [phase]);

  const isMac = platform === 'macos';

  function failWith(code: string | null, raw: string | null) {
    setError(raw);
    setErrCode(code);
    setPhase('error');
  }

  async function handleStart() {
    setError(null);
    setErrCode(null);
    let mac: boolean;
    try {
      const d = await getDiagnose();
      setDiag(d);
      setPlatform(d.platform);
      mac = d.platform === 'macos';
      if (d.platform === 'windows' && d.capabilities.weixin_running === false) {
        failWith('WECHAT_NOT_RUNNING', null);
        return;
      }
    } catch {
      mac = (platform || guessPlatform()) === 'macos';
    }

    setPhase('restarting');
    setElapsed(0);
    stopTimer();
    elapsedTimer.current = window.setInterval(() => setElapsed(e => e + 1), 1000);
    // Switch to the "go use WeChat" screen after 5 s.
    window.setTimeout(() => setPhase(p => (p === 'restarting' ? 'waiting-login' : p)), 5000);

    try {
      // Windows: hook the running WeChat instead of kill+relaunch.
      // Mac: scan the running WeChat memory for per-DB WCDB keys.
      const r = await extractKey({ autoRestart: false, timeout: 90 });
      stopTimer();
      setLog(r.log || '');
      if (r.ok) {
        if (r.key) {
          // Windows: persist one master key.
          await saveKey(r.key);
          setKey(r.key);
        } else if (mac) {
          // Mac: extract_key_mac writes ~/.murmur/decrypted_keys.json.
          setMacKeysCount(r.mac_keys_count || 0);
          setKey(null);
        } else {
          failWith('KEY_NOT_FOUND', logTail(r.log, 3));
          return;
        }
        setPhase('success');
        onSuccess?.(r.key);
      } else if (mac && r.suggest_live === true) {
        // WeChat 4.1.9+ keeps no key in memory — switch to live capture.
        setLiveReason('scan-empty');
        setPhase('live');
      } else {
        // An explicit 「没拿到」 answer: KEY_NOT_FOUND unless the backend said more.
        failWith(keyExtractFailureCode(r, !mac), logTail(r.log, 6));
      }
    } catch (e) {
      stopTimer();
      const { code, raw } = describeError(e);
      failWith(code, raw);
    }
  }

  function openLive() {
    setLiveReason(liveRecommended(diag) ? 'version' : 'manual');
    setPhase('live');
  }

  const busy = phase === 'restarting' || phase === 'waiting-login' || (phase === 'live' && captureBusy);
  const start = () => { void guard.run(handleStart); };
  const current = phase === 'intro' ? 'prep' : phase === 'success' ? 'done' : 'read';

  let title: string;
  let body: ReactNode;
  switch (phase) {
    case 'intro':
      title = isMac ? (liveRecommended(diag) ? '重新取得 Mac 解密密钥' : '现场抓取 Mac 解密密钥') : '我需要 30 秒读一下你的微信密钥';
      body = isMac ? (
        <>
          {!liveRecommended(diag) && (
            <Lead>Mac 版会现场扫描正在运行的微信。请先让微信保持登录，并点开几个聊天、群聊和朋友圈。</Lead>
          )}
          <MacKeyChoice version={diag?.wechat_version} liveFirst={liveRecommended(diag)}
            hardened={diag?.capabilities.wechat_hardened === true}
            onScan={start} onLive={openLive} />
        </>
      ) : <WinIntro onStart={start} />;
      break;
    case 'restarting':
      title = isMac ? '正在扫描微信内存…' : '正在安装微信 hook…';
      body = (
        <Working
          title={isMac ? '正在扫描微信内存里的数据库密钥' : '正在把 hook 装到当前微信进程'}
          sub={isMac ? `已等 ${elapsed} 秒 · 可以去微信点开更多聊天，帮更多密钥进入内存` : `已等 ${elapsed} 秒 · 装好后请回微信完成登录`} />
      );
      break;
    case 'waiting-login':
      title = isMac ? '请在微信里点开聊天和朋友圈' : '请回微信登录一次';
      body = <WaitingLogin isMac={isMac} elapsed={elapsed} />;
      break;
    case 'live':
      title = '实时抓取密钥（微信 4.1.9+）';
      body = (
        <LiveKeyCapture reason={liveReason} wechatVersion={diag?.wechat_version}
          keycapAvailable={diag?.private_copy?.available}
          hardened={isMac && diag?.capabilities.wechat_hardened === true}
          onBusyChange={setCaptureBusy}
          onDecrypt={() => { onSuccess?.(); onClose(); }} />
      );
      break;
    case 'success':
      title = '密钥已就位';
      body = <Success keyHex={key} macKeysCount={macKeysCount} isMac={isMac} onClose={onClose} />;
      break;
    case 'error':
    default:
      title = '读取密钥没有完成';
      body = (
        // errCode is whatever actually failed: the backend's code, KEY_NOT_FOUND
        // for an explicit empty answer, or the network / HTTP error's own code.
        <StepError code={errCode} raw={error} log={log}
          retryLabel="再试一次" onRetry={() => setPhase('intro')} />
      );
      break;
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      accent
      // Busy (scan / capture running): Esc / ✕ stay off until it settles.
      dismissible={!busy}
      closeOnScrim={false}
      className="ob-dialog ob-dialog--key"
      eyebrow="初始化 · 读取密钥"
      title={title}
    >
      <div ref={mainRef}>
        <Stepper className="ob-key-stepper" steps={STEPS} current={current} error={phase === 'error'}
          onStepClick={busy ? undefined : k => { if (k === 'prep') setPhase('intro'); }} />
        <div className="ob-dialog-main" key={phase}>
          {body}
        </div>
      </div>
    </Dialog>
  );
}

function WinIntro({ onStart }: { onStart: () => void }) {
  return (
    <>
      <Lead>Windows 版抓的是登录事件。请先把微信退到登录页，但不要关闭微信程序，再回 Murmur 开始。</Lead>
      <Ops items={[
        { t: '先把微信退到登录页', d: '只退出账号，不要关闭微信程序；任务管理器里应该还有 Weixin.exe 或 WeChat.exe。' },
        { t: '回 Murmur 点开始抓密钥', d: '我会把 hook 装到当前微信进程，然后等下一次登录事件。' },
        { t: '立刻回微信扫码 / 确认登录', d: '读到密钥后会自动保存，以后不用再做这步；密钥只存在你的电脑上，不会上传。' },
      ]} />
      <Note tone="warning" label="TIMING" className="ui-mt-4">
        准备好了再开始 —— 开始后请立刻回微信登录，90 秒内完成最稳。
      </Note>
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" onClick={onStart}>开始抓密钥</Button>
      </div>
    </>
  );
}

const WAIT_MAX = 90;

function WaitingLogin({ isMac, elapsed }: { isMac: boolean; elapsed: number }) {
  const shown = Math.min(WAIT_MAX, elapsed);
  return (
    <>
      <div className="ob-run" role="progressbar" aria-label="已等待时间" aria-valuemin={0} aria-valuemax={WAIT_MAX} aria-valuenow={shown}>
        <div className="ob-run__status">
          <span className="ui-label"><i className="ui-led is-pulse" />WAIT</span>
          <span className="ob-run__head">{isMac ? '正在扫描本机微信内存' : 'Hook 已就位，等待登录事件'}</span>
        </div>
        <div className="ob-run__read">
          <div className="ui-big ob-run__big">{clock(elapsed)}</div>
          <div className="ob-run__meta">
            <div className="ui-label">ELAPSED<b>已等 {elapsed} 秒</b></div>
            <div className="ui-label">TIMEOUT<b>最多等 {WAIT_MAX} 秒</b></div>
          </div>
        </div>
        <Segs n={45} on={shown / 2} className="ob-segs--round" />
        <div className="ob-scale" aria-hidden="true"><span>0 S</span><span>45 S</span><span>90 S</span></div>
      </div>
      <Note tone="accent" label="NOW" className="ui-mt-4"
        title={isMac ? '现在请到微信里点开聊天、群聊和朋友圈' : '现在请回微信完成登录'}>
        {isMac
          ? 'Murmur 正在扫描本机微信内存。Mac 微信是按需打开数据库的：多点几个对话和朋友圈，能让更多密钥出现在内存里。'
          : 'Hook 已经在等登录事件。请回微信扫码或确认登录；如果还停在已登录状态，先退出到登录页再登录一次。登录成功的瞬间，我这边就能拿到密钥。'}
      </Note>
      <p className="ob-muted ui-mt-3">
        {isMac
          ? '不需要退出登录，也不需要关闭微信。如果这次没扫到，回微信多打开几个聊天后再试一次。'
          : '看到二维码或登录确认是正常的，按微信提示完成即可。看不到微信窗口？点一下任务栏里的微信图标。'}
      </p>
    </>
  );
}

function Success({ keyHex, macKeysCount, isMac, onClose }: { keyHex: string | null; macKeysCount: number; isMac: boolean; onClose: () => void }) {
  return (
    <>
      <div className="ob-done ob-done--sm">
        <div className="ui-big ob-done__big">{isMac && macKeysCount ? String(macKeysCount).padStart(2, '0') : 'OK'}</div>
        <div className="ob-done__meta">
          <div className="ui-label"><i className="ui-led" />{isMac ? 'KEYS' : 'KEY'}<b>{isMac ? '个数据库密钥' : '主密钥 · 已验证'}</b></div>
          <div className="ui-label">SAVED<b>只存在这台电脑上</b></div>
        </div>
      </div>
      <Note tone="success" label="PASS" title={isMac ? `已取得 ${macKeysCount || '多'} 个数据库密钥` : '已取得并验证密钥'}>
        {isMac
          ? '已保存到 ~/.murmur/decrypted_keys.json —— 现在可以更新并重新解密最新数据。'
          : '已保存到 ~/.murmur/config.json —— 以后启动 Murmur 直接用，不用再读。'}
        {!isMac && keyHex && <div className="ob-well">{maskText(keyHex)}</div>}
      </Note>
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" onClick={onClose}>{isMac ? '更新最新数据' : '开始用 Murmur'}</Button>
      </div>
    </>
  );
}
