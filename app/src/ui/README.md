# Murmur UI 基础

`app/src/ui/` 是前端的设计基础：语义 token、主题切换、以及一组只用 className + token 的基础组件。
视觉方向是「B · 仪器」：浅色是铝、深色是石墨，界面由 1px 网格分出带编号的模块，数字用等宽字体，全局只有一个信号绿强调色。
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
| 语义 token（新代码只用这一层） | 每个主题各一套原始值，浅色（铝）和深色（石墨）分别调过，不是简单反色 | `--surface-card`、`--text-muted`、`--signal`、`--heat-3`、`--danger-fg` |
| 装饰色板 | 旧页面的插画、头像色、图表点缀，已压低饱和度，不承担语义；新代码别用 | `--et-amber` `--et-rose` `--et-sage` `--et-sky` `--et-postmark` `--et-faint` |
| 旧 `--et-*` 别名 | 兼容老代码，指向语义 token，深色下也会跟着变 | `--et-bg` → `--surface-page`，`--et-orange` → `--accent`（即信号绿） |

### 语义 token 一览

- **surface**：`page`（页面底）、`card`（卡片/对话框）、`sunken`（凹陷区，如清单、代码块底）、`raised`（浮层/坞）、`inverse`、`hover`、`pressed`、`overlay`（遮罩）
- **text**：`primary`、`secondary`、`muted`、`faint`、`inverse`、`on-accent`（实心按钮上的字）
- **border**：`--border-subtle` / `--border-default` / `--border-strong`，焦点环 `--focus-ring`
- **signal**（唯一的强调色，信号绿）：`--signal`（实心块：当前按键、峰值、主按钮底）、`--signal-ink`（小字号文字和细线，浅色下是深橄榄色以保证对比度）、`--signal-dim`（选中行浅底）、`--signal-line`、`--text-on-signal`（信号绿上的字）。一屏里信号绿的面积要小：一个当前按键、一个峰值、一个主按钮
- **accent**：旧名字，全部指向 signal（`--accent` / `--accent-solid` → `--signal`，`--accent-text` → `--signal-ink`，`--accent-soft` → `--signal-dim`），老代码不用改
- **heat**：`--heat-0..4`，从「空格子」到「最满」的五级灰阶，用于热度格、VU 表、占比条；浅色和深色各一套
- **状态色**：`--{success|warning|danger|info}-{bg|fg|border|solid}`，`-bg` 做底、`-fg` 做字和图标、`-border` 做描边、`-solid` 做实心元素（`--danger-solid-hover` 用于危险按钮悬停）
- **其他**：`--shadow-sm`（等于无阴影：模块靠 1px 线分隔，不靠投影）、`--shadow-md/lg`（只给浮层、对话框）、`--skeleton-base/shine`、`--radius-xs/sm`（2px）/ `md/lg`（3px）/ `xl`（4px）/ `pill`、`--space-1..9`（4/8/12/16/24/32/48/64/96px）、`--font-sans/mono/display`（`--font-serif` 现在等于 sans，见第 5 节）、`--ease-out`、`--dur-fast/base`、`--z-dialog`（外壳自己的层级见第 7 节）
- **media**（盖在照片 / 视频 / 渐变头像上的东西，深浅色一样）：`--media-scrim`（角标、悬停渐变）、`--media-scrim-strong`（看大图的遮罩）、`--media-on-scrim`（上面的白字）、`--media-control` + `--media-control-ink`（播放按钮的底和图标）。页面本身的遮罩仍用 `--surface-overlay`
- **graph**（只给关系网 `components/extras/GraphView.tsx` 用，第一阶段只把颜色压成中性，页面本身下一阶段重做）：`--graph-backdrop`（画布背景）、`--graph-node-rim` / `--graph-specular`（节点描边和高光）、`--graph-star`、`--graph-self`（「你」的光晕）、`--graph-highlight`（悬停 / 选中环）、`--graph-circle-1…9`（核心圈分类色）。层级和连线颜色直接用语义 token（`--accent`、`--info-*`、`--warning-solid`、`--et-amber` / `--et-sky` 等）。SVG 里通过 `style={{ fill / stroke / stopColor }}` 传 `var()`

### 规则

- **不要写死 hex / rgba。** 需要新颜色时先在 `tokens.css` 的浅色块和 `.et-dark` 块里各加一个语义 token。
- 文字配底色时按对出现：`--danger-bg` 底 + `--danger-fg` 字；`--signal` 底 + `--text-on-signal` 字。
- 小字号的绿色文字一律用 `--signal-ink`，不要用 `--signal`（浅色底上对比度不够）。
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
- `<ThemeSwitcher />`：浅色/深色/跟随系统三段切换，放在「设置 → 外观」（`#settings`）。⌘K 命令面板的「操作」组里也有这三项。关系网顶栏的月亮/太阳按钮调用的是同一个 `toggle()`。
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
| `size` | `sm` 26px / `md` 30px（默认）/ `lg` 38px |
| `block` | 撑满宽度 |
| `pill` | 全圆角 |
| `loading` | 显示转圈并禁用 |
| `icon` / `iconAfter` | 前后图标 |
| `kbd` | 按键帽（如 `kbd="R"` 或 `kbd={<IconKey size={12} />}`），画在文字前面，和底部按键栏同一种「硬件按键」样子 |

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

