// WeChat onboarding (UI-4), drawn as a full-window instrument (direction B):
// a status strip, the segmented step bar —
//   环境自检 → 数据目录 → 授权/重签 (Mac) → 取得密钥 → 解密 → 完成
// — and a rack of modules: what the diagnose read (left), the current
// screen (centre), a session log and what this step does / does not do
// (right). Any finished step can be clicked to redo just that step. Where a
// fresh diagnose lands is still the old decision tree (onboarding/flow.ts:
// routeAfterCheck); every failure renders through the error catalog
// (onboarding/parts.tsx: StepError).
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ERROR_LEVEL_LABEL, lookupError } from '../data/errorCatalog';
import { maskText } from '../utils/privacy';
import { extractKey, getDiagnose, getInfo, openFullDiskAccess, refreshData, resignWechat, saveKey } from '../data/api';
import type { Diagnose } from '../data/api';
import { usePrivacy } from '../utils/usePrivacy';
import { LiveKeyCapture } from '../components/LiveKeyCapture';
import { Button, Dialog, Module } from '../ui';
import {
  buildChecks, blockingCount, canForceDecrypt, dialogBusy, keyExtractFailureCode, liveRecommended, routeAfterCheck,
  savedKeyPath, stepsFor, STEP_LABEL, VIEW_STEP,
} from '../onboarding/flow';
import type { KeySource, Platform, Route, StepKey, View } from '../onboarding/flow';
import type { CaptureMethod } from '../onboarding/capture';
import { createActionGuard } from '../onboarding/guard';
import {
  CheckReadout, checkTally, describeError, InlineError, Lead, logTail, Note, Ops, PathText, StepError, StepRail,
  StripClock, Working,
} from '../onboarding/parts';
import { SelfCheck } from '../onboarding/SelfCheck';
import { DataStep, FdaStep } from '../onboarding/DataStep';
import { AuthStep, MacKeyStep, MacPasteKey, MacWaitLogin, WinKeyStep } from '../onboarding/KeySteps';

interface Props {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  onPickQQ?: () => void;
  // Non-null when backend reports `bootstrap=true` because EchoStore couldn't
  // construct (e.g. session.db has no SessionTable, file is not a database,
  // partial-decrypt residue). Shown above Welcome so users see WHY they were
  // sent back here, instead of silently looping through onboarding.
  initError?: string | null;
}

type Screen = View | 'welcome' | 'error';

interface Failure {
  step: StepKey;
  code: string | null;
  raw?: string | null;
  log?: string | null;
  /** Screen 「重试这一步」 goes back to (default: the step's entry screen). */
  retryView?: View;
}

function guessPlatform(): Platform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? 'macos' : 'windows';
}

