# Murmur UI 基础

`app/src/ui/` 是前端的设计基础：语义 token、主题切换、以及一组只用 className + token 的基础组件。
所有组件在 `#/ui-gallery` 页面里有实时演示（生产包也能打开，但不在导航里）。

```ts
import { Button, Callout, Dialog, ErrorState, useTheme } from '../ui';
import { IconKey } from '../ui/icons';
```

样式在 `ui.css`，由 `main.tsx` 全局引入一次；组件文件里不写行内颜色。

---

## 1. Token

定义在 `app/src/tokens.css`，分三层：

| 层 | 作用 | 例子 |
| --- | --- | --- |
| 语义 token（新代码只用这一层） | 每个主题各一套原始值 | `--surface-card`、`--text-muted`、`--accent-solid`、`--danger-fg` |
| 装饰色板 | 插画、头像色、图表点缀，不承担语义 | `--et-amber` `--et-rose` `--et-sage` `--et-sky` `--et-postmark` `--et-faint` |
| 旧 `--et-*` 别名 | 兼容老代码，指向语义 token，深色下也会跟着变 | `--et-bg` → `--surface-page`，`--et-orange` → `--accent` |

### 语义 token 一览

- **surface**：`page`（页面底）、`card`（卡片/对话框）、`sunken`（凹陷区，如清单、代码块底）、`raised`（浮层/坞）、`inverse`、`hover`、`pressed`、`overlay`（遮罩）
- **text**：`primary`、`secondary`、`muted`、`faint`、`inverse`、`on-accent`（实心按钮上的字）
- **border**：`--border-subtle` / `--border-default` / `--border-strong`，焦点环 `--focus-ring`
- **accent**（珊瑚橙品牌色）：`--accent`（图标/细线）、`--accent-strong`、`--accent-text`（小字号文字，已保证对比度）、`--accent-solid` / `--accent-solid-hover`（实心按钮底）、`--accent-soft`（浅底）、`--accent-border`
- **状态色**：`--{success|warning|danger|info}-{bg|fg|border|solid}`，`-bg` 做底、`-fg` 做字和图标、`-border` 做描边、`-solid` 做实心元素（`--danger-solid-hover` 用于危险按钮悬停）
- **其他**：`--shadow-sm/md/lg/accent`、`--skeleton-base/shine`、`--radius-xs/sm/md/lg/xl/pill`、`--space-1..9`（4/8/12/16/24/32/48/64/96px）、`--font-serif/sans/mono`、`--ease-out`、`--dur-fast/base`、`--z-dialog`（外壳自己的层级见第 7 节）
- **media**（盖在照片 / 视频 / 渐变头像上的东西，深浅色一样）：`--media-scrim`（角标、悬停渐变）、`--media-scrim-strong`（看大图的遮罩）、`--media-on-scrim`（上面的白字）、`--media-control` + `--media-control-ink`（播放按钮的底和图标）。页面本身的遮罩仍用 `--surface-overlay`
- **graph**（只给关系网 `components/extras/GraphView.tsx` 用）：`--graph-backdrop`（画布背景，深色是星空）、`--graph-node-rim` / `--graph-specular`（节点描边和高光）、`--graph-star`、`--graph-self`（「你」的光晕）、`--graph-highlight`（悬停 / 选中环）、`--graph-circle-1…9`（核心圈分类色）。层级和连线颜色直接用语义 token（`--accent`、`--info-*`、`--warning-solid`、`--et-amber` / `--et-sky` 等）。SVG 里通过 `style={{ fill / stroke / stopColor }}` 传 `var()`

### 规则

- **不要写死 hex / rgba。** 需要新颜色时先在 `tokens.css` 的浅色块和 `.et-dark` 块里各加一个语义 token。
- 文字配底色时按对出现：`--danger-bg` 底 + `--danger-fg` 字；`--accent-solid` 底 + `--text-on-accent` 字。
- 想要「局部强制深色/浅色」：给容器加 `.et-dark` 或 `.et-light`，里面的语义 token 和旧别名都会重新计算。

---

## 2. 主题

三种模式：`light` / `dark` / `system`（跟随系统）。存在 `localStorage['murmur.theme']`，读写都包了 try/catch，存不了就只在本次会话生效。

