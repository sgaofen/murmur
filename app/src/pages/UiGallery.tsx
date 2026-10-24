/* #/ui-gallery — every ui/ primitive in one page, for design review and
 * screenshots. Not linked from the app's navigation. */
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Button, buttonClass, Callout, Card, CardHeader, Chip, Dialog, EmptyState, ErrorState,
  SegmentedControl, Skeleton, SkeletonText, Stepper, ThemeSwitcher, useTheme,
} from '../ui';
import { IconArrowLeft, IconArrowRight, IconDownload, IconRefresh, IconSparkle } from '../utils/icons';
import './UiGallery.css';

const OFL_URL = `${import.meta.env.BASE_URL}licenses/NotoSerifSC-OFL.txt`;

/** Noto Serif SC ships inside the app, so its SIL OFL 1.1 text has to ship
 * and be readable too (app/public/licenses/). Loaded on first open. */
function FontLicense() {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  function load() {
    if (text != null || failed) return;
    fetch(OFL_URL)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setText, () => setFailed(true));
  }
  return (
    <details className="gal-license" onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open) load(); }}>
      <summary>字体许可 · Noto Serif SC 以 SIL Open Font License 1.1 授权，点开查看全文</summary>
      {failed
        ? <p className="gal-license__note">许可文本没能加载，可以在安装目录的 <code>licenses/NotoSerifSC-OFL.txt</code> 找到。</p>
        : <pre className="gal-license__text">{text ?? '加载中…'}</pre>}
    </details>
  );
}

const SURFACES = ['--surface-page', '--surface-card', '--surface-sunken', '--surface-raised', '--surface-inverse'];
const TEXTS = ['--text-primary', '--text-secondary', '--text-muted', '--text-faint', '--border-default'];
const ACCENTS = ['--accent', '--accent-strong', '--accent-text', '--accent-solid', '--accent-soft'];
const TONES = [
  { tone: 'info', label: '提示' },
  { tone: 'success', label: '成功' },
  { tone: 'warning', label: '注意' },
  { tone: 'danger', label: '出错' },
] as const;

const ONBOARD_STEPS = [
  { key: 'check', label: '环境自检' },
  { key: 'dir', label: '数据目录' },
  { key: 'perm', label: '权限 / 重签名' },
  { key: 'key', label: '抓密钥', description: '内存扫描 / 实时抓取' },
  { key: 'decrypt', label: '解密' },
  { key: 'done', label: '完成' },
];

