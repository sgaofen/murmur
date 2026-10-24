// WeChat onboarding (UI-4). A step rail on the left —
//   环境自检 → 数据目录 → 授权/重签 (Mac) → 取得密钥 → 解密 → 完成
// — and one screen per step on the right. Any finished step can be clicked
// to redo just that step. Where a fresh diagnose lands is still the old
// decision tree (onboarding/flow.ts: routeAfterCheck); every failure renders
// through the error catalog (onboarding/parts.tsx: StepError).
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { extractKey, getDiagnose, getInfo, openFullDiskAccess, refreshData, resignWechat, saveKey } from '../data/api';
import type { Diagnose } from '../data/api';
import { usePrivacy } from '../utils/usePrivacy';
import { LiveKeyCapture } from '../components/LiveKeyCapture';
import { Button, Callout, Dialog } from '../ui';
import { IconReport, IconSparkle } from '../ui/icons';
import { IconLock } from '../onboarding/icons';
import {
  BUSY_VIEWS, buildChecks, blockingCount, liveRecommended, routeAfterCheck, stepsFor, STEP_LABEL, VIEW_STEP,
} from '../onboarding/flow';
import type { Platform, Route, StepKey, View } from '../onboarding/flow';
import { describeError, InlineError, Lead, logTail, StepError, StepRail, Working } from '../onboarding/parts';
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

