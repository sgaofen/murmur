// macOS live key capture (WeChat 4.1.9+, sgaofen/murmur#27).
//
// WeChat 4.1.9+ no longer keeps its SQLCipher keys in memory, so the memory
// scan in extract_key_mac.py often comes back with 0 keys. The backend can
// instead hook CommonCrypto inside WeChat with Frida (cli/hook_cc_key_frida.py)
// and catch each database key the moment WeChat uses it — which only happens
// while the user is actively using WeChat. This component walks the user
// through that: install Frida if needed, run a timed round with a countdown
// and a live matched-DB counter, offer another round, then hand off to the
// existing decrypt flow.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cancelLiveKey, getLiveKeyStatus, getPrivateCopyStatus, installFrida, startLiveKey } from '../data/api';
import type { LiveKeyStatus } from '../data/api';
import { Button, Callout, Card, Chip, SegmentedControl } from '../ui';
import { IconCheck, IconFolder, IconKey } from '../ui/icons';
import { PrivateCopyCapture } from './PrivateCopyCapture';
import { lookupError } from '../data/errorCatalog';
import { maskText } from '../utils/privacy';
import { InlineError } from '../onboarding/parts';
import { liveBusy, resumeMethod } from '../onboarding/capture';
import type { CaptureMethod } from '../onboarding/capture';

interface Props {
  /** Keys are saved — run the existing decrypt flow. */
  onDecrypt: () => void;
  /** Why we got here: the memory scan found nothing, or WeChat is 4.1.9+. */
  reason?: 'scan-empty' | 'version' | 'manual';
  wechatVersion?: string | null;
  /** Optional secondary action (e.g. back to paste-key). */
  onPaste?: () => void;
  /** From /api/diagnose `private_copy.available`: is the 免 Frida capture dylib
   * bundled? Shown on the method chooser; undefined = not known. */
  keycapAvailable?: boolean | null;
  /** WeChat still has hardened runtime: the Frida card says it needs a re-sign. */
  hardened?: boolean;
  /** Open this method directly instead of the chooser (e.g. 「先不重签：用免 Frida 方式」). */
  initialMethod?: CaptureMethod | null;
  /** Told whenever a Frida round, the Frida install or a private-copy round
   * starts / ends, so the dialog can lock its step rail and Esc. Pass a
   * stable function (e.g. a state setter). */
  onBusyChange?: (busy: boolean) => void;
}

const DURATIONS = [60, 90, 180];

// Core DBs Murmur needs to show anything at all; if these are still missing
// after a round the user should do another one rather than decrypt.
const CORE_DBS = ['session/session.db', 'contact/contact.db'];

const TODO: Array<[string, string]> = [
  ['最快：退出微信（⌘Q）再重新打开并登录', '登录时微信会重新派生全部密钥，通常一次就能全部抓到'],
  ['给任意好友或文件传输助手发一条消息', '解锁会话库和消息库'],
  ['点开几个这次登录后还没点开过的对话，往上翻一翻', '每个消息分库要单独触发'],
  ['打开「通讯录」，点进一两个联系人', '联系人库'],
  ['刷一下朋友圈', '朋友圈库'],
  ['打开收藏、表情面板，发一张图片', '收藏 / 表情 / 媒体库'],
];

