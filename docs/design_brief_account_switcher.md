# Design brief — Murmur 账号切换器（v0.3.0 唯一新视觉组件）

> 给 claude-design 的输入。
>
> Murmur 加 QQ 支持后，**100% 复用现有页面/AI/分析/关系图**——只换数据源不换 UI。
> 所以**只需要新设计 1 个组件**：账号切换器。
> 这个 brief 的目标就是把这一个组件做到位，配色 / 字体 / 阴影 / 圆角全部对齐现有 Murmur 设计语言。

---

## 调研结果（你不需要重做的部分）

为给设计师明确边界，列出**绝对不能动**的现有页面和它们的设计：

| 页面 | 文件 | 现有设计要素 |
|---|---|---|
| 首页 | `Home.tsx` | HeroFrame（Top 5 朋友 No.1-5 卡片）+ Timeline 时光线 + FilterBar + FriendCard 矩阵 |
| 朋友档案 | `Friend.tsx` | 离线信号矩阵 + 朋友圈卡片 + 媒体画廊 + AI 报告 + 双人年代记入口 |
| 关系网 | `Graph.tsx` | 3D 力学图 + tier 分层 + 边类型（mutual_reply / mention / co_group / moments_cross）+ 批量分析面板 |
| 报告中心 | `Reports.tsx` | friends/ + pairs/ 两栏 markdown 列表 |
| 年代记 | `Yearbook.tsx` | 按年滑动 + 6 类引用（vulnerability / offline / lifecycle / apology / care + signature line） |
| 信号表 | `OfflineSignalsTable.tsx` | 全局排序表，所有信号字段一行显示 |
| 隐私 toggle | 右下浮动 chip | `PrivacyToggle.tsx` 现有样式 — 切换器和它视觉风格保持一致 |

**这些页面 v0.3.0 完全不动，QQ 数据通过 backend store 切换透明喂入。**

---

## 唯一新组件：`<ProfileSwitcher />`

### 出现在哪

每个页面顶部 chrome bar 的左侧（Murmur logo 右边、原 `2026 · 年代记` 灰字附近）。所有页面共用同一个组件。具体页面：

- `Home.tsx` 的 `HomeChromeBar`（line 26-100）：现在第 38 行有 `Murmur 微语` logo + line 40 灰字 `2026 · 年代记`，新切换器替换 / 紧贴这一区
- `Friend.tsx`、`Graph.tsx`、`Reports.tsx`、`Yearbook.tsx`、`OfflineSignalsTable.tsx` 顶部都有"← 返回 + 页面标题"chrome — 切换器放在标题左侧或右侧，**收起态紧凑、不抢戏**

### 视觉要求

#### 收起态

紧贴现有 chip 风格（参考 `<PrivacyToggle />`、`HomeChromeBar` 里的 🌌关系网/📑报告 链接）：

```
[💬 wxid_n…97a5  ▾]    或    [🐧 QQ 939…010  ▾]
```

- 高度 26-30px，padding `5-7px 10-12px`
- 背景：`var(--et-orange-soft)`（活跃感）或 `var(--et-paper)` 描边款
- 圆角：`999px`（pill）
- 字体：sans-serif 11-12px 500 weight
- 平台图标：emoji（💬/🐧）或精致 SVG（参考 logo 同级精度）
- 用户名经过 `maskText()` 脱敏（隐私模式下尤其需要）
- 右侧 ▾ 三角微小，10-11px

**当前激活的平台 + 账号**用色彩区分：微信 → 橙 (`var(--et-orange-2)` 或 `--et-orange`)；QQ → 蓝绿色（QQ 品牌色但克制，比如 `#3878a5`），但要和 Murmur 调性融合，**别太亮**。

#### 展开态（点击后浮层）

向下浮出一个卡片，浮在所有内容之上：

```
┌─────────────────────────────────────┐
│ 你的账号                             │
├─────────────────────────────────────┤
│ ✓ 💬 wxid_n…97a5    今天          │  ← 当前激活，橙色背景或高亮边
│   12,847 条消息 · 3 个 AI 报告      │
├─────────────────────────────────────┤
│   🐧 QQ 939…010     昨天          │
│   16,131 条消息 · 已就绪            │
├─────────────────────────────────────┤
│   🐧 QQ 358…864     —             │
│   未解密 · 点击设置                  │  ← 浅色，需要解密的态
├─────────────────────────────────────┤
│   ＋ 添加新账号                      │
└─────────────────────────────────────┘
```

- 宽度：240-280px
- 卡片背景：`var(--et-paper)` + `var(--et-shadow-2)` 阴影
- 边：`0.5px solid var(--et-line-2)`
- 圆角：`var(--et-r)` (8px)
- 顶部"你的账号"小标题用 `et-eyebrow` 类（`var(--et-mute)` 灰色 + 字间距）
- 每行账号：
  - **激活态**: 左边 ✓、右边轻微橙色背景 / 左边一根 3px 橙色 ribbon、整行 `var(--et-paper-2)`
  - **未激活态**: 普通行
  - **未解密态** (state='needs_decrypt')：行整体 50% 透明度 + 右下角小灰字"未解密 · 点击设置"
  - **正在抓 key 态** (state='extracting')：右侧小转圈 spinner