export default function UiGalleryPage({ onBack }: { onBack: () => void }) {
  const { resolved } = useTheme();
  return (
    <div className="gal">
      <header className="gal-bar">
        <div className="gal-brand">
          <button type="button" className={buttonClass({ variant: 'ghost', size: 'sm' })} onClick={onBack}>
            <IconArrowLeft size={14} /> 返回首页
          </button>
          <span className="gal-brand__name">Murmur UI</span>
          <span className="gal-brand__sub">设计基础 · 组件一览</span>
        </div>
        <ThemeSwitcher />
      </header>

      <main className="gal-main">
        <div className="gal-hero">
          <div className="ui-eyebrow ui-eyebrow--accent">UI-1 · Design foundation</div>
          <h1 className="gal-hero__title">纸张、墨蓝与<em>珊瑚橙</em></h1>
          <p className="gal-hero__lead">
            所有颜色都来自 <code>tokens.css</code> 的语义变量，当前是{resolved === 'dark' ? '深色' : '浅色'}主题。
            组件在 <code>app/src/ui/</code>，用法见同目录的 README。
          </p>
        </div>

        <Section no="01" title="颜色" desc={<>页面里只用语义变量（<code>--surface-*</code> / <code>--text-*</code> / <code>--accent-*</code> / 状态色），不写 hex。</>}>
          <div className="gal-label">SURFACE</div>
          <Swatches names={SURFACES} />
          <div className="gal-label">TEXT · BORDER</div>
          <Swatches names={TEXTS} />
          <div className="gal-label">ACCENT</div>
          <Swatches names={ACCENTS} />
          <div className="gal-label">STATUS · -bg / -fg / -border</div>
          <div className="gal-swatches">
            {TONES.map(t => (
              <div key={t.tone} className={`gal-tone ui-tone--${t.tone}`}>
                <span className="gal-tone__big">Aa {t.label}</span>
                <span className="gal-tone__name">--{t.tone}-*</span>
              </div>
            ))}
          </div>
        </Section>

        <Section no="02" title="字体" desc="标题用内置的 Noto Serif SC（可变字重，按字符分片本地加载）；正文用系统字体 PingFang SC / 微软雅黑。">
          <div className="gal-type">
            <span className="gal-type__meta">display · serif 600</span>
            <span className="gal-type__display">这些年，你遇见了 1,284 个人</span>
            <span className="gal-type__meta">serif 字重</span>
            <span className="gal-type__weights">
              <span style={{ fontWeight: 400 }}>微语 400</span>
              <span style={{ fontWeight: 500 }}>微语 500</span>
              <span style={{ fontWeight: 600 }}>微语 600</span>
              <span style={{ fontWeight: 700 }}>微语 700</span>
              <span style={{ fontWeight: 900 }}>微语 900</span>
            </span>
            <span className="gal-type__meta">h2 · serif 500</span>
            <span className="et-h2">一年里你和谁说话最多</span>
            <span className="gal-type__meta">body · sans 400</span>
            <span className="gal-type__body">
              Murmur 是一本关于你这些年聊天的本地纪念册 —— 所有数据从微信读出，分析后只在你的电脑上呈现，不会上传到任何地方。
            </span>
            <span className="gal-type__meta">meta · sans 500</span>
            <span className="et-meta">全部数据均在你的电脑上 · 不会上传到任何云端</span>
            <span className="gal-type__meta">mono</span>
            <span className="gal-type__mono">~/Documents/Murmur/logs/serve.log</span>
          </div>
          <FontLicense />
        </Section>

        <Section no="03" title="Button" desc="primary / secondary / ghost / danger × sm / md / lg；loading 会禁用点击；链接用 buttonClass()。">
          <div className="gal-label">VARIANT</div>
          <div className="gal-row">
            <Button variant="primary">开始抓取</Button>
            <Button variant="secondary">手动粘贴密钥</Button>
            <Button variant="ghost">稍后再说</Button>
            <Button variant="danger">删除解密数据</Button>
          </div>
          <div className="gal-label">SIZE</div>
          <div className="gal-row">
            <Button variant="primary" size="sm">小号</Button>
            <Button variant="primary" size="md">中号</Button>
            <Button variant="primary" size="lg">大号</Button>
            <Button variant="secondary" size="sm" pill>pill 小号</Button>
            <Button variant="secondary" pill>pill 中号</Button>
          </div>
          <div className="gal-label">STATE · ICON · LINK</div>
          <div className="gal-row">
            <Button variant="primary" loading>正在解密…</Button>
            <Button variant="secondary" disabled>不可用</Button>
            <Button variant="secondary" icon={<IconRefresh size={15} />}>更新数据</Button>
            <Button variant="ghost" iconAfter={<IconArrowRight size={15} />}>下一步</Button>
            <a className={buttonClass({ variant: 'secondary', pill: true })} href="#/ui-gallery">
              <IconDownload size={15} /> 链接样式
            </a>
          </div>
          <div className="gal-label">BLOCK</div>
          <div className="ui-stack gal-narrow">
            <Button variant="primary" size="lg" block>开始（微信）</Button>
            <Button variant="secondary" size="lg" block>🐧 切换到 QQ</Button>
          </div>
        </Section>

        <Section no="04" title="Chip" desc="标签和筛选。onClick 时变成切换按钮（aria-pressed）。">
          <div className="gal-label">TONE</div>
          <div className="gal-row">
            <Chip>默认</Chip>
            <Chip tone="accent" icon={<IconSparkle size={12} />}>夜聊伙伴</Chip>
            <Chip tone="info">已验证 4.1.15</Chip>
            <Chip tone="success">已解密</Chip>
            <Chip tone="warning">缺 2 个库</Chip>
            <Chip tone="danger">密钥无效</Chip>
            <Chip size="sm" tone="accent">小号</Chip>
          </div>
          <div className="gal-label">FILTER · REMOVABLE</div>
          <FilterChips />
        </Section>

        <Section no="05" title="Card" desc="paper（默认）/ sunken / outline，可加 CardHeader；interactive 有悬停抬起。">
          <div className="gal-grid">
            <Card>
              <CardHeader eyebrow="时光线" title="八月最响，二月最静" description="一年里你和谁说话最多。" />
              <div className="et-meta">高峰 · 8 月 3,204 条</div>
            </Card>
            <Card variant="sunken">
              <CardHeader eyebrow="sunken" title="内嵌信息块" description="用在对话框里的列表、代码、能力检测。" />
            </Card>
            <Card variant="outline" interactive tabIndex={0}>
              <CardHeader eyebrow="outline" title="可点击卡片"
                actions={<Chip size="sm" tone="accent">No.1</Chip>} description="interactive：悬停时轻微抬起。" />
            </Card>
          </div>
        </Section>

        <Section no="06" title="Callout" desc="四种语气：info / success / warning / danger。">
          <div className="gal-grid gal-grid--2">
            <Callout tone="info" title="全部数据只在本机">从读取密钥到分析，一切在你的电脑上完成，不会上传任何内容。</Callout>
            <Callout tone="success" title="已解密 12 个数据库">聊天、联系人、朋友圈都已就绪，可以开始回顾了。</Callout>
            <Callout tone="warning" title="有 2 个库没解开"
              actions={<Button size="sm" variant="secondary">重新抓密钥</Button>}>
              多点开几个聊天和朋友圈，让微信把密钥加载进内存，再试一次。
            </Callout>
            <Callout tone="danger" title="密钥校验失败">这个密钥和 <code>message_0.db</code> 不匹配，可能来自另一个微信账号。</Callout>
          </div>
          <div className="gal-label">COMPACT</div>
          <div className="gal-narrow">
            <Callout tone="info" compact>为啥要点开对话？没点开的库，密钥不会出现在内存里。</Callout>
          </div>
        </Section>

        <Section no="07" title="Stepper" desc="横向 / 纵向；已完成和当前步骤可以点（UI-4 用来「从这一步重来」）。">
          <StepperDemo />
        </Section>

        <Section no="08" title="SegmentedControl · ThemeSwitcher" desc="一组里选一个（radiogroup，方向键可切换）。外观切换就是它。">
          <SegmentedDemo />
        </Section>

        <Section no="09" title="EmptyState" desc="列表 / 页面没有内容时用；layout=&quot;page&quot; 会在视口居中。">
          <Card padding="none">
            <EmptyState
              title="还没有关系报告"
              description="选一位朋友，让本机的 Claude Code / Codex 读一读你们的聊天，生成第一份报告。"
              actions={<><Button variant="primary">去选朋友</Button><Button variant="ghost">了解怎么工作</Button></>}
            />
          </Card>
        </Section>

        <Section no="10" title="ErrorState" desc="错误码 + 原因 + 怎么办 + 重试 + 复制诊断；原始报错收在「技术细节」里。">
          <ErrorDemo />
        </Section>

        <Section no="11" title="Skeleton" desc="加载占位，带柔和的光泽动画（减少动态效果时静止）。">
          <div className="gal-grid">
            {[0, 1, 2].map(i => (
              <Card key={i}>
                <div className="gal-friend">
                  <Skeleton circle width={44} />
                  <div className="gal-friend__lines">
                    <Skeleton width="55%" height={14} />
                    <Skeleton width="35%" height={11} />
                  </div>
                </div>
                <div className="gal-skel-body"><SkeletonText lines={3} /></div>
              </Card>
            ))}
          </div>
        </Section>

        <Section no="12" title="Dialog" desc="遮罩 + 卡片，内容区内部滚动，Esc / 点遮罩关闭，打开时锁住焦点。">
          <DialogDemo />
        </Section>
      </main>
    </div>
  );
}

