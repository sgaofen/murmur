/* 设置 (#/settings) — the instrument's parameter panel.
 *
 *   90 状态   a read-only overview; each line jumps to its module
 *   91 外观   92 隐私   93 应用锁 (components/AppLockSettings)
 *   94 数据与目录   95 本机 AI   96 关于
 *
 * Built only from ui/ primitives and tokens; layout in ./Settings.css
 * (prefix settings- / st-; the settings-row grid is shared with the app-lock
 * module). */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getAgents, getDiagnose, getInfo, getLogTail, listReports, openFolder } from '../data/api';
import type { Diagnose, InfoResponse, LocalAgent } from '../data/api';
import { APP_LOCK_STATUS_EVENT, getAppLockStatus } from '../data/appLock';
import type { AppLockStatus } from '../data/appLock';
import {
  Button, Callout, Module, SegmentedControl, Skeleton, ThemeSwitcher, buttonClass, copyText, cx, useTheme,
} from '../ui';
import { IconCheck, IconCopy, IconFolder } from '../ui/icons';
import { PageHeader } from '../shell/PageHeader';
import { AppLockSettings } from '../components/AppLockSettings';
import { DiagBundleButton } from '../components/DiagBundleButton';
import { maskText, setPrivacyMode } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { AGENT_CLI_LIST } from '../utils/agents';
import './Settings.css';

/** etcli ≥ 0.5 adds export_dir to /api/info; older backends simply omit it. */
type Info = InfoResponse & { export_dir?: string };

interface Loaded {
  info: Info | null;
  diag: Diagnose | null;
  logsDir: string | null;
  reportsDir: string | null;
  agents: LocalAgent[] | null;
}

function settled<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === 'fulfilled' ? r.value : null;
}

function useSettingsData(): { data: Loaded | null; offline: boolean } {
  const [data, setData] = useState<Loaded | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([getInfo(), getDiagnose(), getLogTail(20), listReports(), getAgents()])
      .then(([info, diag, logs, reports, agents]) => {
        if (cancelled) return;
        setData({
          info: settled(info),
          diag: settled(diag),
          logsDir: settled(logs)?.logs_dir ?? null,
          reportsDir: settled(reports)?.root ?? null,
          agents: settled(agents),
        });
      });
    return () => { cancelled = true; };
  }, []);
  const offline = !!data && !data.info && !data.diag;
  return { data, offline };
}

/** App-lock state for the overview (the lock module keeps its own copy). */
function useLockStatus(): AppLockStatus | null | 'offline' {
  const [s, setS] = useState<AppLockStatus | null | 'offline'>(null);
  useEffect(() => {
    let cancelled = false;
    getAppLockStatus()
      .then(v => { if (!cancelled) setS(v); })
      .catch(() => { if (!cancelled) setS('offline'); });
    const on = (e: Event) => setS((e as CustomEvent<AppLockStatus>).detail);
    window.addEventListener(APP_LOCK_STATUS_EVENT, on);
    return () => { cancelled = true; window.removeEventListener(APP_LOCK_STATUS_EVENT, on); };
  }, []);
  return s;
}

function requestOnboarding() {
  window.dispatchEvent(new CustomEvent('murmur:requestOnboarding', { detail: { platform: 'wechat' } }));
}

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function SettingsPage() {
  const { data, offline } = useSettingsData();
  const loading = data === null;
  return (
    <div className="st-page">
      <PageHeader title="设置" subtitle="外观、隐私、应用锁、数据目录、本机 AI" />
      <div className="st-rack ui-rack">
        <StatusModule data={data} loading={loading} />
        <div className="st-main">
          {offline && (
            <div className="st-banner">
              <Callout tone="warning" title="连不上本地服务">
                目录、本机 AI 和后端版本暂时读不到；外观和隐私设置不受影响。Murmur 刚启动时等几秒再打开这一页。
              </Callout>
            </div>
          )}
          <AppearanceSection />
          <PrivacySection />
          <AppLockSettings />
          <DataSection data={data} loading={loading} />
          <AgentsSection agents={data?.agents ?? null} loading={loading} />
          <AboutSection info={data?.info ?? null} diag={data?.diag ?? null} loading={loading} />
        </div>
      </div>
    </div>
  );
}

// ——— layout pieces ———

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__head">
        <div className="settings-row__label">{label}</div>
        {hint && <div className="settings-row__hint">{hint}</div>}
      </div>
      <div className="settings-row__body">{children}</div>
    </div>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return <p className="settings-lede">{children}</p>;
}

// ——— 90 状态 ———

