# Murmur · AI 分析页 改版 Brief（给 Claude Design）

## 背景

Murmur 是一个本地化微信/QQ 聊天可视化与 AI 关系分析工具。
现在的「导出 AI 分析包」对话框（`AIExportDialog.tsx`）+「本机 AI 助手选择」面板（`LocalAgentPanel.tsx`）+「AI 报告查看页」（`AgentReport.tsx`）三段视觉割裂、信息密度过高，用户反馈「很山寨」。

需要一个**新的、克制的、能体现『本地 AI / 私密』气质**的 AI 分析入口设计。

## 当前问题（按重要性排）

1. **三步骤层叠对话框**（① 选 AI → ② 时间范围 → ③ 分析侧重 → 生成 → Step 2 文件操作）信息过载，每一步又有大量 chip / radio / checkbox 混排，视觉破碎。
2. **"本机检测到 N 个 AI" 横幅**用了橙色渐变 + emoji ✨ + 圆点 + 引号短句，过于"营销话术"，跟整站 magazine 风格冲突。
3. **顶部 6px 橙色 ribbon + 关闭 X + eyebrow + h2** 元素堆叠，每个对话框都重复一遍这套 chrome。
4. **生成完成后 Step 2 的三个 ActionRow**（绿/黄/蓝圆点 + 按钮）像营业大厅取号机，跟"私密档案"语气不符。
5. **AgentReport.tsx**（命令运行流式输出）目前是黑屏 monospace 直出，看着像调试日志，不像产品级 UI。

## 设计目标

- **一屏完成**：从"想分析这个朋友"到"分析包就绪"应在一个连续视图里，不要二级 modal。
- **去 emoji / 去渐变**：保持站内 magazine 氛围（cream paper + 墨蓝 ink + 暖珊瑚 orange，窄字距，serif 标题）。
- **本地优先暗示**：用排版而非配色强调"本地、不联网、私密"。
- **进度可视**：AI 跑命令时给用户一个有耐心看的进度区，而不是滚动 stdout。

## 视觉系统（保持不变）

复用 `app/src/tokens.css`：
- 主色：`--et-orange #FF6B47`、`--et-orange-soft`、墨蓝 `--et-ink #1a2b4a`、cream paper `--et-paper`
- 字体：Songti / Noto Serif SC 衬线 + JetBrains Mono 等宽 + 系统无衬线正文
- 圆角：8 / 12 / 16
- 阴影：极淡 `0 1px 0` / `0 6px 16px rgba(...)` 不要发光

## 信息架构（建议）

### Step 0 入口（在 Friend.tsx 里）
现状是底部 ActionDock 的 "🤖 导出 AI 分析包" 按钮。
**保持**：仍然是单按钮，但去掉 emoji，改为类似杂志 callout 的小按钮（"让 AI 读这一段关系 →"）。

### Step 1 设置 + 生成（一个长 panel，不是 modal）

**布局：滑入（slide-in from right）的 480px 抽屉**，不要居中 modal。
- 顶部 chrome：朋友头像缩略 + 名字 + "AI 分析" eyebrow，**单行**（不要 ribbon + 关闭 + eyebrow + h2 四件套）。
- 主体一个垂直长列：
  - **A. 选谁分析**：检测到的本机 AI 排成卡片网格（2 列 × N 行），每个卡片只放：图标（用线性 SVG 而不是 emoji）+ 名字 + 一行说明 + 单击即选。**不要**用单选圆点 + 引号 + 渐变背景。
  - **B. 数据范围**：3 个 inline pill（最近一年 / 全部 / 自定义），不要 radio + sub-text 行。
  - **C. 分析侧重**：6 个紧凑 chip，可多选。**不要**为每个 chip 配 hint 副文。Hint 用 tooltip 或 chip 上单击展开。
  - **D. 生成按钮**：底部固定一行，主按钮 + 取消按钮。

### Step 2 进度

**生成过程不要切到 step 2**，直接在 step 1 抽屉的底部叠加一个进度区：
- 顶部一行 inline 状态："正在生成… 12s"
- 中部一个慢速打字动画显示 AI 当前 stage（"读取消息" → "提取关键时刻" → "生成画像"），最多 3 行
- 底部进度条不用百分比，用一条无尽 shimmer 表示"还在跑"

### Step 3 完成

抽屉滑回，朋友页主区域顶端出现**一条 cream/orange 横幅**：
- 一句话："给 {friendName} 的关系档案已就绪 · 1.4 KB"
- 三个文字链接（不是 button）：「打开文件位置」「复制全文」「让 AI 直接分析」

### AgentReport（流式输出页）

**完全重做**为一个分两栏的"读报"视图：
- **左栏 30%**：当前进度的 stage 列表（已完成的勾起来，正在跑的高亮，未到的灰）
- **右栏 70%**：AI 流式输出区，但**不要 monospace 黑底**。用 serif 字体 + cream 背景渲染，像在读杂志。每生成一段，淡入显示。
- 顶部 chrome：朋友头像 + 名字 + "AI 关系档案 · 草稿"，右上角"导出 / 重新分析"两个按钮。

## 不要做的

- ❌ 不要再用 emoji（🤖 ✨ 📤 📖 💑）作主视觉，用 1.5px stroke 线性 SVG 替代
- ❌ 不要 ribbon + 渐变背景
- ❌ 不要弹窗叠弹窗
- ❌ 不要 stdout 黑底输出，把它当成产品而不是终端

## 数据 / 接口（无需改后端）

抽屉里要消费的接口已经全在 `app/src/data/api.ts`：
- `getAgents()` → 列出本机 AI
- `generateAIPack(id, { sample })` → 生成
- `invokeAgent({ cli, wxid, sample })` → 调用本机 AI
- `getInvokeStream(wxid)` → 拉流式输出
- `getReport(relPath)` → 读最终报告
- `openFolder(path)` → 打开 Finder/Explorer

## 现有源文件

- `app/src/pages/AIExportDialog.tsx`（357 行，整体替换）
- `app/src/pages/extras/LocalAgentPanel.tsx`（118 行，可整合进上面）
- `app/src/pages/extras/AgentReport.tsx`（流式输出页，整体重做）

## 交付

希望产出：
1. 一个新的 `AIAssistantDrawer.tsx`（抽屉式 step 1+2+3），替换 `AIExportDialog`
2. 一个新的 `RelationshipReportView.tsx`（两栏读报视图），替换 `AgentReport`
3. 复用现有 tokens.css，不要新引入字体或图标库