- 行内布局：图标 + 主行（账号 ID + 时间） + 副行（消息数 + 状态）
- 时间：今天 / 昨天 / 3 天前 / 1 个月前 / `2025-08-29` —— 用相对时间，复用 `_humanise_last` 风格
- 鼠标悬停某行：`var(--et-paper-2)` 高亮
- 底部"＋ 添加新账号"分隔线后单独一行，灰色文字加普通图标，不抢眼

### 交互行为

1. 默认收起，悬停或点击展开
2. 点击展开态某账号 → 浮层关闭、调用 `onSwitch(id)`、main UI 自动重渲染（数据来源切了，所有现有页面正常加载新平台数据）
3. 点击未解密账号 → 弹 confirm "需要先解密这个账号，跳到引导？" → 跳到 onboarding 对应平台
4. 点击 "＋ 添加新账号" → 弹一层小菜单选 [微信] / [QQ] → 跳到对应 onboarding
5. 浮层 esc / 点外面关闭

### 隐私要求

- 默认所有 ID 都 `maskText()` 脱敏（保留首末 4 字符、中间 …）
- 隐私模式开启时（`PrivacyToggle.tsx` 里的全局 state）保持脱敏；关闭时显示完整
- hover 整行不展开完整 ID（避免侧录）—— 完整 ID 只在 tooltip 里、且仅在隐私关闭时

---

## 数据 shape（后端会给）

```typescript
export interface ProfileEntry {
  id: string;                          // 'wxid_n0cir36u32si12_97a5' or 'qq:939919010'
  platform: 'wechat' | 'qq';
  display_id: string;                  // 'wxid_n…97a5' or 'QQ 939…010'  (已脱敏)
  msg_count: number | null;            // 12847; null if not yet decrypted
  ai_report_count?: number;            // optional, only for ready profiles
  last_active_ts: number | null;       // unix sec; null if unknown
  state: 'ready' | 'needs_decrypt' | 'needs_key' | 'extracting';
  is_active: boolean;
}

interface Props {
  profiles: ProfileEntry[];
  active_id: string;
  onSwitch: (id: string) => void;
  onAddNew: (platform: 'wechat' | 'qq') => void;
}
```

---

## 现有 Murmur 设计语言（CSS tokens 必须复用）

```css
/* 颜色 */
--et-orange:      #e0532e        /* 主橙，激活/品牌 */
--et-orange-2:    #c93f1a        /* 深橙，文字色 */
--et-orange-soft: rgba(255,107,71,0.08)
--et-paper:       #f8efdc        /* 背景纸张暖白 */
--et-paper-2:     更深一档（approx #f0e6cf）
--et-ink:         #2a2520        /* 主文字 */
--et-ink-soft:    略弱
--et-mute:        灰文字
--et-faint:       更浅灰
--et-line:        浅细线
--et-line-2:      稍深细线
--et-rose:        warning / error
--et-bg:          整页底色

/* 间距 / 圆角 */
--et-r:     8px
--et-r-lg:  16px

/* 阴影 */
--et-shadow-1:  极轻
--et-shadow-2:  中等
--et-shadow-3:  深、用于浮层

/* 字体 */
--et-serif:  衬线（标题）
--et-sans:   无衬线（正文 / chip）
--et-num:    数字字体（msg count）
--et-mono:   等宽（用于 ID / 路径）
```

整体调性：**怀旧杂志风、克制、纸张感、不浮夸**。参考组件：

- `app/src/components/PrivacyToggle.tsx` —— chip 视觉
- `app/src/components/Postmark.tsx` —— 邮戳式装饰
- `app/src/components/Ribbon.tsx` —— ribbon 高亮
- `app/src/components/FriendCard.tsx` —— 卡片排版
- `app/src/components/Avatar.tsx` —— 圆形 + 色彩 hash

---

## 交付物

1. `app/src/components/ProfileSwitcher.tsx` —— React 组件，TypeScript，遵循 Murmur 现有命名风格
2. `docs/screenshots/profile-switcher-collapsed.png` —— 视觉稿（收起态）
3. `docs/screenshots/profile-switcher-expanded.png` —— 视觉稿（展开态，含 3 个不同状态账号）
4. （可选）补充 CSS 变量 / 动画

**完成度判断**：把组件 mount 到 HomeChromeBar 后，看着像 Murmur 自己长出来的功能、不是外加的、不抢戏；切换平台时整个 UI 平滑过渡、不闪屏不报错。

---

## 不要做（重要）

- ❌ 不要重新设计任何**已有**页面 / 卡片 / 报告样式
- ❌ 不要为 QQ 单独做一套页面 / 视觉变体（QQ 数据走现有微信全套 UI）
- ❌ 不要在切换器里塞分析功能 / 消息搜索 / 二级菜单 —— 它**只是切换器**
- ❌ 不要破坏隐私模式 —— 默认 mask
- ❌ 不要大改顶栏布局 —— 只在现有 chrome 里塞这一个 chip