export function OnboardingDialog({ open, onClose, onDone, onPickQQ, initError }: Props) {
  void usePrivacy();
  const [screen, setScreen] = useState<Screen>('welcome');
  const [diag, setDiagState] = useState<Diagnose | null>(null);
  const diagRef = useRef<Diagnose | null>(null);
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState<ReadonlySet<StepKey>>(() => new Set());
  const [fail, setFail] = useState<Failure | null>(null);
  const [progress, setProgress] = useState('');
  const [liveReason, setLiveReason] = useState<'scan-empty' | 'version' | 'manual'>('manual');
  const [lastForce, setLastForce] = useState(false);
  const [initCode, setInitCode] = useState<string | null>(null);
  // 「我已经授权并重启过了」 and TCC still blocks → say so on the FDA screen.
  const [fdaStillBlocked, setFdaStillBlocked] = useState(false);
  // A Frida round / Frida install / private-copy round is running (reported by
  // LiveKeyCapture): lock the step rail and Esc like the spinner screens.
  const [captureBusy, setCaptureBusy] = useState(false);
  // 实时抓取 opened from 「先不重签：用免 Frida 方式」 goes straight to that method.
  const [liveMethod, setLiveMethod] = useState<CaptureMethod | null>(null);
  // How this run got its key — the 完成 screen says where it was saved.
  const [keySource, setKeySource] = useState<KeySource>(null);
  // Every button goes through this: a second click while the first action is
  // still running (double click) is dropped instead of sending a second request.
  const [guard] = useState(createActionGuard);
  const act = (fn: () => unknown) => () => { void guard.run(fn); };
  const layoutRef = useRef<HTMLDivElement>(null);
  // Session log (right-hand module): what happened in this window, in order.
  // Display only — built from state changes, never sent anywhere.
  const [log, setLog] = useState<LogLine[]>([]);
  const lastDiagLine = useRef('');
  const wasCapturing = useRef(false);
  function pushLog(tag: string, text: string, tone?: LogLine['tone']) {
    setLog(l => [...l.slice(-59), { at: stamp(), tag, text, tone }]);
  }

  function setDiag(d: Diagnose) {
    diagRef.current = d;
    setDiagState(d);
  }

  useEffect(() => {
    if (!open) return;
    setScreen('welcome');
    setFail(null);
    setDone(new Set());
    setFdaStillBlocked(false);
    setKeySource(null);
    setLiveMethod(null);
    setLog([{ at: stamp(), tag: 'SETUP', text: '打开初始化引导' }]);
    // A diagnose left over from an earlier run is not news.
    lastDiagLine.current = diagRef.current ? diagLogKey(diagRef.current) : '';
    wasCapturing.current = false;
  }, [open]);

  // ——— session log entries (display only) ———
  useEffect(() => {
    if (!open || screen === 'welcome') return;
    if (screen === 'error') {
      pushLog('ERR', `${fail?.code || '未知错误'} · 卡在「${STEP_LABEL[fail?.step ?? 'check']}」`, 'err');
      return;
    }
    const step = VIEW_STEP[screen];
    const at = stepsFor(diagRef.current?.platform ?? guessPlatform()).indexOf(step) + 1;
    pushLog(STEP_TAG[step], `第 ${String(at).padStart(2, '0')} 步 · ${SCREEN_LOG[screen]}`, BUSY_SCREENS.has(screen) ? 'run' : undefined);
  }, [open, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !diag) return;
    const rows = buildChecks(diag);
    const line = `检测完成 · ${rows.length} 项 · 需处理 ${blockingCount(rows)} · 留意 ${rows.filter(r => r.status === 'warn').length}`;
    const key = diagLogKey(diag);
    if (key === lastDiagLine.current) return;  // the Windows re-check polls every 2.5 s
    lastDiagLine.current = key;
    pushLog('ENV', line, blockingCount(rows) > 0 ? 'warn' : 'ok');
    if (diag.wechat_version) pushLog('ENV', `微信 ${diag.wechat_version}`);
    if (diag.platform === 'windows') {
      pushLog('ENV', diag.capabilities.weixin_running === false ? '微信没在运行' : '微信正在运行',
        diag.capabilities.weixin_running === false ? 'warn' : undefined);
    }
    pushLog('DIR', diag.profiles.length ? `找到 ${diag.profiles.length} 个账号` : '还没找到数据目录',
      diag.profiles.length ? undefined : 'warn');
  }, [open, diag]);

  useEffect(() => {
    if (!open) return;
    if (captureBusy && !wasCapturing.current) pushLog('KEY', '抓取进行中（后台）', 'run');
    if (!captureBusy && wasCapturing.current) pushLog('KEY', '这一轮结束');
    wasCapturing.current = captureBusy;
  }, [open, captureBusy]);

  // The stuck-data banner: /api/info carries the catalog code for init_error.
  useEffect(() => {
    if (!open || !initError) { setInitCode(null); return; }
    let cancelled = false;
    getInfo()
      .then(i => { if (!cancelled) setInitCode(i.init_error_code ?? null); })
      .catch(() => { /* fall back to STORE_INIT_FAILED */ });
    return () => { cancelled = true; };
  }, [open, initError]);

  // Windows: while WeChat isn't running, re-check every 2.5 s so 「开始抓密钥」
  // unlocks by itself once the user opens WeChat.
  useEffect(() => {
    if (!open || screen !== 'key' || diag?.platform !== 'windows' || diag.capabilities.weixin_running !== false) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const d = await getDiagnose();
        if (!cancelled) setDiag(d);
      } catch {
        // Keep the current card; the manual button can still retry.
      }
    }, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, screen, diag?.platform, diag?.capabilities.weixin_running]);

  // New screen → start at the top (the window scrolls on narrow widths, the
  // centre module on wide ones).
  useEffect(() => {
    layoutRef.current?.closest('.ui-dialog__body')?.scrollTo({ top: 0 });
    layoutRef.current?.querySelector('.ob-center > .ui-mod__body')?.scrollTo({ top: 0 });
  }, [screen]);

  const platform: Platform = diag?.platform ?? guessPlatform();
  const steps = stepsFor(platform);

  // ———————— navigation ————————

  function show(v: View) {
    setFail(null);
    setScreen(v);
  }

  /** Move forward: every step before `v`'s is done, later ones are not (yet). */
  function advance(v: View) {
    const order = stepsFor(diagRef.current?.platform ?? guessPlatform());
    const at = order.indexOf(VIEW_STEP[v]);
    setDone(new Set(order.slice(0, Math.max(0, at))));
    show(v);
  }

  function failAt(step: StepKey, f: Omit<Failure, 'step'>) {
    setFail({ step, ...f });
    setScreen('error');
  }

  function follow(r: Route) {
    if (r.kind === 'view') advance(r.view);
    else if (r.kind === 'decrypt') void runDecrypt();
    else failAt(r.step, { code: r.code });
  }

  /** Redo one step without touching the others. */
  function redo(step: StepKey): Promise<void> | void {
    const d = diagRef.current;
    if (step === 'check' || !d) return runCheck();
    if (step === 'data') show(d.platform === 'macos' && d.capabilities.tcc_blocked ? 'fda' : 'data');
    else if (step === 'auth') show('auth');
    else if (step === 'key') show('key');
    else if (step === 'decrypt') show('decrypt');
    else show('done');
  }

  function retry(f: Failure): Promise<void> | void {
    if (f.step === 'decrypt') return runDecrypt({ force: lastForce });
    if (f.retryView) { show(f.retryView); return; }
    return redo(f.step);
  }

  // ———————— actions ————————

  async function runCheck() {
    show('check');
    setChecking(true);
    try {
      setDiag(await getDiagnose());
    } catch (e) {
      failAt('check', describeError(e));
    } finally {
      setChecking(false);
    }
  }

  /** Re-diagnose and go wherever that lands (after saving a folder / granting FDA). */
  async function recheckAndFollow(from: StepKey) {
    setChecking(true);
    try {
      const d = await getDiagnose();
      setDiag(d);
      const r = routeAfterCheck(d);
      setFdaStillBlocked(r.kind === 'view' && r.view === 'fda');
      follow(r);
    } catch (e) {
      failAt(from, describeError(e));
    } finally {
      setChecking(false);
    }
  }

  async function runDecrypt(opts: { force?: boolean; text?: string } = {}) {
    setLastForce(!!opts.force);
    setProgress(opts.text || '正在解密所有微信数据库…');
    advance('decrypting');
    try {
      const r = await refreshData(opts.force ? { force: true } : {});
      if (!r.ok) { failAt('decrypt', { code: r.code ?? 'DECRYPT_FAILED', raw: r.details }); return; }
      // Decrypt succeeded but the backend still can't load the store (e.g.
      // session.db without SessionTable) — don't pretend success and loop.
      if (r.init_error) { failAt('decrypt', { code: r.code ?? 'STORE_INIT_FAILED', raw: r.init_error }); return; }
      advance('done');
    } catch (e) {
      failAt('decrypt', describeError(e));
    }
  }

  async function submitMacKey(key: string) {
    const cleaned = key.trim().toLowerCase();
    if (cleaned.length !== 64 || !/^[0-9a-f]+$/.test(cleaned)) {
      failAt('key', { code: 'KEY_FORMAT_INVALID', retryView: 'paste' });
      return;
    }
    try {
      const sr = await saveKey(cleaned);
      if (!sr.ok) { failAt('key', { code: sr.code ?? null, raw: sr.error, retryView: 'paste' }); return; }
      setKeySource('paste');
      await runDecrypt();
    } catch (e) {
      failAt('key', { ...describeError(e), retryView: 'paste' });
    }
  }

  async function startKeyExtract() {
    const win = diagRef.current?.platform === 'windows';
    try {
      if (win) {
        const latest = await getDiagnose();
        setDiag(latest);
        if (latest.capabilities.weixin_running === false) { failAt('key', { code: 'WECHAT_NOT_RUNNING' }); return; }
      }
      setProgress(win
        ? 'Hook 正在等待登录事件：请保持微信在登录页，然后去微信点击登录 / 扫码登录…'
        : '正在扫描微信进程内存…');
      show('extracting');
      // autoRestart=false: hook the running WeChat instead of kill+relaunch
      // (on Win11 + WeChat 4.1.x a relaunched Weixin.exe can die before the
      // hook attaches). The user logs out first, Murmur installs the hook,
      // then the login event carries the key.
      const r = await extractKey({ autoRestart: false, timeout: 90 });
      if (!r.ok && !win && r.suggest_live === true) {
        // WeChat 4.1.9+: the memory scan legitimately finds nothing — go
        // straight to live capture instead of dead-ending on an error.
        setLiveReason('scan-empty');
        show('live');
        return;
      }
      if (!r.ok) {
        failAt('key', { code: keyExtractFailureCode(r, win), raw: logTail(r.log) });
        return;
      }
      // Windows returns the master key; Mac writes ~/.murmur/decrypted_keys.json itself.
      if (r.key) await saveKey(r.key);
      setKeySource('capture');
      await runDecrypt({ text: '密钥已就位，开始解密…' });
    } catch (e) {
      failAt('key', describeError(e));
    }
  }

  async function startResign() {
    setProgress('检查微信是否已退出，然后重签名…（系统会弹窗要开机密码）');
    show('resigning');
    try {
      const r = await resignWechat({ relaunch: true });
      if (!r.ok) {
        failAt('auth', { code: r.code ?? 'RESIGN_FAILED', raw: [r.error, r.stderr].filter(Boolean).join('\n') });
        return;
      }
      advance('wait-login');
      // Refresh the signature row in the background.
      getDiagnose().then(setDiag).catch(() => { /* keep the old diagnose */ });
    } catch (e) {
      failAt('auth', describeError(e));
    }
  }

  function openLive(method: CaptureMethod | null = null) {
    setLiveReason(liveRecommended(diagRef.current) ? 'version' : 'manual');
    setLiveMethod(method);
    advance('live');
  }

  function openFda() {
    openFullDiskAccess().catch(e => console.warn('open-fda failed', e));
  }

  // ———————— render ————————

  const busy = dialogBusy(screen, checking, captureBusy);
  const current: StepKey | null = screen === 'welcome' ? null : screen === 'error' ? (fail?.step ?? 'check') : VIEW_STEP[screen];
  const stepNo = current ? steps.indexOf(current) + 1 : 0;
  const mac = platform === 'macos';
  const rows = diag ? buildChecks(diag) : [];

  const notes: Partial<Record<StepKey, string>> = {};
  if (diag) {
    const blocking = blockingCount(rows);
    const warns = rows.filter(r => r.status === 'warn').length;
    notes.check = blocking > 0 ? `${blocking} 项需要处理` : warns > 0 ? `${warns} 项留意一下` : '环境没问题';
    if (diag.profiles.length) notes.data = `找到 ${diag.profiles.length} 个账号`;
    if (mac && diag.capabilities.wechat_hardened === false) notes.auth = '已重签';
    else if (mac && diag.capabilities.wechat_hardened) notes.auth = diag.saved_key ? '已有密钥，不用重签' : '需要重签';
    if (diag.saved_key || keySource) notes.key = '已保存';
    else if (liveRecommended(diag)) notes.key = '推荐实时抓取';
  }

  let title: string;
  let body: ReactNode;
  // Right-hand readout in the centre module's header.
  let readout: ReactNode;
  switch (screen) {
    case 'welcome':
      title = '回顾你的微信故事';
      readout = '≈ 2–5 MIN';
      body = (
        <Welcome initError={initError} initCode={initCode} onPickQQ={onPickQQ} mac={guessPlatform() === 'macos'}
          stepCount={steps.length}
          onStart={act(() => { setDone(new Set()); return runCheck(); })} />
      );
      break;
    case 'check':
      title = '先检查一下环境';
      readout = diag && !checking ? checkTally(rows) : 'READING…';
      body = (
        <SelfCheck diag={diag} checking={checking} route={diag ? routeAfterCheck(diag) : null}
          onContinue={act(() => { if (diag) follow(routeAfterCheck(diag)); })}
          onRecheck={act(runCheck)}
          onGotoData={() => advance(diag?.platform === 'macos' && diag.capabilities.tcc_blocked ? 'fda' : 'data')}
          onGotoAuth={() => advance('auth')} />
      );
      break;
    case 'fda':
      title = '给 Murmur 完全磁盘访问权限';
      readout = 'TCC · FULL DISK';
      body = (
        <>
          {fdaStillBlocked && <InlineError code="TCC_BLOCKED" className="ui-mb-4" />}
          <FdaStep onOpenSettings={openFda} onRetry={act(() => recheckAndFollow('data'))} retrying={checking} />
        </>
      );
      break;
    case 'data':
      title = diag?.profiles.length ? '找到你的微信数据' : mac ? 'Mac 上还没找到微信数据' : '没找到微信数据目录';
      readout = `PROFILES ${diag?.profiles.length ?? 0}`;
      body = diag && (
        <DataStep diag={diag} onSaved={() => recheckAndFollow('data')}
          onNext={act(() => follow(routeAfterCheck(diag)))}
          onRecheck={act(() => recheckAndFollow('data'))} onOpenFda={openFda} />
      );
      break;
    case 'auth':
      title = diag?.capabilities.wechat_hardened === false ? '微信已经重签过了' : '一次性给微信重签名（不用关 SIP）';
      readout = diag?.capabilities.wechat_hardened === false ? 'SIGN · AD-HOC' : 'SIGN · HARDENED';
      body = diag && (
        <AuthStep diag={diag} onResign={act(startResign)} onNext={() => advance('key')}
          onPaste={() => advance('paste')} onPrivateCopy={() => openLive('private-copy')} onOpenFda={openFda} />
      );
      break;
    case 'resigning':
      title = '正在重签名…';
      readout = 'CODESIGN';
      body = <Working title={progress || '正在重签名…'} sub="系统弹出密码窗口时，输入这台电脑的开机密码。" />;
      break;
    case 'wait-login':
      title = '微信已重启：先登录，再回来抓密钥';
      readout = 'NO TIME LIMIT';
      body = <MacWaitLogin diag={diag} onScan={act(startKeyExtract)} onLive={() => openLive()} />;
      break;
    case 'key':
      title = mac ? (liveRecommended(diag) ? '取得解密密钥' : '一切就绪 —— 一键抓密钥') : '只需要 30 秒，读取一次密钥';
      readout = mac ? (diag?.wechat_version ? `WECHAT ${diag.wechat_version}` : null) : 'LOGIN HOOK';
      body = diag && (mac ? (
        <MacKeyStep diag={diag} onScan={act(startKeyExtract)} onLive={() => openLive()}
          onPaste={() => show('paste')} onResign={() => show('auth')} />
      ) : (
        <WinKeyStep diag={diag} onStart={act(startKeyExtract)} rechecking={checking}
          onRecheck={act(async () => {
            setChecking(true);
            try { setDiag(await getDiagnose()); } catch { /* keep the card */ } finally { setChecking(false); }
          })} />
      ));
      break;
    case 'live':
      title = '实时抓取密钥（微信 4.1.9+）';
      readout = captureBusy ? <span className="ob-run-tag"><i className="ui-led is-pulse" />CAPTURING</span> : 'LIVE CAPTURE';
      body = (
        <LiveKeyCapture reason={liveReason} wechatVersion={diag?.wechat_version}
          keycapAvailable={diag?.private_copy?.available}
          hardened={mac && diag?.capabilities.wechat_hardened === true}
          initialMethod={liveMethod} onBusyChange={setCaptureBusy}
          onDecrypt={act(() => { setKeySource('capture'); return runDecrypt(); })} onPaste={() => show('paste')} />
      );
      break;
    case 'paste':
      title = '手动粘贴密钥';
      readout = '64 HEX';
      body = diag && <MacPasteKey diag={diag} onSubmit={k => void guard.run(() => submitMacKey(k))} onLive={() => openLive()} />;
      break;
    case 'extracting':
      title = '正在读取密钥…';
      readout = 'TIMEOUT 90 S';
      body = <Working title={progress} sub="过程中如果看到微信弹窗，记得点「登录」。" />;
      break;
    case 'decrypt':
      title = '重新解密';
      readout = 'LOCAL';
      body = <DecryptStep canForce={canForceDecrypt(diag)} onRun={force => void guard.run(() => runDecrypt({ force }))} />;
      break;
    case 'decrypting':
      title = '正在解密最新数据…';
      readout = 'LOCAL';
      body = <Working title={progress || '正在解密所有微信数据库…'} sub="数据多的话要几分钟，请不要关闭 Murmur。" />;
      break;
    case 'done':
      title = '一切就绪';
      readout = 'READY';
      body = <DoneStep total={steps.length} keyPath={savedKeyPath(platform, keySource)} onEnter={() => { onClose(); onDone?.(); }} />;
      break;
    case 'error':
    default:
      title = `卡在「${STEP_LABEL[fail?.step ?? 'check']}」这一步`;
      readout = fail?.code ? `ERR · ${fail.code}` : 'ERR';
      body = fail && (
        <StepError code={fail.code} raw={fail.raw} log={fail.log}
          onRetry={act(() => retry(fail))}
          actions={fail.step !== 'check' ? (
            <Button variant="ghost" onClick={act(runCheck)}>重新检测环境</Button>
          ) : undefined} />
      );
      break;
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const railHint = !current ? '大约需要 2–5 分钟，全部在你的电脑上完成。'
    : !busy ? '点已完成的步骤可以单独重做，不用从头再来。'
      : '这一步正在进行，结束后才能切换到别的步骤。';
  const centreStep: StepKey | 'welcome' = current ?? 'welcome';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      // While something runs, Esc / ✕ would close the onboarding and mark it
      // as seen with the job still going — keep it open until it settles.
      dismissible={!busy}
      closeOnScrim={false}
      closeLabel="跳过引导（不推荐）"
      className="ob-dialog ob-full"
      eyebrow={current ? `微信初始化 · 第 ${stepNo} 步，共 ${steps.length} 步` : '欢迎来到 Murmur'}
      title={title}
      footer={
        <>
          <Button size="sm" kbd="Esc" className="ob-key" onClick={onClose} disabled={busy}
            title="跳过引导（不推荐）" aria-label="跳过引导（不推荐）">
            跳过引导
          </Button>
          <span className="ob-keys__hint">{railHint}</span>
          <span className="ob-keys__stat">
            <span>SETUP <b>{current ? pad(stepNo) : '00'} / {pad(steps.length)}</b></span>
            <span className="ob-keys__local">全部在你的电脑上完成</span>
          </span>
        </>
      }
    >
      <div className="ob-frame" ref={layoutRef}>
        <header className="ob-strip">
          <span className="ob-brand">MURMUR<span>微语</span></span>
          <span className="ob-crumb">SETUP /<b>{current ? '微信初始化' : '首次使用'}</b></span>
          <span className="ob-strip__r">
            {diag && <span className="ob-strip__opt">{PLATFORM_EN[platform]}</span>}
            {mac && diag?.wechat_version && <span className="ob-strip__opt">WECHAT {diag.wechat_version}</span>}
            {busy && <span className="ob-strip__busy"><i className="ui-led is-pulse" />BUSY</span>}
            <StripClock />
          </span>
        </header>
        <div className="ob-rack">
          <StepRail steps={steps} current={current} done={done} error={screen === 'error'}
            notes={notes} onStepClick={busy ? undefined : k => void guard.run(() => redo(k))} />

          <aside className="ob-col ob-col--l" aria-label="环境读数">
            <LeftPanels screen={screen} diag={diag} rows={rows} steps={steps} checking={checking} />
          </aside>

          <Module className="ob-center" scroll
            id={current ? pad(stepNo) : '00'}
            title={screen === 'error' ? `${STEP_LABEL[fail?.step ?? 'check']} · 出错` : current ? STEP_LABEL[current] : '开始'}
            en={screen === 'error' ? 'FAULT' : STEP_EN[centreStep]}
            right={readout}>
            <div className="ob-main" key={screen}>
              <div className={`ob-status${screen === 'error' ? ' is-error' : ''}`}>
                <span className="ui-label">
                  {screen === 'error' ? 'FAULT' : BUSY_SCREENS.has(screen) ? 'RUN' : 'STATUS'}
                  <b>{screen === 'error' ? '出错' : current ? `第 ${pad(stepNo)} 步 · ${STEP_LABEL[current]}` : '欢迎来到 Murmur'}</b>
                </span>
                <p className="ob-title">{title}</p>
              </div>
              {body}
            </div>
          </Module>

          <aside className="ob-col ob-col--r" aria-label="日志与说明">
            <Module className="ob-fill" scroll id="—" title="日志" en="LOG" right="LIVE · 本机">
              <SessionLog lines={log} />
            </Module>
            {screen === 'error' && fail ? (
              <ErrorCatalogPanel code={fail.code} step={fail.step} stepNo={stepNo} />
            ) : (
              <ScopePanel step={centreStep} />
            )}
          </aside>
        </div>
      </div>
    </Dialog>
  );
}