function Section({ no, title, desc, children }: { no: string; title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="gal-section">
      <div className="gal-section__head">
        <span className="gal-section__no">{no}</span>
        <span className="gal-section__title">{title}</span>
        {desc && <span className="gal-section__desc">{desc}</span>}
      </div>
      {children}
    </section>
  );
}

function Swatches({ names }: { names: string[] }) {
  return (
    <div className="gal-swatches">
      {names.map(n => (
        <div key={n} className="gal-swatch">
          <div className="gal-swatch__chip" style={{ background: `var(${n})` }} />
          <span className="gal-swatch__name">{n}</span>
        </div>
      ))}
    </div>
  );
}

function FilterChips() {
  const [on, setOn] = useState<'private' | 'group' | 'all'>('private');
  const [tags, setTags] = useState(['老朋友', '夜聊伙伴', '秒回选手']);
  return (
    <div className="gal-row">
      <Chip onClick={() => setOn('private')} selected={on === 'private'}>私聊朋友</Chip>
      <Chip onClick={() => setOn('group')} selected={on === 'group'}>群聊</Chip>
      <Chip onClick={() => setOn('all')} selected={on === 'all'}>全部</Chip>
      <span className="ui-vsep" />
      {tags.map(t => (
        <Chip key={t} tone="accent" onRemove={() => setTags(ts => ts.filter(x => x !== t))} removeLabel={`移除「${t}」`}>{t}</Chip>
      ))}
      {tags.length === 0 && <Button size="sm" variant="ghost" onClick={() => setTags(['老朋友', '夜聊伙伴', '秒回选手'])}>恢复标签</Button>}
    </div>
  );
}