```tsx
// main.tsx（已接好）
initTheme();                      // 首屏渲染前把 .et-dark / data-theme / color-scheme 写到 <html>，避免闪白
root.render(<ThemeProvider><App /></ThemeProvider>);

// 任意组件
const { mode, resolved, setMode, toggle } = useTheme();
// mode: 用户选的模式；resolved: 实际生效的 'light' | 'dark'
// toggle(): 在 light/dark 之间切（如果当前是 system，会切成与当前相反的固定值）
```

- `ThemeProvider` 监听 `prefers-color-scheme` 变化（选「跟随系统」时实时生效）和 `storage` 事件（多窗口同步）。
- `useTheme()` 必须在 `ThemeProvider` 里调用，否则会抛错。
- 非 React 代码可以直接用 `setThemeMode(mode)`；`resolveTheme(mode, systemDark)` 是纯函数。
- `<ThemeSwitcher />`：浅色/深色/跟随系统三段切换，放在「设置 → 外观」（`#settings`）。UI-1 时右下角的临时浮动坞已删除。关系网顶栏的月亮/太阳按钮调用的是同一个 `toggle()`。
- 深色作用在 `<html class="et-dark">` 上，所以页面里**不需要**再传 `dark` prop 或手动加 `.et-dark`。

---

## 3. 组件

### Button

```tsx
<Button variant="primary" size="lg" block onClick={start}>开始</Button>
<Button variant="secondary" icon={<IconRefresh size={16} />} loading={busy}>重新连接</Button>
<Button variant="ghost">或者：手动粘贴密钥</Button>
<Button variant="danger" size="sm">删除</Button>
```

| prop | 说明 |
| --- | --- |
| `variant` | `primary`（每屏最多一个）/ `secondary`（默认）/ `ghost` / `danger` |
| `size` | `sm` 28px / `md` 36px（默认）/ `lg` 46px |
| `block` | 撑满宽度 |
| `pill` | 全圆角 |
| `loading` | 显示转圈并禁用 |
| `icon` / `iconAfter` | 前后图标 |

其余原生 `<button>` 属性照传，`type` 默认 `button`。需要「长得像按钮的链接」时用 `buttonClass()`：

```tsx
<a className={buttonClass({ variant: 'secondary', size: 'sm' })} href={url}>打开日志目录</a>
```

### Card / CardHeader

```tsx
<Card variant="paper" padding="md">
  <CardHeader eyebrow="本周" title="和谁聊得最多" description="按消息数排序" actions={<Button size="sm">全部</Button>} />
  …
</Card>
```

- `variant`：`paper`（默认，带阴影）/ `sunken`（凹陷底，适合清单、表格）/ `outline`（只有描边）
- `padding`：`none` / `sm` / `md`（默认）/ `lg`
- `interactive`：悬停抬起，用于整卡可点击
- 其余 `div` 属性照传

### Callout

```tsx
<Callout tone="warning" compact>准备好了再点下面……</Callout>
<Callout tone="accent" title="推荐用「实时抓取」" actions={<Button variant="primary" block>用实时抓取</Button>}>
  4.1.9 之后密钥不再常驻内存……
</Callout>
```

- `tone`：`info`（默认）/ `success` / `warning` / `danger` / `accent`（品牌推荐路径）
- 每种 tone 有默认图标；`icon={null}` 隐藏，或传自定义图标
- `title`、`actions`（放在正文下方）、`compact`（紧凑内边距）
- `danger` 带 `role="alert"`，其余 `role="note"`

### Dialog

```tsx
<Dialog
  open={open}
  onClose={() => setOpen(false)}
  eyebrow="密钥"
  title="重新读取微信密钥"
  description="按下面的步骤操作"
  size="md"
  accent
  footer={<><Button onClick={close}>取消</Button><Button variant="primary">开始</Button></>}
>
  …长内容会在卡片内部滚动，footer 固定在底部…
</Dialog>
```

- 遮罩 + 卡片，通过 portal 挂在 `body` 上，打开时锁定页面滚动
- `Esc` 关闭（多层对话框只关最上面那个）；点遮罩关闭；`Tab` 焦点圈在对话框内；关闭后焦点回到打开前的元素
- `dismissible={false}`：禁用 Esc / 点遮罩 / 右上角 ×，用于必须走完的流程
- `closeOnScrim={false}`：只禁用「点遮罩关闭」，Esc 和 × 照常可用；用于步骤多、误点外面会丢进度的流程（如初始化引导）
- `size`：`sm` 440 / `md` 560（默认）/ `lg` 720
- `accent`：左侧珊瑚色竖条（和引导对话框同款）
- 想让某个元素打开时自动获得焦点：给它加 `data-autofocus`