function StatusModule({ data, loading }: { data: Loaded | null; loading: boolean }) {
  const { mode, resolved } = useTheme();
  const priv = usePrivacy();
  const lock = useLockStatus();
  const info = data?.info ?? null;
  const agents = data?.agents ?? null;
  const rows: { id: string; no: string; k: string; v: ReactNode; on?: boolean | null }[] = [
    {
      id: 'st-91', no: '91', k: 'THEME',
      v: mode === 'system' ? `跟随系统 · ${resolved === 'dark' ? '深' : '浅'}` : resolved === 'dark' ? '深色 · 石墨' : '浅色 · 铝',
    },
    { id: 'st-92', no: '92', k: 'PRIVACY', v: priv ? '隐私模式 开' : '隐私模式 关', on: priv },
    {
      id: 'st-93', no: '93', k: 'LOCK',
      v: lock === null ? '…' : lock === 'offline' ? '读不到' : lock.enabled ? '应用锁 开' : '应用锁 关',
      on: lock === null || lock === 'offline' ? null : lock.enabled,
    },
    {
      id: 'st-94', no: '94', k: 'DATA',
      v: loading ? '…' : !info ? '读不到' : info.data_dir ? '已解密' : '还没有解密数据',
      on: loading || !info ? null : !!info.data_dir,
    },
    {
      id: 'st-95', no: '95', k: 'AGENTS',
      v: loading ? '…' : agents === null ? '读不到' : agents.length ? `${agents.length} 个本机 AI` : '没检测到',
      on: loading || agents === null ? null : agents.length > 0,
    },
    {
      id: 'st-96', no: '96', k: 'BACKEND',
      v: loading ? '…' : info?.version ? `etcli ${info.version}` : '未连接',
      on: loading ? null : !!info,
    },
  ];
  return (
    <Module id="90" title="状态" en="STATUS" className="st-m90" bodyClassName="st-m90__body" as="aside">
      <ol className="st-ov">
        {rows.map(r => (
          <li key={r.id}>
            <button type="button" className="st-ov__row" onClick={() => jump(r.id)}>
              <span className="st-ov__no">{r.no}</span>
              <span className="st-ov__k">{r.k}</span>
              <span className="st-ov__v">
                {r.on !== undefined
                  ? <i className={cx('ui-led', r.on === false && 'is-off', r.on === null && 'is-off')} aria-hidden="true" />
                  : <i className="st-ov__sw" aria-hidden="true" />}
                {r.v}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="st-ov__foot">本页的设置只存在这台电脑上</div>
    </Module>
  );
}

// ——— 91 外观 ———

function AppearanceSection() {
  const { mode, resolved } = useTheme();
  return (
    <Module id="91" title="外观" en="APPEARANCE" className="st-mod">
      <span id="st-91" className="st-anchor" />
      <Lede>浅色、深色，或者跟着系统的深浅色自动切换。关系网的星图也跟着这里走。</Lede>
      <Row label="主题" hint={mode === 'system' ? `现在跟随系统：${resolved === 'dark' ? '深色' : '浅色'}` : undefined}>
        <ThemeSwitcher />
      </Row>
    </Module>
  );
}

// ——— 92 隐私 ———

function PrivacySection() {
  const on = usePrivacy();
  return (
    <Module id="92" title="隐私" en="PRIVACY" className="st-mod" right={<span className={cx('st-onoff', on && 'is-on')}>{on ? 'ON' : 'OFF'}</span>}>
      <span id="st-92" className="st-anchor" />
      <Lede>开启后，界面上的名字换成「朋友 AB」这样的代号，wxid、本机路径、手机号等也会打码，适合录屏或截图分享。导出的聊天记录文件仍是原文。</Lede>
      <Row label="隐私模式" hint="顶部状态条的 PRIV 也能一键切换">
        <SegmentedControl
          label="隐私模式"
          value={on ? 'on' : 'off'}
          onChange={(v) => setPrivacyMode(v === 'on')}
          options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '开启' }]}
        />
      </Row>
    </Module>
  );
}

// ——— 94 数据与目录 ———

function DataSection({ data, loading }: { data: Loaded | null; loading: boolean }) {
  void usePrivacy();  // re-mask paths when privacy flips
  const info = data?.info ?? null;
  const decrypted = info?.data_dir ?? null;
  return (
    <Module id="94" title="数据与目录" en="PATHS · LOCAL ONLY" className="st-mod">
      <span id="st-94" className="st-anchor" />
      <Lede>Murmur 只读写下面这些本机文件夹，不会把内容上传到任何地方。</Lede>
      <Row label="解密数据" hint="解密后的聊天数据库">
        {loading ? <PathSkeleton /> : decrypted ? <PathValue path={decrypted} /> : !info ? (
          <span className="settings-muted">读不到（后端未连接）</span>
        ) : (
          <div className="settings-empty">
            <span>还没有解密数据。</span>
            <Button size="sm" variant="secondary" onClick={requestOnboarding}>打开初始化引导</Button>
          </div>
        )}
      </Row>
      <Row label="导出目录" hint="AI 分析包和聊天导出">
        {loading ? <PathSkeleton /> : <PathValue path={info?.export_dir ?? null} />}
      </Row>
      <Row label="AI 报告" hint="本机 AI 写好的关系档案">
        {loading ? <PathSkeleton /> : <PathValue path={data?.reportsDir ?? null} />}
      </Row>
      <Row label="Murmur 目录" hint="配置、密钥缓存">
        {loading ? <PathSkeleton /> : <PathValue path={data?.diag?.murmur_home ?? null} />}
      </Row>
      <Row label="日志" hint="报问题时附上 serve.log">
        {loading ? <PathSkeleton /> : <PathValue path={data?.logsDir ?? null} />}
      </Row>
    </Module>
  );
}