function StepperDemo() {
  const [current, setCurrent] = useState(3);
  const [failed, setFailed] = useState(false);
  return (
    <div className="gal-stack">
      <Card padding="lg">
        <Stepper steps={ONBOARD_STEPS} current={current} error={failed}
          onStepClick={(_, i) => { setCurrent(i); setFailed(false); }} />
      </Card>
      <div className="gal-row">
        <Button size="sm" variant="secondary" onClick={() => { setCurrent(c => Math.max(0, c - 1)); setFailed(false); }}>上一步</Button>
        <Button size="sm" variant="secondary" onClick={() => { setCurrent(c => Math.min(ONBOARD_STEPS.length - 1, c + 1)); setFailed(false); }}>下一步</Button>
        <Button size="sm" variant={failed ? 'secondary' : 'danger'} onClick={() => setFailed(f => !f)}>{failed ? '清除错误' : '当前步骤出错'}</Button>
      </div>
      <div className="gal-grid gal-grid--2">
        <Card>
          <Stepper orientation="vertical" current={2} steps={[
            { key: 'a', label: '检测系统和微信', description: 'macOS 15 · 微信 4.1.15' },
            { key: 'b', label: '找到数据目录', description: '~/Library/Containers/com.tencent.xinWeChat' },
            { key: 'c', label: '抓取密钥', description: '弹出系统密码窗口后输入开机密码' },
            { key: 'd', label: '解密并建索引' },
          ]} />
        </Card>
        <Card>
          <Stepper orientation="vertical" current={1} error steps={[
            { key: 'a', label: '读取 key' },
            { key: 'b', label: 'HMAC 校验', description: '页 1 校验没通过' },
            { key: 'c', label: '保存' },
          ]} />
        </Card>
      </div>
    </div>
  );
}

function SegmentedDemo() {
  const [range, setRange] = useState<'50' | '100' | '200' | '300'>('100');
  return (
    <div className="gal-stack">
      <div className="gal-row">
        <ThemeSwitcher />
        <ThemeSwitcher compact />
      </div>
      <div className="gal-row">
        <SegmentedControl label="显示人数" value={range} onChange={setRange}
          options={(['50', '100', '200', '300'] as const).map(v => ({ value: v, label: `top ${v}` }))} />
        <SegmentedControl label="显示人数" size="sm" value={range} onChange={setRange}
          options={(['50', '100', '200', '300'] as const).map(v => ({ value: v, label: v }))} />
      </div>
    </div>
  );
}

function ErrorDemo() {
  const [retrying, setRetrying] = useState(false);
  return (
    <ErrorState
      code="HTTP 503 · database_malformed"
      title="首页数据没能加载"
      reason="解密后的某个 WECHAT 数据库文件损坏（SQLite: database disk image is malformed）。"
      fixes={[
        '点「重试」再连一次本地服务',
        <>完全退出 Murmur，删除 <code>~/Documents/Murmur/decrypted/</code> 后重新解密</>,
        '还不行就点「复制诊断信息」，贴到 GitHub issue',
      ]}
      onRetry={() => { setRetrying(true); window.setTimeout(() => setRetrying(false), 1400); }}
      retrying={retrying}
      diagnostics={'### Murmur 诊断（示例）\n- 报错：HTTP 503 database_malformed'}
      details={<><div>报错原文</div><pre>{'API /api/home-summary: 503 {"error": "database_malformed", "type": "DatabaseError"}'}</pre></>}
    />
  );
}

function DialogDemo() {
  const [open, setOpen] = useState<null | 'short' | 'long' | 'locked'>(null);
  const close = () => setOpen(null);
  return (
    <>
      <div className="gal-row">
        <Button variant="primary" onClick={() => setOpen('short')}>打开对话框</Button>
        <Button variant="secondary" onClick={() => setOpen('long')}>长内容（内部滚动）</Button>
        <Button variant="ghost" onClick={() => setOpen('locked')}>必须完成的步骤</Button>
      </div>
      <Dialog open={open === 'short'} onClose={close} size="sm" eyebrow="导出" title="导出这段聊天"
        description="生成的文件只保存在你的电脑上。"
        footer={<><Button variant="ghost" onClick={close}>取消</Button><Button variant="primary" onClick={close} data-autofocus>导出 HTML</Button></>}>
        <Callout tone="info" compact>图片和语音会按原文件复制；没下载过的媒体会标记为缺失。</Callout>
      </Dialog>
      <Dialog open={open === 'long'} onClose={close} accent eyebrow="欢迎来到 Murmur" title="回顾你的微信故事"
        footer={<Button variant="primary" onClick={close}>知道了</Button>}>
        {Array.from({ length: 14 }, (_, i) => (
          <p key={i} className="gal-dialog-p">
            第 {i + 1} 段 · Murmur 是一本关于你这些年聊天的本地纪念册 —— 所有数据从微信读出，分析后只在你的电脑上呈现。
            内容超出窗口高度时，只有这一块滚动，标题和底部按钮保持不动。
          </p>
        ))}
      </Dialog>
      <Dialog open={open === 'locked'} onClose={close} dismissible={false} size="sm" title="正在解密…"
        footer={<Button variant="secondary" onClick={close}>（演示）完成</Button>}>
        <div className="gal-stack">
          <SkeletonText lines={2} />
          <span className="et-meta">dismissible=false：Esc 和点遮罩都不会关闭。</span>
        </div>
      </Dialog>
    </>
  );
}