- `variant`：`paper`（默认，平的卡片底 + 1px 描边，没有阴影）/ `sunken`（凹陷底，适合清单、表格）/ `outline`（只有描边）
- 新页面优先用下面的 `Module`（带编号的模块），`Card` 留给旧页面和对话框里的小块
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

- `tone`：`info`（默认）/ `success` / `warning` / `danger` / `accent`（推荐路径，信号绿）；样子是平的底 + 左侧 2px 的语气色竖线
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
- `accent`：顶部 2px 信号绿横条（和引导对话框同款）；遮罩不做毛玻璃
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
- 每一步是带编号的格子：`01` + 状态字（`DONE` / `RUN` 带闪烁指示灯 / `FAIL` / `—`），下面一条 3px 的进度轨
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

- `icon` 默认是收件箱图标，放在带四角裁切标记的方框里；`icon={null}` 不显示
- `label`：标题上方的等宽小标签，例如 `label="NO DATA · 00"`、`label="EMPTY"`
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

- 样子是「故障面板」：顶部 2px 语气色横条，分区标签是 `ERR · 错误码` / `CAUSE 原因` / `FIX 怎么办`，处理办法用 `01 02 …` 编号
- `title` 默认「出了点问题」；`code` 显示在 `ERR · 错误码` 后面
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
- 样子是等宽字体的小标签（方角、1px 描边）；`selected` 时是信号绿底

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
- 样子是并排连在一起的按键，选中的那个是信号绿底
- `iconOnly`：只显示图标，label 进 `title` / `aria-label`
- `ThemeSwitcher` 是它的一个现成封装，`compact` 时只显示图标

### Module（带编号的模块）

```tsx
<div className="ui-rack" style={{ gridTemplateColumns: '340px 1fr' }}>
  <Module id="01" title="联系人" right="CONTACTS">…</Module>
  <Module id="02" title="月度热度" en="LAST 12 MONTHS" right={<span>PEAK 08 · 5,240</span>} crop="bottom" scroll>…</Module>
</div>
```

- 头部一行：`id`（两位编号）+ `title`（中文）+ `en`（等宽英文副标，放不下时省略号截断）+ `right`（右侧读数或控件）
- `scroll`：正文区自己滚动（父级要给高度）；`crop`：四角裁切标记，`'bottom'` 只画下面两个角
- `as`：`section`（默认）/ `div` / `aside`；`bodyClassName` 给正文区加类
- 模块放进 `.ui-rack`（1px 网格容器：用 `gap: 1px` + 底色画出分隔线，外圈一道 1px 边框），模块自己不画边框

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
| `.ui-eyebrow` / `.ui-eyebrow--accent` | 小号大写眉题（和 `.ui-label` 同款） |
| `.ui-vsep` | 行内竖分隔线（14px 高） |

仪器风格的小部件（都只用 token）：

| 类 | 作用 |
| --- | --- |
| `.ui-label` | 等宽大写小标签，里面的 `<b>` 是中文注释：`<div className="ui-label">PEOPLE<b>聊过天的人</b></div>` |
| `.ui-big` / `.ui-num` | 大读数（`--font-display` 200 字重，`<small>` 放单位）/ 等宽表格数字 |
| `.ui-led` | 6px 方形指示灯；`.is-off` 空心、`.ui-led--warn` / `--error`、`.is-pulse` 闪烁 |
| `.ui-kbd` | 按键帽（底部按键栏、按钮的 `kbd`、⌘K 面板都用它） |
| `.ui-tsq` | 方形字母徽标（如 `WX` / `QQ` / 群 / 人）；`.is-solid` / `.is-signal` / `.is-faint` |
| `.ui-switch` | 方形拨动开关，`.is-on` 打开 |
| `.ui-field` | 单行输入框外壳（前面可放 `.ui-field__prompt`） |
| `.ui-crop` / `.ui-crop--bottom` | 四角裁切标记 |
| `.ui-rack` | 模块网格容器，见上面的 `Module` |

---

## 5. 字体