### Stepper

```tsx
const steps = [
  { key: 'detect', label: '检测环境' },
  { key: 'key', label: '抓密钥', description: '约 1–2 分钟' },
  { key: 'decrypt', label: '解密' },
];
<Stepper steps={steps} current="key" error={failed} onStepClick={(key) => go(key)} />
```

- `current`：下标或 key；之前的步骤自动标为完成
- `error`：把当前步标成出错
- `orientation`：`horizontal`（默认）/ `vertical`
- `onStepClick`：传了之后「已完成 / 当前 / 出错」的步骤可以点
- 单步可用 `status` 覆盖；`stepStatus(i, current, error)` 是同一套推导逻辑的纯函数
- 窄屏（≤560px）横向模式会隐藏描述、缩小标签

### EmptyState

```tsx
<EmptyState
  layout="page"
  icon={<IconKey size={26} />}
  title="还没完成初始化"
  description="请按初始化引导选择微信数据目录、抓密钥并解密。"
  actions={<Button variant="primary" size="lg">打开初始化引导</Button>}
/>
```

- `icon` 默认是收件箱图标，放在虚线圆章里；`icon={null}` 不显示
- `layout`：`inline`（默认，放在卡片/列表里）/ `page`（整页居中）

### ErrorState

给用户看的错误要回答三件事：**出了什么错（错误码）→ 为什么（原因）→ 怎么办（处理办法）**。

```tsx
<ErrorState
  layout="page"
  code="HTTP 503 · database_malformed"
  title="首页数据没能加载"
  reason="解密后的某个数据库文件损坏。"
  fixes={['打开「设置 → 重新解密」强制刷新一次', '仍然失败就把诊断信息贴到 issue']}
  onRetry={retry}
  retryLabel="重新连接"
  diagnostics={() => buildDiagnostics()}   // 字符串或（异步）函数，点击时才计算
  details={<pre>{rawError}</pre>}           // 折叠的「技术细节」
/>
```

- `title` 默认「出了点问题」；`code` 显示为「错误码 …」徽标
- `fixes` 传数组时渲染成有序列表（标题「怎么办」），也可以直接传节点
- `onRetry` / `retryLabel` / `retrying`：重试按钮（主按钮）
- `diagnostics` / `diagnosticsLabel`：「复制诊断信息」按钮，会显示复制中 / 已复制 / 失败；**拼诊断文本时记得先脱敏**（Home 里用的是 `maskText`）
- `actions`：额外按钮；`details` / `detailsLabel`：折叠区
- `tone`：`danger`（默认）/ `warning`；`layout`：`inline` / `page`

### Skeleton

```tsx
<Skeleton width={48} height={48} circle />
<Skeleton width="60%" height={14} />
<SkeletonText lines={3} lastLineWidth="40%" />
```

带微光动画；系统开了「减少动态效果」时自动停掉。

### Chip

```tsx
<Chip tone="accent">夜聊伙伴</Chip>
<Chip tone="success" icon={<IconCheck size={12} />} size="sm">已解密</Chip>
<Chip selected={on} onClick={() => setOn(!on)}>只看好友</Chip>     // 可切换：渲染成 button + aria-pressed
<Chip onRemove={() => drop(tag)}>老朋友</Chip>                       // 可删除：带 ×（只用于静态 chip）
```

- `tone`：`neutral`（默认）/ `accent` / `info` / `success` / `warning` / `danger`
- `size`：`sm` / `md`（默认）

### SegmentedControl / ThemeSwitcher

```tsx
<SegmentedControl
  label="抓取时长"
  size="sm"
  value={String(seconds)}
  onChange={(v) => setSeconds(Number(v))}
  options={[{ value: '60', label: '60 秒' }, { value: '90', label: '90 秒' }]}
/>
```

- 语义是 `radiogroup`，方向键切换；`label` 必填（读屏用）
- `iconOnly`：只显示图标，label 进 `title` / `aria-label`
- `ThemeSwitcher` 是它的一个现成封装，`compact` 时只显示图标

### 图标 / 工具

