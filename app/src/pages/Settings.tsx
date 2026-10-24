/* 设置 (#/settings) — appearance, privacy, data folders, local AI, about.
 * Built only from ui/ primitives and tokens; layout in ./Settings.css. */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getAgents, getDiagnose, getInfo, getLogTail, listReports, openFolder } from '../data/api';
import type { Diagnose, InfoResponse, LocalAgent } from '../data/api';
import {
  Button, Callout, Card, CardHeader, Chip, SegmentedControl, Skeleton, ThemeSwitcher, buttonClass, copyText, useTheme,
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

function requestOnboarding() {
  window.dispatchEvent(new CustomEvent('murmur:requestOnboarding', { detail: { platform: 'wechat' } }));
}

export function SettingsPage() {
  const { data, offline } = useSettingsData();
  const loading = data === null;
  return (
    <div className="settings">
      <PageHeader title="设置" subtitle="外观、隐私、应用锁、数据目录、本机 AI" />
      {offline && (
        <Callout tone="warning" title="连不上本地服务">
          目录、本机 AI 和后端版本暂时读不到；外观和隐私设置不受影响。Murmur 刚启动时等几秒再打开这一页。
        </Callout>
      )}
      <AppearanceSection />
      <PrivacySection />
      <AppLockSettings />
      <DataSection data={data} loading={loading} />
      <AgentsSection agents={data?.agents ?? null} loading={loading} />
      <AboutSection info={data?.info ?? null} diag={data?.diag ?? null} loading={loading} />
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

// ——— 外观 ———

function AppearanceSection() {
  const { mode, resolved } = useTheme();
  return (
    <Card padding="lg">
      <CardHeader title="外观" description="浅色、深色，或者跟着系统的深浅色自动切换。关系网的星图也跟着这里走。" />
      <Row label="主题" hint={mode === 'system' ? `现在跟随系统：${resolved === 'dark' ? '深色' : '浅色'}` : undefined}>
        <ThemeSwitcher />
      </Row>
    </Card>
  );
}

// ——— 隐私 ———

function PrivacySection() {
  const on = usePrivacy();
  return (
    <Card padding="lg">
      <CardHeader
        title="隐私"
        description="开启后，界面上的名字换成「朋友 AB」这样的代号，wxid、本机路径、手机号等也会打码，适合录屏或截图分享。导出的聊天记录文件仍是原文。"
      />
      <Row label="隐私模式" hint="顶部状态条的 PRIV 也能一键切换">
        <SegmentedControl
          label="隐私模式"
          value={on ? 'on' : 'off'}
          onChange={(v) => setPrivacyMode(v === 'on')}
          options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '开启' }]}
        />
      </Row>
    </Card>
  );
}

// ——— 数据与目录 ———

function DataSection({ data, loading }: { data: Loaded | null; loading: boolean }) {
  void usePrivacy();  // re-mask paths when privacy flips
  const info = data?.info ?? null;
  const decrypted = info?.data_dir ?? null;
  return (
    <Card padding="lg">
      <CardHeader title="数据与目录" description="Murmur 只读写下面这些本机文件夹，不会把内容上传到任何地方。" />
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
    </Card>
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
    } catch (e: any) {
      setOpenError(e?.message || String(e));
    }
  };

  return (
    <div className="settings-path">
      <code className="settings-path__value">{maskText(path)}</code>
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

// ——— 本机 AI ———

function AgentsSection({ agents, loading }: { agents: LocalAgent[] | null; loading: boolean }) {
  void usePrivacy();
  return (
    <Card padding="lg">
      <CardHeader
        title="本机 AI"
        description="Murmur 调用你电脑上已经装好的 AI 命令行工具来写关系档案。每次分析时再选用哪一个：「报告」页的批量分析，或朋友页的 AI 分析。"
        actions={<a className={buttonClass({ variant: 'secondary', size: 'sm' })} href="#reports">去报告页</a>}
      />
      {loading ? (
        <div className="ui-stack"><Skeleton height={44} /><Skeleton height={44} /></div>
      ) : agents === null ? (
        <span className="settings-muted">读不到本机 AI 列表（后端没响应）。</span>
      ) : agents.length === 0 ? (
        <Callout tone="info" title="没检测到本机 AI 命令行工具">
          Murmur 支持 {AGENT_CLI_LIST}。装好其中任意一个并登录，再重新打开 Murmur，例如 <code>npm install -g @anthropic-ai/claude-code</code>。
        </Callout>
      ) : (
        <ul className="settings-agents">
          {agents.map(a => (
            <li key={a.cli} className="settings-agent">
              <div className="settings-agent__main">
                <span className="settings-agent__name">{a.name}</span>
                <Chip size="sm">{a.vendor}</Chip>
                {a.version && <span className="settings-agent__version">{a.version}</span>}
              </div>
              <code className="settings-agent__path">{maskText(a.path)}</code>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ——— 关于 ———

function AboutSection({ info, diag, loading }: { info: Info | null; diag: Diagnose | null; loading: boolean }) {
  const platform = diag?.platform === 'macos' ? 'macOS' : diag?.platform === 'windows' ? 'Windows' : diag?.platform === 'linux' ? 'Linux' : null;
  return (
    <Card padding="lg">
      <CardHeader title="关于" />
      <div className="settings-about">
        <div className="settings-about__brand">
          <span className="settings-about__name">Murmur 微语</span>
          <Chip size="sm" tone="accent">v{__MURMUR_VERSION__}</Chip>
        </div>
        <p className="settings-about__lede">把多年的微信和 QQ 聊天在你电脑上做成关系网和关系档案。100% 本地分析，不上云。</p>
        <dl className="settings-facts">
          <dt>界面版本</dt>
          <dd>{__MURMUR_VERSION__}</dd>
          <dt>本地服务</dt>
          <dd>{loading ? <Skeleton width={80} height={12} /> : info?.version ? `etcli ${info.version}` : '未连接'}</dd>
          {platform && (<><dt>系统</dt><dd>{platform}{diag?.wechat_version ? ` · 微信 ${diag.wechat_version}` : ''}</dd></>)}
          <dt>源代码 / 反馈</dt>
          <dd><code>github.com/sgaofen/murmur</code></dd>
          <dt>诊断信息</dt>
          <dd><DiagBundleButton /></dd>
        </dl>
      </div>
    </Card>
  );
}