function PathSkeleton() {
  return <Skeleton width="70%" height={28} />;
}

function PathValue({ path }: { path: string | null }) {
  const [copied, setCopied] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  if (!path) return <span className="settings-muted">读不到（后端没返回这一项）</span>;

  const copy = async () => {
    try {
      await copyText(path);  // the real path, even while the UI is masked
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const open = async () => {
    setOpenError(null);
    try {
      const r = await openFolder(path);
      if (!r.ok) setOpenError(r.error || '打不开这个文件夹');
    } catch (e: unknown) {
      setOpenError(e instanceof Error ? e.message : String(e));
    }
  };

  const shown = maskText(path);
  return (
    <div className="settings-path">
      <code className="settings-path__value" title={shown}>{shown}</code>
      <div className="settings-path__actions">
        <Button size="sm" variant="ghost" onClick={copy}
          icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}>
          {copied ? '已复制' : '复制'}
        </Button>
        <Button size="sm" variant="ghost" onClick={open} icon={<IconFolder size={14} />}>打开</Button>
      </div>
      {openError && <div className="settings-path__error">{maskText(openError)}</div>}
    </div>
  );
}

// ——— 95 本机 AI ———

function AgentsSection({ agents, loading }: { agents: LocalAgent[] | null; loading: boolean }) {
  void usePrivacy();
  return (
    <Module
      id="95" title="本机 AI" en="LOCAL AGENTS" className="st-mod"
      right={agents && agents.length > 0 ? `${String(agents.length).padStart(2, '0')} DETECTED` : undefined}
    >
      <span id="st-95" className="st-anchor" />
      <div className="settings-lede settings-lede--row">
        <p>Murmur 调用你电脑上已经装好的 AI 命令行工具来写关系档案。每次分析时再选用哪一个：「报告」页的批量分析，或朋友页的 AI 分析。</p>
        <a className={buttonClass({ variant: 'secondary', size: 'sm' })} href="#reports">去报告页</a>
      </div>
      {loading ? (
        <div className="st-pad ui-stack"><Skeleton height={30} /><Skeleton height={30} /></div>
      ) : agents === null ? (
        <div className="st-pad"><span className="settings-muted">读不到本机 AI 列表（后端没响应）。</span></div>
      ) : agents.length === 0 ? (
        <div className="st-pad">
          <Callout tone="info" title="没检测到本机 AI 命令行工具">
            Murmur 支持 {AGENT_CLI_LIST}。装好其中任意一个并登录，再重新打开 Murmur，例如 <code>npm install -g @anthropic-ai/claude-code</code>。
          </Callout>
        </div>
      ) : (
        <table className="settings-agents">
          <thead>
            <tr><th scope="col">#</th><th scope="col">名称</th><th scope="col">厂商</th><th scope="col">版本</th><th scope="col">路径</th></tr>
          </thead>
          <tbody>
            {agents.map((a, i) => (
              <tr key={a.cli}>
                <td className="settings-agent__no">{String(i + 1).padStart(2, '0')}</td>
                <td className="settings-agent__name"><i className="ui-led" aria-hidden="true" />{a.name}</td>
                <td className="settings-agent__vendor">{a.vendor}</td>
                <td className="settings-agent__version">{a.version || '—'}</td>
                <td className="settings-agent__path" title={maskText(a.path)}>{maskText(a.path)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Module>
  );
}

// ——— 96 关于 ———

function AboutSection({ info, diag, loading }: { info: Info | null; diag: Diagnose | null; loading: boolean }) {
  const platform = diag?.platform === 'macos' ? 'macOS' : diag?.platform === 'windows' ? 'Windows' : diag?.platform === 'linux' ? 'Linux' : null;
  return (
    <Module id="96" title="关于" en="ABOUT" className="st-mod st-m96" right={`v${__MURMUR_VERSION__}`}>
      <span id="st-96" className="st-anchor" />
      <div className="settings-about">
        <div className="settings-about__brand">
          <span className="settings-about__name">MURMUR<b>微语</b></span>
          <span className="settings-about__ver">v{__MURMUR_VERSION__}</span>
        </div>
        <p className="settings-about__lede">把多年的微信和 QQ 聊天在你电脑上做成关系网和关系档案。100% 本地分析，不上云。</p>
      </div>
      <dl className="settings-facts">
        <div><dt>界面版本</dt><dd>{__MURMUR_VERSION__}</dd></div>
        <div><dt>本地服务</dt><dd>{loading ? <Skeleton width={80} height={12} /> : info?.version ? `etcli ${info.version}` : '未连接'}</dd></div>
        {platform && <div><dt>系统</dt><dd>{platform}{diag?.wechat_version ? ` · 微信 ${diag.wechat_version}` : ''}</dd></div>}
        <div><dt>源代码 / 反馈</dt><dd><code>github.com/sgaofen/murmur</code></dd></div>
        <div className="settings-facts__wide"><dt>诊断信息</dt><dd><DiagBundleButton /></dd></div>
      </dl>
    </Module>
  );
}
