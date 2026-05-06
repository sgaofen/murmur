# Claude Design Round 1 — 审计 + 选择性采纳计划

**日期**: 2026-05-05
**输入**: `design/claude-design-output/gg/project/out/{AIAssistantDrawer.tsx,RelationshipReportView.tsx,README.md}`
**用户反馈**: "UI 变动挺大、热力图其他分析没有加入、请适量添加"

## 总评：架构方向对 → 实现细节多处不能直接落地

| 评分维度 | 评价 |
|---|---|
| 视觉气质 | ✅ 保留 cream + ink + orange，去掉了所有 emoji，加了 paper-grain + letterpress 内框 |
| 交互架构 | ✅ 抽屉替代层叠 modal、两栏读报替代 stdout 黑屏 — **核心进步** |
| 视觉契约 | ✅ BRIEF 里 11 条要求逐条落点，README 里有对照表 |
| 可直接 import | ❌ 多处不能 — 见下表 |

## 不能直接采纳的具体问题

| # | 问题 | 影响 |
|---|---|---|
| 1 | **新增 `lucide-react` 依赖** —— BRIEF 明确说"不要引入图标库"，CD 自行违反 | 需切换成 CD 自己提供的 SVG 备选（demo/src/icons.jsx） |
| 2 | **`usePrivacy()` API 用错** —— CD 写 `const { displayName } = usePrivacy()`；Murmur 的 `usePrivacy()` 返回 `boolean`，`displayName` 是从 `'../utils/privacy'` 单独导入的函数 | 直接 paste 会 runtime crash |
| 3 | **Avatar import 路径错** —— CD 写 `from './Avatar'` 假定文件放 `components/`；放 `pages/` 时应为 `'../components/Avatar'` | TS 编译失败 |
| 4 | **`Friend` 类型自己定义** —— CD 用 `{ id, name, bond, hue, glyph }` mock；Murmur 真实 `Friend` 在 `data/types.ts`，多很多字段 | 类型不匹配 |
| 5 | **`window.Icons` demo glue** —— CD 把图标挂到 window，是 demo 间共享的临时方案 | 真实 React 项目里这种全局污染必须清掉 |
| 6 | **`MOCK_REPORT_CHUNKS` 没接真 stream** —— RelationshipReportView 完全是模拟数据；CD 注释了 `useInvokeStream` 但 Murmur 没有这个 hook，只有 `getInvokeStream` 异步轮询函数 | 要写自己的轮询 effect |
| 7 | **token 颜色微调** —— CD 用 `#e0532e`（更印章感），BRIEF 是 `#FF6B47`（亮一点） | 选一个全局替换 |

## 用户提到"热力图其他分析没加进来"

热力图 / 最长连聊 / 谁先开聊 / 全年趋势 这些是上一轮我加进 **Yearbook 页**的指标，不在 AI 分析页里。
两种解读：
- **A**: 用户希望 AI 报告里**引用这些数据**（"你和他最长连聊 12 天"、"深夜里 73% 你在说话"）
- **B**: 用户希望 AI 分析页本身也展示这些指标

A 的实现路径是改后端 `generateAIPack()` 把 yearbook 指标放进 prompt 喂给 Claude/Codex；UI 不动。
B 的实现路径是 RelationshipReportView 顶部加一行"硬证据条"。

**我的判断是 A**——AI 报告应该是"读了这些数据后写的散文"，把数字当散文素材。我会在 Round 2 brief 里专门让 CD 处理这个。

## 选择性采纳清单

### ✅ 直接采纳（视觉/交互架构）
- 抽屉式 slide-in（替代 modal 层叠）
- 单行 chrome（friend 头像 + eyebrow + 关闭，不要 ribbon 四件套）
- AgentGrid 2 列卡片 + 线性 SVG 图标
- RangePills 三颗 inline pill
- FocusChips 紧凑 chip + tooltip hint（去副文）
- ProgressPanel 5 个 stage 节点 + shimmer 进度条 + 慢速 stage typewriter
- ReportReadyBanner（橙色边 + 三个 text link）
- RelationshipReportView 两栏布局（stage 左 / serif 报文右）
- Magazine 风格 hero（letterpress 双线、"第 N 期"）
- Chapter 章节 typewriter 注入

### ❌ 不采纳/必须改
- `lucide-react` 依赖 → 改成 inline SVG（用 CD demo 自己提供的）
- `window.Icons` 全局 → React export
- `usePrivacy()` 解构 → Murmur 真实 API
- Mock Friend type → 用 `data/types.ts`
- `MOCK_REPORT_CHUNKS` → 真 `getInvokeStream` 轮询
- `'./Avatar'` → `'../components/Avatar'`

### 🟡 推迟（让用户决定）
- `#e0532e` vs `#FF6B47` 橙色色值
- 是否真要全部替换 AIExportDialog + AgentReport（先并存，让用户用着看）

## 落地步骤
1. 新建 `app/src/utils/icons.tsx`（采纳 CD 的 SVG 集，去掉 window.Icons）
2. 新建 `app/src/pages/AIAssistantDrawer.tsx`（采纳 CD 架构，所有 import/类型/hook 改成 Murmur 真实）
3. 新建 `app/src/pages/extras/RelationshipReportView.tsx`（采纳两栏布局，接 `getInvokeStream` 轮询）
4. `Friend.tsx` 切换 entry point 到新组件，旧 `AIExportDialog` / `AgentReport` 保留作为 fallback
5. 写 Round 2 brief 给 CD（含 GitHub raw URLs，让它能直接读 Murmur 当前源码）
