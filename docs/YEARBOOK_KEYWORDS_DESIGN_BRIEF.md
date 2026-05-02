# Yearbook 新增模块设计 brief

给 Claude Design：这份只针对 `YearbookPage` 里我刚新增的「年度高频词 + 代表片段 + 选择依据」区域，不是全站重做。

## 背景

Murmur 的「双人年代记」页面按年份展示用户和某位朋友的聊天关系。每个年份卡片已经有这些信息：

- 年份、消息总数、活跃天数
- 主导比、最热月、最长沉默、深夜聊天比例
- 若干主题证据：脆弱表达、线下证据、人生节点、冲突修复、互相关心
- 通话次数 badge

我新增了两个数据层功能：

1. `top_words`: 这一年的高频词统计，用来帮助用户快速看出这一年在聊什么。
2. `signature`: 这一年的代表片段，不再用「最长消息」，而是用可读性、是否含高频词、是否在来回对话附近、是否命中线下/关心/人生节点等信号打分。

当前功能对，但 UI 很粗糙，需要重新设计。

## 当前问题

- 高频词现在只是普通 chip 堆叠，信息密度不舒服，视觉上像 debug 输出。
- 代表片段和下面的主题证据都像同一种文本块，没有层级。
- `选择依据` 很有用，但现在像脚注，缺少可信度表达。
- 高频词 count 现在裸露在 chip 里，阅读节奏差。
- 一年卡片内容变多后，纵向很长，扫读压力大。
- 不要把「代表片段」做成特别煽情的大 quote，它只是算法挑出来的一个入口，不一定能代表全部关系。

## 需要保留的信息

每个 `YearData` 增加字段：

```ts
interface YearData {
  year: number;
  msg_count: number;
  active_days: number;
  self_pct: number;
  busiest_month: number;
  busiest_month_msgs: number;
  longest_silence_days: number;
  silence_from: string | null;
  late_night_msgs: number;
  late_night_pct: number;
  calls: number;

  top_words?: Array<{ word: string; count: number }>;
  signature: {
    date: string;
    from: string;
    text: string;
    reason?: string;
    terms?: string[];
  } | null;

  vulnerability_quotes: Array<{ date: string; from: string; text: string }>;
  offline_quotes: Array<{ date: string; from: string; text: string }>;
  lifecycle_quotes: Array<{ date: string; from: string; text: string }>;
  apology_quotes: Array<{ date: string; from: string; text: string }>;
  care_quotes: Array<{ date: string; from: string; text: string }>;
}
```

字段含义：

- `top_words`: 主题线索，不是精确 NLP 标签。适合叫「常聊词」「年度词频」「这一年的关键词」。
- `signature.text`: 算法筛出的一个片段。适合叫「代表片段」「被算法选中的一句」「年度切片」，不要叫「最重要的一句话」。
- `signature.reason`: 为什么挑中它，例如「含年度高频词：X」或「线下/一起做事」。
- `signature.terms`: 命中的高频词，可以作为小标签放在片段旁。

## 建议设计方向

### 方案 A：紧凑横向模块

在年份基础 stats 下方做一个两栏区域：

- 左侧：`关键词云`
  - 只显示 top 6-8 个
  - count 不要喧宾夺主，可以用 opacity 或小号数字
  - 词频高低用轻微字号/粗细差异，不要彩虹色
- 右侧：`代表片段`
  - 文本块最多 2-3 行
  - 下方一行 metadata：说话人 · 日期 · 选择依据
  - 如果有 `terms`，以很小的 token 显示在 metadata 旁

适合桌面端，扫读效率高。

### 方案 B：年度摘要条

在 stats 和证据之间插入一条「这一年的主题」：

```
这一年常聊：AI、游戏、学校、朋友
算法选中的片段：……
依据：含年度高频词「AI」
```

这个方案更像阅读型页面，视觉负担小。

### 方案 C：可折叠详情

默认只显示：

- top 4 关键词
- 一句代表片段 preview

点击「展开这一年」后再显示完整 top 10 和主题证据。适合很多年份或消息特别多的人。

## 交互要求

- 不要让新增模块抢走年份数字和核心 stats 的主视觉。
- 高频词 hover 可以显示 `出现 N 次`，但不是必须。
- 代表片段如果太长，默认 clamp 2-3 行。
- `选择依据` 要像「算法解释」而不是普通正文。
- 移动端不要做两栏，改为上下堆叠。
- 不要把 chip 做得太圆太糖果化；Murmur 是私人档案，不是社交媒体标签页。

## 视觉约束

- 避免大面积奶油/米色堆叠卡片，因为当前页面已经偏纸张风，新增模块再做纸卡会显得臃肿。
- 避免彩色词云。最多用一种 accent 色 + 中性色。
- 不要使用表格。
- 不要用解释性大段文字教育用户算法怎么工作。
- 不要暴露 wxid、真实聊天原文作为设计稿示例。mock 文案用：
  - `朋友 A`
  - `某个高频词`
  - `一段代表片段示例`

## 代码位置

- 页面：`app/src/pages/Yearbook.tsx`
- 类型：`app/src/data/api.ts`
- 后端数据：`cli/etcli.py` 的 `friend_yearbook()`
- API：`GET /api/friend/:wxid/yearbook`

目前新增 UI 在 `Yearbook.tsx` 的 `YearCard` 里，位于 inline stats 后、signature quote 前。Claude Design 可以直接重做这段 JSX，不需要改后端。

## 我建议的目标

把这一块做成「一眼看懂这一年主题」：

- 高频词负责回答：这一年主要聊什么？
- 代表片段负责回答：有没有一句可以把人带回当时？
- 选择依据负责回答：为什么算法选它？

这三个问题要形成一个轻、稳、可扫读的模块，而不是一堆标签和文本块。