export function LiveKeyCapture({
  onDecrypt, reason = 'manual', wechatVersion, onPaste, keycapAvailable, hardened, initialMethod, onBusyChange,
}: Props) {
  const [st, setSt] = useState<LiveKeyStatus | null>(null);
  const [seconds, setSeconds] = useState(90);
  const [err, setErr] = useState<string | null>(null);
  // Stable backend code for `err` (data/errorCatalog.ts); only shown while err is set.
  const [errCode, setErrCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Entry point: let the user pick the Frida flow (below) or the Frida-free
  // "private copy" flow (PrivateCopyCapture). null = chooser not answered yet.
  const [method, setMethod] = useState<CaptureMethod | null>(initialMethod ?? null);
  // First status read done (decides whether a running job skips the chooser).
  const [probed, setProbed] = useState(false);
  const [pcBusy, setPcBusy] = useState(false);
  const pollRef = useRef<number | null>(null);
  const startingRef = useRef(false);

  const refresh = useCallback(async (coverage = false) => {
    try {
      const s = await getLiveKeyStatus({ coverage });
      setSt(prev => (coverage || !prev?.coverage ? s : { ...s, coverage: prev.coverage }));
      setErr(null);  // a transient network error shouldn't stick once polling recovers
      return s;
    } catch (e: any) {
      setErr(e?.message || String(e));
      return null;
    }
  }, []);

  // A round (or the Frida install) may still be running from before — the
  // backend keeps going when the screen changes. Open that method directly
  // instead of asking 「选一种方式」 again.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [live, pc] = await Promise.all([refresh(true), getPrivateCopyStatus().catch(() => null)]);
      if (cancelled) return;
      const resume = resumeMethod(live, pc);
      if (resume) setMethod(resume);
      setProbed(true);
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  const running = !!st?.job.running;
  const installing = !!st?.install.running;
  const anyBusy = liveBusy(st) || busy || (method === 'private-copy' && pcBusy);

  useEffect(() => { onBusyChange?.(anyBusy); }, [anyBusy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // Poll while a round or the Frida install is in flight; re-read coverage
  // once it finishes so the totals include this round.
  useEffect(() => {
    if (!running && !installing) return;
    pollRef.current = window.setInterval(async () => {
      const s = await refresh(false);
      if (s && !s.job.running && !s.install.running) void refresh(true);
    }, 1000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [running, installing, refresh]);

  async function start() {
    if (startingRef.current) return;  // double click: one start request only
    startingRef.current = true;
    setErr(null);
    setBusy(true);
    try {
      const r = await startLiveKey(seconds);
      if (!r.ok) {
        setErr(r.error === 'frida-missing' ? '还没装 Frida，先点上面的安装按钮。' : (r.error || '启动失败'));
        setErrCode(r.code ?? null);
      }
      await refresh(!!r.complete);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  }

  async function install() {
    if (installing) return;
    setErr(null);
    try {
      const r = await installFrida();
      if (!r.ok) { setErr(r.error || '安装失败'); setErrCode(r.code ?? null); }
      await refresh(false);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  if (method === 'private-copy') {
    return <PrivateCopyCapture onDecrypt={onDecrypt} onBack={() => setMethod(null)} onBusyChange={setPcBusy} />;
  }
  if (method === null) {
    if (!probed) return <div className="ob-working__sub" role="status">正在检查实时抓取环境…</div>;
    return <MethodChooser reason={reason} wechatVersion={wechatVersion} frida={st?.frida}
      keycapAvailable={keycapAvailable} hardened={hardened} onPick={setMethod} onPaste={onPaste} />;
  }

  if (!st) {
    return <div className="ob-working__sub" role="status">正在检查实时抓取环境…</div>;
  }

  const job = st.job;
  const cov = st.coverage;
  const total = job.round > 0 ? job.total : (cov?.total ?? 0);
  const matched = job.round > 0 && job.running ? job.matched_count : (cov?.known ?? job.matched_count);
  const pending = cov?.pending ?? [];
  const missingCore = CORE_DBS.filter(db => pending.includes(db));
  const finished = !job.running && job.round > 0;

  return (
    <>
      <Intro reason={reason} wechatVersion={wechatVersion} />

      {!st.frida.installed && (
        <FridaMissing status={st} onInstall={install} />
      )}

      {st.frida.installed && !job.running && (
        <div className="ui-stack ui-stack--md">
          {finished && job.phase === 'done' && (
            <RoundSummary newCount={job.new.length} matched={matched} total={total}
              missingCore={missingCore} round={job.round} />
          )}
          {job.phase === 'error' && <JobError error={job.error} code={job.code} log={job.log} />}
          {!finished && total > 0 && (
            <div className="et-meta">
              已有 <strong>{matched}</strong> / {total} 个数据库的密钥{matched > 0 ? '（之前抓到的会保留）' : ''}
            </div>
          )}
          <TodoList />
          <div className="ui-row">
            <span className="et-meta">每轮抓取时长：</span>
            <SegmentedControl label="每轮抓取时长" size="sm" value={String(seconds)}
              onChange={v => setSeconds(Number(v))}
              options={DURATIONS.map(d => ({ value: String(d), label: `${d} 秒` }))} />
          </div>
          <Callout tone="warning" compact>
            点开始后多半会弹 macOS 密码窗口（挂钩微信需要管理员权限），输完开机密码倒计时才开始。倒计时期间<strong>切到微信去操作</strong>，Murmur 这边不用看着。<br/>
            风控提示：挂钩微信进程有被腾讯检测到的可能。Murmur 只处理本机、你本人的数据，不上传任何内容。
          </Callout>
          <div className="ui-stack">
            {finished && matched > 0 ? (
              <>
                <Button variant="primary" size="lg" block onClick={onDecrypt}>
                  {matched >= total ? '全部抓到了 → 开始解密' : `用已抓到的 ${matched} 个开始解密`}
                </Button>
                <Button variant="secondary" size="lg" block onClick={start} loading={busy}>
                  {busy ? '启动中…' : '再抓一轮（补齐剩下的）'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="primary" size="lg" block onClick={start} loading={busy}>
                  {busy ? '启动中…' : finished ? '再抓一轮' : '开始实时抓取'}
                </Button>
                {!finished && matched > 0 && (
                  <Button variant="secondary" size="lg" block onClick={onDecrypt}>已经够了，直接用现有的 {matched} 个解密</Button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {job.running && (
        <Running status={st} matched={matched} total={total} onStop={() => {
          cancelLiveKey()
            .then(() => refresh(false))
            .catch((e: any) => setErr(e?.message || String(e)));
        }} />
      )}

      {err && <InlineError code={errCode} raw={err} className="ui-mt-3" />}

      {onPaste && !anyBusy && (
        <Button variant="ghost" block className="ui-mt-2" onClick={onPaste}>或者：手动粘贴密钥</Button>
      )}
    </>
  );
}

function MethodChooser({ reason, wechatVersion, frida, keycapAvailable, hardened, onPick, onPaste }: {
  reason: Props['reason']; wechatVersion?: string | null;
  frida?: LiveKeyStatus['frida']; keycapAvailable?: boolean | null; hardened?: boolean;
  onPick: (m: CaptureMethod) => void; onPaste?: () => void;
}) {
  const card = (m: CaptureMethod, icon: ReactNode, title: ReactNode, desc: string, chips: ReactNode) => (
    <Card variant="sunken" padding="sm" interactive role="button" tabIndex={0}
      onClick={() => onPick(m)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(m); } }}>
      <div className="ob-option">
        <span className="ob-option__icon">{icon}</span>
        <div className="ob-option__body">
          <div className="ob-option__title">{title}</div>
          <div className="ob-option__desc">{desc}</div>
          {chips && <div className="ob-option__chips">{chips}</div>}
        </div>
      </div>
    </Card>
  );
  return (
    <>
      <Intro reason={reason} wechatVersion={wechatVersion} />
      <div className="ob-section-title">选一种抓取方式：</div>
      <div className="ob-options">
        {card('frida', <IconKey size={16} />, 'Frida 实时抓取',
          '挂钩正在运行的微信。需要装一次 Frida，并会弹一次系统密码窗（管理员权限）。不改动微信本体，但微信要先重签名。',
          <>
            {hardened && <Chip size="sm" tone="warning">微信需要先重签名</Chip>}
            {frida && (frida.installed
              ? <Chip size="sm" tone="success" icon={<IconCheck size={11} />}>Frida 已安装</Chip>
              : <Chip size="sm" tone="warning">{frida.installable ? '需要先装 Frida（约 45 MB）' : '这个版本没带 Frida'}</Chip>)}
            <Chip size="sm">要管理员密码</Chip>
          </>)}
        {card('private-copy', <IconFolder size={16} />,
          <>免 Frida 方式 <Chip size="sm" tone="accent">不用装 Frida · 不用管理员密码</Chip></>,
          '把微信复制一份到 Murmur 自己的目录、重签名后打开这份副本来抓。不动 /Applications/WeChat.app；开始前要先完全退出原版微信。',
          keycapAvailable == null ? null : keycapAvailable
            ? <Chip size="sm" tone="success" icon={<IconCheck size={11} />}>捕获组件已就绪</Chip>
            : <Chip size="sm" tone="warning">这个版本没带捕获组件</Chip>)}
      </div>
      {onPaste && (
        <Button variant="ghost" block className="ui-mt-3" onClick={onPaste}>或者：手动粘贴密钥</Button>
      )}
    </>
  );
}

function Intro({ reason, wechatVersion }: { reason: Props['reason']; wechatVersion?: string | null }) {
  return (
    <p className="ob-lead">
      {reason === 'scan-empty' && <>内存扫描这次一个密钥都没找到 —— 微信 4.1.9 之后很常见，不是你操作的问题。<br/></>}
      {reason === 'version' && wechatVersion && <>检测到你的微信是 <strong>{wechatVersion}</strong>，这个版本密钥不再常驻内存。<br/></>}
      换个办法：我在微信<strong>用到</strong>密钥的那一刻把它截下来。所以抓取期间需要你<strong>主动去用微信</strong>，光放着是抓不到的。
    </p>
  );
}

function TodoList() {
  return (
    <Card variant="sunken" padding="sm">
      <div className="ob-section-title">倒计时开始后，去微信里做这些：</div>
      <ol className="ob-list">
        {TODO.map(([what, why]) => (
          <li key={what}>{what}<span className="ob-list__why">· {why}</span></li>
        ))}
      </ol>
    </Card>
  );
}

function Running({ status, matched, total, onStop }: {
  status: LiveKeyStatus; matched: number; total: number; onStop: () => void;
}) {
  const job = status.job;
  const pct = total > 0 ? Math.round((matched / total) * 100) : 0;
  const head =
    job.phase === 'auth' ? '请在系统弹窗里输入开机密码…' :
    job.phase === 'capturing' ? '正在抓取 —— 现在去微信里操作' :
    job.phase === 'waiting-wechat' ? '微信已退出 —— 重新打开并登录，我会自动接上' :
    '正在挂钩微信…';
  return (
    <div style={{ padding: '8px 0 4px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div className="et-h3">{head}</div>
        {(job.phase === 'capturing' || job.phase === 'waiting-wechat') && job.remaining != null && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 600, color: 'var(--accent)' }}>
            {job.remaining}s
          </div>
        )}
      </div>
      <div style={{ margin: '12px 0 6px', height: 8, borderRadius: 4, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .4s' }} />
      </div>
      <div className="et-meta" style={{ marginBottom: 10 }}>
        已匹配 <strong>{matched}</strong> / {total} 个数据库
        {job.new.length > 0 && <>（这轮新增 {job.new.length} 个）</>}
        {job.phase === 'capturing' && <> · 已截获 {job.hits} 次加解密调用</>}
      </div>
      {job.passphrase_found && (
        <div className="et-meta" style={{ marginBottom: 10, color: 'var(--success-fg)' }}>
          ✓ 已截获账号口令，其余数据库的密钥直接推算出来了
        </div>
      )}
      {job.new.length > 0 && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--success-fg)', lineHeight: 1.6, marginBottom: 10 }}>
          {job.new.slice(-6).map(n => <div key={n}>✓ {n}</div>)}
        </div>
      )}
      {(job.phase === 'capturing' || job.phase === 'waiting-wechat') && <TodoList />}
      <Button variant="secondary" size="lg" block className="ui-mt-3" onClick={onStop}>提前结束这一轮</Button>
    </div>
  );
}

function RoundSummary({ newCount, matched, total, missingCore, round }: {
  newCount: number; matched: number; total: number; missingCore: string[]; round: number;
}) {
  const all = total > 0 && matched >= total;
  return (
    <Callout tone={all ? 'success' : newCount > 0 ? 'warning' : 'danger'}
      title={`第 ${round} 轮结束：新抓到 ${newCount} 个，累计 ${matched} / ${total}`}>
      {all && <div>全部数据库的密钥都到手了。</div>}
      {!all && newCount === 0 && (
        <div>这一轮什么都没截到。确认倒计时期间你在微信里发了消息、点开了新对话；如果弹密码窗时点了取消，也会这样。</div>
      )}
      {!all && missingCore.length > 0 && (
        <div>关键库 <code>{missingCore.join('、')}</code> 还没抓到，建议再抓一轮：发条消息、打开通讯录。</div>
      )}
      {!all && newCount > 0 && missingCore.length === 0 && (
        <div>剩下的多半是你这次没碰到的功能（某些聊天分库、收藏、表情）。可以直接解密，缺的以后再补一轮。</div>
      )}
    </Callout>
  );
}

function JobError({ error, code, log }: { error: string | null; code?: string | null; log: string }) {
  const known = lookupError(code) !== null;
  const msg =
    error === 'frida-missing' ? '找不到 Frida（后端进程里 import 失败）。' :
    error === 'attach-denied' ? '没能挂到微信进程上：请先在引导里做「重签名」，并确认微信是重签名之后重新打开的。' :
    error === 'auth-cancelled' ? '系统密码窗口被取消了。再点一次开始，输入开机密码即可。' :
    error === 'wechat-not-running' ? '微信没在运行，请先打开并登录微信。' :
    error === 'no-dbs' ? '没找到微信的加密数据库，请确认微信已经登录并完成首次同步。' :
    `抓取失败：${error || '未知错误'}`;
  // Known code → catalog explanation; otherwise the hand-mapped tag text.
  return (
    <div>
      <InlineError code={code} raw={known ? null : msg} />
      {log && (
        <details className="ob-more">
          <summary>查看日志</summary>
          <div className="ob-well">{maskText(log.slice(-1500))}</div>
        </details>
      )}
    </div>
  );
}

function FridaMissing({ status, onInstall }: { status: LiveKeyStatus; onInstall: () => void }) {
  const inst = status.install;
  if (status.frida.installable) {
    return (
      <Card variant="sunken" padding="sm" className="ui-mb-3">
        <div className="ob-section-title">需要先装一个组件：Frida</div>
        <div className="et-meta">实时抓取靠 Frida 挂钩微信的加密调用，只装一次（下载约 45 MB，装在当前 Python 的用户目录）。</div>
        {inst.ok === false && (
          <Callout tone="danger" compact className="ui-mt-2" title="安装失败">
            <details open>
              <summary>查看输出</summary>
              <pre>{inst.log.slice(-1200)}</pre>
            </details>
            <div>也可以在终端手动装：<code>python3 -m pip install --user "frida&gt;=17"</code>，装完回来刷新。</div>
          </Callout>
        )}
        <Button variant="primary" size="lg" block className="ui-mt-3" onClick={onInstall} loading={inst.running}>
          {inst.running ? '正在安装 Frida…（一般 1 分钟内）' : inst.ok === false ? '重试安装' : '一键安装 Frida'}
        </Button>
      </Card>
    );
  }
  return (
    <Card variant="sunken" padding="sm" className="ui-mb-3">
      <div className="ob-section-title">这个版本的 App 没带上 Frida，先用终端抓一次</div>
      <div className="et-meta" style={{ marginBottom: 6 }}>下载源码后在仓库目录里运行（抓的时候按下面的清单去用微信）：</div>
      <pre style={{ background: 'var(--surface-card)', color: 'var(--text-secondary)', padding: '8px 10px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', margin: 0 }}>
{`python3.12 -m pip install -r requirements-mac-keyextract.txt
python3.12 cli/hook_cc_key_frida.py --seconds 90`}
      </pre>
      <div className="et-meta" style={{ marginTop: 6 }}>如果提示 attach / permission 失败，在第二条命令前面加 <code>sudo</code>。一轮抓不全就多跑几次，已经抓到的会保留。</div>
      <div className="et-meta" style={{ marginTop: 6 }}>抓到的密钥会存到 <code>~/.murmur/decrypted_keys.json</code>，回到 Murmur 重新检测即可解密。</div>
    </Card>
  );
}