const HOOK_INSTALL_FAILED = /hook (setup|install) failed|wx_key\.dll|注入到微信进程/i;

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
  const layoutRef = useRef<HTMLDivElement>(null);

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
  }, [open]);

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

  // New screen → start at the top of the scrolling dialog body.
  useEffect(() => {
    layoutRef.current?.closest('.ui-dialog__body')?.scrollTo({ top: 0 });
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
  function redo(step: StepKey) {
    const d = diagRef.current;
    if (step === 'check' || !d) { void runCheck(); return; }
    if (step === 'data') show(d.platform === 'macos' && d.capabilities.tcc_blocked ? 'fda' : 'data');
    else if (step === 'auth') show('auth');
    else if (step === 'key') show('key');
    else if (step === 'decrypt') show('decrypt');
    else show('done');
  }

  function retry(f: Failure) {
    if (f.step === 'decrypt') { void runDecrypt({ force: lastForce }); return; }
    if (f.retryView) { show(f.retryView); return; }
    redo(f.step);
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
        let code = r.code ?? 'KEY_NOT_FOUND';
        if (win && code !== 'WIN_HOOK_FAILED' && HOOK_INSTALL_FAILED.test(r.log || '')) code = 'WIN_HOOK_FAILED';
        failAt('key', { code, raw: logTail(r.log) });
        return;
      }
      // Windows returns the master key; Mac writes ~/.murmur/decrypted_keys.json itself.
      if (r.key) await saveKey(r.key);
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

  function openLive() {
    setLiveReason(liveRecommended(diagRef.current) ? 'version' : 'manual');
    advance('live');
  }

  function openFda() {
    openFullDiskAccess().catch(e => console.warn('open-fda failed', e));
  }

  // ———————— render ————————

  const busy = checking || (screen !== 'welcome' && screen !== 'error' && BUSY_VIEWS.has(screen));
  const current: StepKey | null = screen === 'welcome' ? null : screen === 'error' ? (fail?.step ?? 'check') : VIEW_STEP[screen];
  const stepNo = current ? steps.indexOf(current) + 1 : 0;
  const mac = platform === 'macos';

  const notes: Partial<Record<StepKey, string>> = {};
  if (diag) {
    const rows = buildChecks(diag);
    const blocking = blockingCount(rows);
    const warns = rows.filter(r => r.status === 'warn').length;
    notes.check = blocking > 0 ? `${blocking} 项需要处理` : warns > 0 ? `${warns} 项留意一下` : '环境没问题';
    if (diag.profiles.length) notes.data = `找到 ${diag.profiles.length} 个账号`;
    if (mac && diag.capabilities.wechat_hardened === false) notes.auth = '已重签';
    else if (mac && diag.capabilities.wechat_hardened) notes.auth = diag.saved_key ? '已有密钥，不用重签' : '需要重签';
    if (diag.saved_key) notes.key = '已保存';
    else if (liveRecommended(diag)) notes.key = '推荐实时抓取';
  }

  let title: string;
  let body: ReactNode;
  switch (screen) {
    case 'welcome':
      title = '回顾你的微信故事';
      body = (
        <Welcome initError={initError} initCode={initCode} onPickQQ={onPickQQ} mac={guessPlatform() === 'macos'}
          onStart={() => { setDone(new Set()); void runCheck(); }} />
      );
      break;
    case 'check':
      title = '先检查一下环境';
      body = (
        <SelfCheck diag={diag} checking={checking} route={diag ? routeAfterCheck(diag) : null}
          onContinue={() => { if (diag) follow(routeAfterCheck(diag)); }}
          onRecheck={() => void runCheck()}
          onGotoData={() => advance(diag?.platform === 'macos' && diag.capabilities.tcc_blocked ? 'fda' : 'data')}
          onGotoAuth={() => advance('auth')} />
      );
      break;
    case 'fda':
      title = '给 Murmur 完全磁盘访问权限';
      body = (
        <>
          {fdaStillBlocked && <InlineError code="TCC_BLOCKED" className="ui-mb-4" />}
          <FdaStep onOpenSettings={openFda} onRetry={() => void recheckAndFollow('data')} retrying={checking} />
        </>
      );
      break;
    case 'data':
      title = diag?.profiles.length ? '找到你的微信数据' : mac ? 'Mac 上还没找到微信数据' : '没找到微信数据目录';
      body = diag && (
        <DataStep diag={diag} onSaved={() => recheckAndFollow('data')}
          onNext={() => follow(routeAfterCheck(diag))}
          onRecheck={() => void recheckAndFollow('data')} onOpenFda={openFda} />
      );
      break;
    case 'auth':
      title = diag?.capabilities.wechat_hardened === false ? '微信已经重签过了' : '一次性给微信重签名（不用关 SIP）';
      body = diag && (
        <AuthStep diag={diag} onResign={() => void startResign()} onNext={() => advance('key')}
          onPaste={() => advance('paste')} onLive={openLive} onOpenFda={openFda} />
      );
      break;
    case 'resigning':
      title = '正在重签名…';
      body = <Working title={progress || '正在重签名…'} sub="系统弹出密码窗口时，输入这台电脑的开机密码。" />;
      break;
    case 'wait-login':
      title = '微信已重启：先登录，再回来抓密钥';
      body = <MacWaitLogin diag={diag} onScan={() => void startKeyExtract()} onLive={openLive} />;
      break;
    case 'key':
      title = mac ? (liveRecommended(diag) ? '取得解密密钥' : '一切就绪 —— 一键抓密钥') : '只需要 30 秒，读取一次密钥';
      body = diag && (mac ? (
        <MacKeyStep diag={diag} onScan={() => void startKeyExtract()} onLive={openLive}
          onPaste={() => show('paste')} onResign={() => show('auth')} />
      ) : (
        <WinKeyStep diag={diag} onStart={() => void startKeyExtract()} rechecking={checking}
          onRecheck={async () => {
            setChecking(true);
            try { setDiag(await getDiagnose()); } catch { /* keep the card */ } finally { setChecking(false); }
          }} />
      ));
      break;
    case 'live':
      title = '实时抓取密钥（微信 4.1.9+）';
      body = (
        <LiveKeyCapture reason={liveReason} wechatVersion={diag?.wechat_version}
          keycapAvailable={diag?.private_copy?.available}
          onDecrypt={() => void runDecrypt()} onPaste={() => show('paste')} />
      );
      break;
    case 'paste':
      title = '手动粘贴密钥';
      body = diag && <MacPasteKey diag={diag} onSubmit={k => void submitMacKey(k)} onLive={openLive} />;
      break;
    case 'extracting':
      title = '正在读取密钥…';
      body = <Working title={progress} sub="过程中如果看到微信弹窗，记得点「登录」。" />;
      break;
    case 'decrypt':
      title = '重新解密';
      body = <DecryptStep onRun={force => void runDecrypt({ force })} />;
      break;
    case 'decrypting':
      title = '正在解密最新数据…';
      body = <Working title={progress || '正在解密所有微信数据库…'} sub="数据多的话要几分钟，请不要关闭 Murmur。" />;
      break;
    case 'done':
      title = '一切就绪';
      body = <DoneStep mac={mac} onEnter={() => { onClose(); onDone?.(); }} />;
      break;
    case 'error':
    default:
      title = `卡在「${STEP_LABEL[fail?.step ?? 'check']}」这一步`;
      body = fail && (
        <StepError code={fail.code} raw={fail.raw} log={fail.log}
          onRetry={() => retry(fail)}
          actions={fail.step !== 'check' ? (
            <Button variant="ghost" onClick={() => void runCheck()}>重新检测环境</Button>
          ) : undefined} />
      );
      break;
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      accent
      closeOnScrim={false}
      closeLabel="跳过引导（不推荐）"
      className="ob-dialog"
      eyebrow={current ? `微信初始化 · 第 ${stepNo} 步，共 ${steps.length} 步` : '欢迎来到 Murmur'}
      title={title}
    >
      <div className="ob-layout" ref={layoutRef}>
        <StepRail steps={steps} current={current} done={done} error={screen === 'error'}
          notes={notes} onStepClick={busy ? undefined : redo} />
        <div className="ob-main" key={screen}>{body}</div>
      </div>
    </Dialog>
  );
}

function Welcome({ initError, initCode, mac, onStart, onPickQQ }: {
  initError?: string | null; initCode: string | null; mac: boolean;
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
      <ul className="ob-features">
        <li className="ob-feature">
          <span className="ob-feature__icon"><IconLock size={17} /></span>
          <div>
            <div className="ob-feature__title">完全本地</div>
            <div className="ob-feature__body">从读取密钥到分析，一切在你的电脑上完成。</div>
          </div>
        </li>
        <li className="ob-feature">
          <span className="ob-feature__icon"><IconSparkle size={17} /></span>
          <div>
            <div className="ob-feature__title">可选 AI 分析</div>
            <div className="ob-feature__body">检测到本机的 Claude Code / Codex / Gemini / Kimi / OpenCode，可以让 AI 直接读你的关系档案。</div>
          </div>
        </li>
        <li className="ob-feature">
          <span className="ob-feature__icon"><IconReport size={17} /></span>
          <div>
            <div className="ob-feature__title">杂志风回顾</div>
            <div className="ob-feature__body">不是冰冷的统计，是你和老朋友之间故事的体面整理。</div>
          </div>
        </li>
      </ul>
      <div className="ob-actions">
        <Button variant="primary" size="lg" block onClick={onStart}>开始（微信）</Button>
        {onPickQQ && !mac && <Button variant="secondary" size="lg" block onClick={onPickQQ}>切换到 QQ</Button>}
      </div>
    </>
  );
}

function DecryptStep({ onRun }: { onRun: (force: boolean) => void }) {
  return (
    <>
      <Lead>用已经保存的密钥，把微信数据库重新解密一遍，覆盖之前的解密结果。</Lead>
      <Callout tone="info" compact>
        如果之前报过「数据库损坏（malformed）」，用「清空后重新解密」：会先删掉旧的解密目录再解一次。
      </Callout>
      <div className="ob-actions">
        <Button variant="primary" size="lg" block onClick={() => onRun(false)}>重新解密</Button>
        <Button variant="secondary" size="lg" block onClick={() => onRun(true)}>清空后重新解密</Button>
      </div>
    </>
  );
}

function DoneStep({ mac, onEnter }: { mac: boolean; onEnter: () => void }) {
  return (
    <>
      <Callout tone="success" title="一切就绪 —— 你的关系档案已经就位">
        密钥保存在 <code>{mac ? '~/.murmur/decrypted_keys.json' : '~/.murmur/config.json'}</code>，下次启动直接读取，不用再重新抓。想换账号或重新抓密钥，点左边对应的步骤即可。
      </Callout>
      <div className="ob-actions">
        <Button variant="primary" size="lg" block onClick={onEnter}>进入年代记</Button>
      </div>
    </>
  );
}