// ———————————————————————— side panels ————————————————————————

interface LogLine { at: string; tag: string; text: string; tone?: 'ok' | 'warn' | 'err' | 'run' }

/** Changes when the self-check readout would read differently. */
function diagLogKey(d: Diagnose): string {
  return buildChecks(d).map(r => `${r.id}:${r.status}:${r.value}`).join('|');
}

function stamp(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

const STEP_TAG: Record<StepKey, string> = {
  check: 'ENV', data: 'DIR', auth: 'AUTH', key: 'KEY', decrypt: 'DEC', done: 'DONE',
};

const STEP_EN: Record<StepKey | 'welcome', string> = {
  welcome: 'SETUP', check: 'DIAGNOSE', data: 'DATA DIR', auth: 'CODESIGN', key: 'KEY CAPTURE', decrypt: 'DECRYPT', done: 'READY',
};

const PLATFORM_EN: Record<Platform, string> = { macos: 'MACOS', windows: 'WINDOWS', linux: 'LINUX' };

const BUSY_SCREENS: ReadonlySet<Screen> = new Set<Screen>(['resigning', 'extracting', 'decrypting']);

const SCREEN_LOG: Record<View, string> = {
  check: '检测环境',
  fda: '等待完全磁盘访问授权',
  data: '数据目录',
  auth: '授权 / 重签名',
  resigning: '正在重签名微信',
  'wait-login': '微信已重启，等待登录',
  key: '选择取得密钥的方式',
  live: '实时抓取',
  paste: '手动粘贴密钥',
  extracting: '正在读取密钥',
  decrypt: '重新解密',
  decrypting: '正在解密',
  done: '一切就绪',
};

/** What each step touches, from the step's own copy — shown beside it. */
const STEP_SCOPE: Record<StepKey | 'welcome', { does: string[]; not: string[] }> = {
  welcome: {
    does: ['从微信读出数据，在你的电脑上分析和呈现'],
    not: ['上传到任何地方'],
  },
  check: {
    does: ['读取微信版本、数据目录、权限和签名状态'],
    not: ['改动微信或你的文件'],
  },
  data: {
    does: ['查找微信的加密数据库目录', '记住你指定的数据目录'],
    not: ['在这一步读取聊天内容'],
  },
  auth: {
    does: ['退出微信，给微信主程序重新做 ad-hoc 签名', '弹出系统认证窗口，要你输入开机密码', '重新打开微信'],
    not: ['关闭 SIP', '自动开始抓密钥'],
  },
  key: {
    does: ['取得微信数据库的解密密钥', '把密钥保存在这台电脑的 ~/.murmur/ 里'],
    not: ['上传任何内容'],
  },
  decrypt: {
    does: ['用保存的密钥，在本机把微信数据库解密一份'],
    not: ['改动微信本身的聊天记录'],
  },
  done: {
    does: ['下次启动直接读取保存的密钥'],
    not: ['再要你重新抓密钥（除非微信换了账号）'],
  },
};

const STEP_DESC: Record<StepKey, string> = {
  check: '看一眼这台电脑的情况',
  data: '找到微信的加密数据库',
  auth: '给微信做一次 ad-hoc 重签名',
  key: '取得数据库的解密密钥',
  decrypt: '在本机解密一份副本',
  done: '进入 Murmur',
};

function LeftPanels({ screen, diag, rows, steps, checking }: {
  screen: Screen; diag: Diagnose | null; rows: ReturnType<typeof buildChecks>; steps: StepKey[]; checking: boolean;
}) {
  if (!diag || (screen === 'check' && checking)) {
    return (
      <Module className="ob-fill" id="—" title="流程" en="SEQUENCE" right={`${steps.length} STEPS`}>
        <ol className="ob-seq">
          {steps.map((k, i) => (
            <li key={k}>
              <span className="ob-seq__n">{String(i + 1).padStart(2, '0')}</span>
              <span className="ob-seq__k">{STEP_LABEL[k]}</span>
              <span className="ob-seq__d">{STEP_DESC[k]}</span>
            </li>
          ))}
        </ol>
      </Module>
    );
  }
  const profiles = (
    <Module className="ob-fill" id="—" title="路径" en="PATH" right="READ ONLY">
      {diag.profiles.length ? (
        <ul className="ob-pathlist">
          {diag.profiles.map(p => (
            <li key={p.wxid}>
              <span className="ob-pathlist__k">{maskText(p.wxid_short)}</span>
              <span className="ob-pathlist__v"><PathText path={maskText(p.encrypted_root)} /></span>
            </li>
          ))}
        </ul>
      ) : <div className="ob-side-empty">还没找到微信数据目录</div>}
    </Module>
  );
  if (screen === 'check') {
    const sys: Array<[string, string]> = [
      ['平台', PLATFORM_EN[diag.platform]],
      ['Python', diag.python || '—'],
      ['微信程序', diag.wechat_exe ? maskText(diag.wechat_exe) : '没找到'],
      ['Murmur 目录', maskText(diag.murmur_home)],
      ['本机 AI 工具', `${diag.agents_found} 个`],
    ];
    return (
      <>
        <Module id="—" title="本机" en="SYSTEM" right="READ">
          <ul className="ob-ck">
            {sys.map(([k, v]) => (
              <li key={k} className="ob-ck__row ob-ck__row--plain">
                <span className="ob-ck__k">{k}</span>
                <span className="ob-ck__v" title={v}>{v}</span>
              </li>
            ))}
          </ul>
        </Module>
        {profiles}
      </>
    );
  }
  return (
    <>
      <Module id="—" title="环境" en="DIAG" right={checkTally(rows)}>
        <CheckReadout rows={rows} />
      </Module>
      {profiles}
    </>
  );
}

function SessionLog({ lines }: { lines: LogLine[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = end.current?.closest('.ui-mod__body');
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines.length]);
  return (
    <div className="ob-log" role="log" aria-live="off">
      {lines.map((l, i) => (
        <div key={i} className={`ob-log__row${l.tone ? ` is-${l.tone}` : ''}`}>
          <span className="ob-log__t">{l.at}</span>
          <span className="ob-log__tag">{l.tag}</span>
          <span className="ob-log__x">{l.text}</span>
        </div>
      ))}
      <div className="ob-log__row ob-log__row--cursor" ref={end}>
        <span className="ob-log__t">{lines.length ? lines[lines.length - 1].at : stamp()}</span>
        <span className="ob-log__cursor" aria-hidden="true" />
      </div>
    </div>
  );
}

function ScopePanel({ step }: { step: StepKey | 'welcome' }) {
  const scope = STEP_SCOPE[step];
  return (
    <Module id="—" title="这一步" en="SCOPE" right={STEP_EN[step]}>
      <div className="ob-scope">
        <div>
          <div className="ui-label">DOES<b>会做</b></div>
          <ul>{scope.does.map(t => <li key={t}>{t}</li>)}</ul>
        </div>
        <div>
          <div className="ui-label">DOES NOT<b>不会做</b></div>
          <ul>{scope.not.map(t => <li key={t}>{t}</li>)}</ul>
        </div>
      </div>
    </Module>
  );
}

function ErrorCatalogPanel({ code, step, stepNo }: { code: string | null; step: StepKey; stepNo: number }) {
  const entry = lookupError(code);
  const rows: Array<[string, string]> = [
    ['错误码', code || '（无）'],
    ['级别', entry ? ERROR_LEVEL_LABEL[entry.level] : '未收录'],
    ['步骤', `${String(stepNo).padStart(2, '0')} ${STEP_LABEL[step]}`],
  ];
  return (
    <Module id="—" title="错误码" en="CATALOG" right={entry ? 'KNOWN' : 'RAW'}>
      <ul className="ob-ck">
        {rows.map(([k, v]) => (
          <li key={k} className="ob-ck__row ob-ck__row--plain">
            <span className="ob-ck__k">{k}</span>
            <span className="ob-ck__v">{v}</span>
          </li>
        ))}
      </ul>
      <p className="ob-side-note">
        「复制诊断信息」会带上版本、平台和报错，已自动去掉用户名、wxid、密钥等，可以直接贴到 GitHub issue。
      </p>
    </Module>
  );
}

// ———————————————————————— screens ————————————————————————

function Welcome({ initError, initCode, mac, stepCount, onStart, onPickQQ }: {
  initError?: string | null; initCode: string | null; mac: boolean; stepCount: number;
  onStart: () => void; onPickQQ?: () => void;
}) {
  return (
    <>
      {initError && (
        <div className="ui-mb-4">
          <StepError code={initCode ?? 'STORE_INIT_FAILED'} raw={initError}
            title="上次解密的数据没能加载，所以又回到了引导" />
        </div>
      )}
      <Lead>
        Murmur 是一本关于你这些年聊天的<strong>本地</strong>纪念册 ——
        所有数据从微信读出，分析后只在你的电脑上呈现，不会上传到任何地方。
      </Lead>
      <div className="ob-ro3">
        <div>
          <div className="ui-label">STEPS<b>步骤</b></div>
          <div className="ob-ro3__v">{String(stepCount).padStart(2, '0')}</div>
        </div>
        <div>
          <div className="ui-label">TIME<b>大约需要</b></div>
          <div className="ob-ro3__v">2–5<small>分钟</small></div>
        </div>
        <div>
          <div className="ui-label">WHERE<b>在哪里完成</b></div>
          <div className="ob-ro3__v ob-ro3__v--zh">你的电脑上</div>
        </div>
      </div>
      <Ops grid className="ob-feats" items={[
        { t: '完全本地', d: '从读取密钥到分析，一切在你的电脑上完成。' },
        { t: '可选 AI 分析', d: '检测到本机的 Claude Code / Codex / Gemini / Kimi / OpenCode，可以让 AI 直接读你的关系档案。' },
        { t: '杂志风回顾', d: '不是冰冷的统计，是你和老朋友之间故事的体面整理。' },
      ]} />
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" onClick={onStart}>开始（微信）</Button>
        {onPickQQ && !mac && <Button variant="secondary" size="lg" onClick={onPickQQ}>切换到 QQ</Button>}
      </div>
    </>
  );
}

function DecryptStep({ canForce, onRun }: { canForce: boolean; onRun: (force: boolean) => void }) {
  // 「清空后重新解密」 deletes the decrypted folder first: ask once more.
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Lead>用已经保存的密钥，把微信数据库重新解密一遍，覆盖之前的解密结果。</Lead>
      {canForce && !confirming && (
        <Note tone="info" label="MALFORMED">
          如果之前报过「数据库损坏（malformed）」，用「清空后重新解密」：会先删掉旧的解密目录再解一次。
        </Note>
      )}
      {confirming && (
        <Note tone="danger" label="CONFIRM" title="确定先清空再重新解密？">
          会先<strong>删掉这个账号已经解密好的数据目录</strong>，再用保存的密钥从微信原始数据重新解一遍；微信本身的聊天记录不受影响。数据多的话要几分钟，期间 Murmur 里看不到数据。
        </Note>
      )}
      <div className="ob-actions ob-actions--row">
        {confirming ? (
          <>
            <Button variant="danger" size="lg" onClick={() => onRun(true)}>确定清空并重新解密</Button>
            <Button variant="ghost" size="lg" onClick={() => setConfirming(false)}>取消</Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="lg" onClick={() => onRun(false)}>重新解密</Button>
            {canForce && (
              <Button variant="secondary" size="lg" onClick={() => setConfirming(true)}>清空后重新解密…</Button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function DoneStep({ total, keyPath, onEnter }: { total: number; keyPath: string | null; onEnter: () => void }) {
  const n = String(total).padStart(2, '0');
  return (
    <>
      <div className="ob-done">
        <div className="ui-big ob-done__big">{n}<small>/ {n}</small></div>
        <div className="ob-done__meta">
          <div className="ui-label"><i className="ui-led" />STEPS<b>全部完成</b></div>
          <div className="ui-label">KEY<b>已保存在本机</b></div>
        </div>
      </div>
      <Note tone="success" label="READY" title="一切就绪 —— 你的关系档案已经就位">
        {keyPath
          ? <>密钥保存在 <code>{keyPath}</code>，下次启动直接读取，不用再重新抓。</>
          : <>密钥已经保存在本机的 <code>~/.murmur/</code> 目录里，下次启动直接读取，不用再重新抓。</>}
        想换账号或重新抓密钥，点上面对应的步骤即可。
      </Note>
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" onClick={onEnter}>进入年代记</Button>
      </div>
    </>
  );
}