- `../ui/icons`：`IconSun` `IconMoon` `IconSystem` `IconInfoCircle` `IconCheckCircle` `IconWarning` `IconAlertCircle` `IconClose` `IconCheck` `IconRefresh` `IconCopy` `IconInbox` `IconKey` `IconSparkle`；外壳用到的 `IconHome` `IconNetwork` `IconCalendar` `IconReport` `IconTable` `IconSearch` `IconSettings` `IconEye` `IconEyeOff` `IconChevronLeft` `IconChevronsUpDown` `IconSidebarCollapse` `IconSidebarExpand` `IconFolder` `IconPlay` `IconPause` `IconPlus`。24 网格、1.5 描边、`currentColor`、默认 `aria-hidden`，都接受 `size`
- `copyText(text)`：优先 `navigator.clipboard`，失败回退到 `execCommand('copy')`
- `cx(...classes)`：拼 className，忽略假值

---

## 4. 布局工具类

| 类 | 作用 |
| --- | --- |
| `.ui-stack` | 纵向 flex，间距 8px |
| `.ui-stack--md` | 配合 `.ui-stack`，间距 12px |
| `.ui-row` | 横向 flex，居中对齐，间距 8px，可换行 |
| `.ui-mt-2/3/4`、`.ui-mb-2/3/4` | 上/下外边距 8/12/16px（写在 `ui.css` 末尾，能覆盖组件自带的 margin） |
| `.ui-eyebrow` / `.ui-eyebrow--accent` | 小号大写眉题 |
| `.ui-vsep` | 行内竖分隔线（14px 高） |

---

## 5. 字体

- **衬线（标题、引文）**：内置 `@fontsource-variable/noto-serif-sc`（可变字重 200–900，只有 woff2，按 unicode-range 分片，浏览器只下载页面实际用到的分片）。在 `main.tsx` 里 `import '@fontsource-variable/noto-serif-sc/wght.css'`。
- **无衬线（正文、界面）**：不内置，走系统字体栈 `--font-sans`（macOS 苹方 / Windows 微软雅黑 / Linux Noto Sans CJK）。原因：再内置一套中文无衬线可变字体要多约 4.5MB，而系统中文黑体在三个平台上都足够好。
- 不再从 Google Fonts 加载任何东西，离线也能正常显示。

---

## 6. 新增 / 修改组件时

1. 样式写进 `ui.css`，类名以 `ui-` 开头，只用 token。
2. 在 `index.ts` 导出组件和 props 类型。
3. 在 `pages/UiGallery.tsx` 加一个演示分区，并在浅色、深色、390px 宽度下各看一眼。
4. 更新本文件。

---

## 7. 应用外壳（`src/shell/`）

除了 `#ui-gallery` 和启动加载页，所有页面都包在 `<AppShell>` 里：左侧导航栏 + 顶栏 + 内容区，整页滚动（`document` 滚，不是内容区自己滚）。

- **顶栏**：页面用 `<PageHeader>` 声明自己的标题，它会通过 portal 渲染进外壳顶栏。页面特有的按钮作为 children 传进去，放在右侧。
  ```tsx
  <PageHeader title="年度总览" subtitle="你的所有朋友 + 所有聊天">
    <YearSwitcher … />
  </PageHeader>
  <PageHeader back={{ label: '首页', onClick: onBack }} title={`和 ${name} 的故事`} />
  ```
  页面还没渲染 `PageHeader`（加载中、报错）时，顶栏显示 `App.tsx` 里 `shellFor()` 给的默认标题。按钮放不下时在顶栏里横向滚动，不会撑宽页面。
- **左侧栏**：首页 / 关系网 / 年度 / 报告 / 离线证据表 / 搜索，底部是账号切换、隐私模式、设置和收起按钮。窗口宽度 < 900px 时自动收成 64px 图标栏；更宽时可以手动收起，记在 `localStorage['murmur.nav.collapsed']`。
- **铺满内容区的页面**（关系网、报告）：根节点加 `className="app-fill"`，它会 `position: fixed` 填满顶栏以下、侧栏右侧的区域。
- **CSS 变量**（定义在 `.app-shell` 上）：`--shell-left`（内容区左边缘，侧栏宽度）、`--shell-top`（顶栏高度 56px）、`--shell-vh`（内容区可见高度）。页面里 `position: fixed` 的东西用它们避开侧栏和顶栏，例如 `left: 'var(--shell-left, 0px)'`；整屏高度的占位用 `minHeight: 'var(--shell-vh, 100vh)'`。
- **层级**：页面内容 < 顶栏 `--z-topbar`(30) < 侧栏 `--z-nav`(40) < `.app-fill`(45) < 页面自己的浮层/对话框。侧栏里的账号弹层 portal 到 `body`，z-index 300。