- **等宽（数字、标签、按键、表格）**：内置 `@fontsource-variable/jetbrains-mono`（OFL，可变字重 100–800，只有 woff2，按 unicode-range 分片）。在 `main.tsx` 里 `import '@fontsource-variable/jetbrains-mono/wght.css'`；许可证在 `public/licenses/JetBrainsMono-OFL.txt`。设计稿用的 SF Mono 不能随应用分发，所以换成它。中文落到系统字体（苹方 / 微软雅黑）。
- **大读数**：`--font-display`，系统 UI 字体（macOS SF Pro Display / Windows Segoe UI Variable）的 200 字重，不内置。
- **无衬线（正文、界面）**：不内置，走系统字体栈 `--font-sans`（macOS 苹方 / Windows 微软雅黑 / Linux Noto Sans CJK）。
- **衬线**：已不再使用，原来内置的 Noto Serif SC 已移除；`--font-serif` 保留为 `--font-sans` 的别名，旧页面不用改。设计稿里的 New York 同样不能分发。
- 不从任何网络地址加载字体，离线也能正常显示。

---

## 6. 新增 / 修改组件时

1. 样式写进 `ui.css`，类名以 `ui-` 开头，只用 token。
2. 在 `index.ts` 导出组件和 props 类型。
3. 在 `pages/UiGallery.tsx` 加一个演示分区，并在浅色、深色、820px 宽度下各看一眼。
4. 更新本文件。

---

## 7. 应用外壳（`src/shell/`）

除了 `#ui-gallery` 和启动加载页，所有页面都包在 `<AppShell>` 里：顶部状态条 + 内容区 + 底部编号按键栏，整页滚动（`document` 滚，不是内容区自己滚）。没有左侧栏。

- **顶部状态条**（38px，粘在顶部）：左边是 `MURMUR 微语`、章节号（`CH 01` … `CH 08`，设置是 `SYS`）和页面标题；中间放页面自己的按钮；右边是状态指示灯和时钟：
  - `LOCAL` / `OFFLINE`：本地服务能不能连上（来自 `utils/liveSync.ts` 的同一个轮询，不算用户操作，不会让应用锁续期）
  - `SYNC 15S` / `SYNC OFF`：实时同步状态
  - `PRIV ON/OFF`：隐私模式，点一下切换（`components/PrivacyToggle.tsx`）
  - 时钟 `YYYY-MM-DD HH:MM:SS`；窗口 < 1100px 时省略日期，< 900px 时省略时钟
- **页面标题**：页面用 `<PageHeader>` 声明，它通过 portal 渲染进状态条。页面特有的按钮作为 children 传进去，放在右侧。
  ```tsx
  <PageHeader title="年度总览" subtitle="你的所有朋友 + 所有聊天">
    <YearSwitcher … />
  </PageHeader>
  <PageHeader back={{ label: '年代记', onClick: onBack }} title={`和 ${name} 的故事`} />
  ```
  页面还没渲染 `PageHeader`（加载中、报错）时，状态条显示 `App.tsx` 里 `shellFor()` 给的默认标题。按钮放不下时在状态条里横向滚动，不会撑宽页面。
- **底部按键栏**（46px，固定在底部）：`1 年代记` `2 关系网` `3 档案` `4 对话` `5 检索` 和 `⌘K 命令`，然后是次要页面 `6 年度` `7 报告` `8 证据表`，最右边是账号切换（`WX 你`）和 `⌘, 设置`。当前页的按键是信号绿底。
  - `3 档案` / `4 对话` 打开本次会话最近看过的人 / 聊天；还没看过时打开 ⌘K 面板让你选人。
  - 键盘：`1`–`8` 直接跳转（焦点在输入框里或有对话框打开时不响应）；`⌘K` / `Ctrl K` 打开命令面板；`⌘,` / `Ctrl ,` 打开设置。
  - 窄窗口：< 980px 时次要按键（6–8）收进 ⌘K 面板；< 760px 时隐藏品牌字和部分标签；< 640px 时只有当前按键显示文字。任何宽度都不会横向溢出。
- **⌘K 命令面板**（`CommandPalette.tsx`）：`GO 前往`（所有页面，含设置）、`PEOPLE 人与群`（输入时才列出，最多 40 条；回车打开档案，⇧回车打开聊天；隐私模式下只按打码后的名字匹配）、`ACT 操作`（外观三种模式、隐私模式、添加账号 / 重新走初始化引导）。
- **铺满内容区的页面**（关系网、报告）：根节点加 `className="app-fill"`，它会 `position: fixed` 填满状态条和按键栏之间的区域。
- **CSS 变量**（定义在 `.app-shell` 上）：`--shell-top`（状态条高 38px）、`--shell-bottom`（按键栏高 46px）、`--shell-vh`（两者之间的可见高度）、`--shell-left`（现在恒为 0，保留给旧代码）。页面里 `position: fixed` 的东西用它们避开状态条和按键栏，例如 `bottom: 'calc(var(--shell-bottom, 0px) + 12px)'`；整屏高度的占位用 `minHeight: 'var(--shell-vh, 100vh)'`。
- **层级**：页面内容 < 状态条 `--z-topbar`(30) < 按键栏 `--z-nav`(40) < `.app-fill`(45) < 页面自己的浮层/对话框。账号弹层和命令面板 portal 到 `body`。
