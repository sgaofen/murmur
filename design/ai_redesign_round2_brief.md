# Murmur · AI 分析页改版 Round 2 — 给 Claude Design 的 brief

> **重要**：Claude Design 是 web 工具，不能上传 zip。我把所有源码放在 GitHub raw URL 里，下面每个文件的链接都能直接 fetch。

## 你之前给我什么（Round 1）

我已经把 Round 1 的 `AIAssistantDrawer.tsx` 落进了仓库的 `app/src/pages/AIAssistantDrawer.tsx`，并修了几个交付时的小坑：

- 你 import 了 `lucide-react`（项目没装这个包，我用你 demo 自带的 `icons.jsx` 改写成 `app/src/utils/icons.tsx` 的 React 组件）
- 你写 `const { displayName } = usePrivacy()`（实际上 Murmur 的 `usePrivacy()` 返回 `boolean`，`displayName` 是从 `'../utils/privacy'` 单独导入的函数）
- 你用了占位 `Friend` 类型（已切到真实 `data/types.ts` 的）
- 你把图标挂到 `window.Icons`（已改 React export）

落地后的源码在这里：

- **新建的 AIAssistantDrawer**: https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/pages/AIAssistantDrawer.tsx
- **新建的图标库**: https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/utils/icons.tsx

`RelationshipReportView` 我还**没落地**——你 Round 1 给的那个还是 `MOCK_REPORT_CHUNKS` 的演示版，没接真实的 `getInvokeStream` 流式 API。Round 2 我希望你帮我完成它。

## Round 2 想要你做的事

### 1. 把 `RelationshipReportView` 接到真实流式 API（核心）

旧版 `AgentReport`（要被替换）在这里:
https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/pages/extras/AgentReport.tsx

它现在用的是这个轮询模式（你需要保留这套真实数据流，把它套进你 Round 1 给的两栏视觉里）：

```ts
// 每 2 秒 poll 一次 — Murmur 没有 SSE，是 HTTP 轮询
useEffect(() => {
  let cancelled = false;
  async function tick() {
    const s = await getInvokeStream(friend.id);
    if (cancelled) return;
    setStream({ output: s.output, stage: s.stage, elapsed: s.elapsed });
    if (!s.running) {
      setPhase(s.error ? 'error' : 'done');
      // 完成后从 reports 目录拉最终报告
    }
  }
  tick();
  const id = setInterval(tick, 2000);
  return () => { cancelled = true; clearInterval(id); };
}, [friend.id]);
```

API 接口签名定义在:
https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/data/api.ts

具体看 `getInvokeStream`、`invokeAgent`、`getReport`、`findPairReport` 这几个函数。

`parseChapters` 在旧 AgentReport 里实现了，按 `## 1. 关系定性` 这种 markdown heading 切段——把那段抄过来。

### 2. **新功能：在报告顶端引用硬数据指纹（这次真的要做）**

用户反馈：现在的 AI 报告写得很泛、不引用具体数字。我已经在后端的 `build_analysis_pack` 里塞了一段「数据指纹」markdown 块，里面有：

- 总条数 / 活跃天数
- 你 vs 他主导比
- 最长连聊天数 + 起止日期
- 谁先开聊（按 6 小时间隔切会话）
- 深夜消息占比 + 深夜里他/你说话比例
- 中位回复时长
- 全年趋势（前半年 vs 后半年）
- 168 格热力图最高峰时段（取 top 3）
- 高频词

后端就在这里:
https://raw.githubusercontent.com/sgaofen/murmur/main/cli/etcli.py
（搜 `_yearbook_evidence_block`）

我希望 `RelationshipReportView` 顶部 Hero 区下方加一个 **"硬证据条"**——把这些数字抽出来做成一行紧凑的视觉条，类似:

```
最长连聊  12 天  ·  你主导  64%  ·  深夜偏向他  73%  ·  全年 ↑ 越聊越多
```

风格要克制：mono 字体的数字 + 衬线短词、用细分隔线，不要做成 dashboard。这是让读者**在 AI 散文之前先看到几个硬数字**，提供量感。

数据从哪里拿：API 已经在 `getYearbook(wxid)` 里返回了 `years[].midnight_friend_pct / longest_streak_days / initiative_self_pct / heatmap_24x7` 等字段，结构定义在:
https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/data/api.ts

你可以直接 fetch `/api/friend/{wxid}/yearbook`，挑 `years[years.length - 1]`（最新年）渲染。

### 3. **新功能：双人关系导出页（issue #10 闭环）**

这是 Murmur 的招牌——分析两个朋友之间的关系。后端已经有了 `/api/pair-export?a=&b=&format=json|html|txt` 端点，现在 Graph 页面的 pair drawer 里有一个三按钮 (`MD/JSON/HTML`) 的简陋导出条。

Graph 当前 pair drawer 长这样:
https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/pages/Graph.tsx
（搜 `function PairExportRow`）

我希望你把这个 pair drawer 的导出区设计得更"产品级"——参考 friend 页面的 ActionDock 风格，但要：

- 强调 **"这是 Murmur 独有的功能"**（市面没有别的工具能导出朋友 A 和朋友 B 之间的关系）
- 给三个格式各自一句说明（MD = 给在线 AI 用 / JSON = 脚本/自动化 / HTML = 离线归档）
- 加一个隐性教育：解释为什么 Murmur 能做到这点（你能看到他们俩共同的群、互相点赞的朋友圈、私聊里互相提及）

最好做成一个独立的小卡片/横条，在 pair drawer 顶部。

### 4. **新功能：年度报告 / 双人年代记 入口的封面页**

Yearbook 页面已经做得很丰富了（每年一张卡片 + 24×7 热力图 + 关键时刻引用 + 算法选中片段），但**入口很弱**——目前只能从 Friend 页底部 "💑 双人年代记" 按钮进去。

我希望你设计一个**单页可分享的"年度报告封面"**——
- 整页可截图分享到小红书
- 一屏内放最 viral 的 5 个数据点：最长连聊、第一次说话、总消息、最深夜的对话、关系画像一句话
- 极简、印章感、能让用户马上想 po 出去

当前 Yearbook 页面在这里（看视觉气质）:
https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/pages/Yearbook.tsx

## 视觉契约（仍然有效）

复用现有 tokens.css，全部变量在:
https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/tokens.css

颜色：cream paper `#f5f3ec` + 墨蓝 `#1a2b4a` + 暖珊瑚 `#FF6B47`（Round 1 你用了 `#e0532e`，我决定保留 BRIEF 原值；下次别擅自改）。
字体：宋体衬线（标题）+ JetBrains Mono（数字 / wxid）+ 系统无衬线（正文）。
**禁止**：emoji 主视觉、玻璃拟态、霓虹发光、紫/青/明黄。
**禁止**：引入 `lucide-react` 等新依赖——用我已经做好的 SVG 图标库（链接在最上面）。

## Murmur 项目其他重要源文件（你需要读的）

- 完整入口 (`Friend.tsx`)：https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/pages/Friend.tsx
- Graph 关系网（pair drawer 在这里）：https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/pages/Graph.tsx
- 类型定义：https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/data/types.ts
- 隐私 hook：https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/utils/usePrivacy.ts
- 隐私函数：https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/utils/privacy.ts
- Avatar 组件：https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/components/Avatar.tsx
- 现有印章/缎带/邮戳装饰件：https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/components/Stamp.tsx · https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/components/Ribbon.tsx · https://raw.githubusercontent.com/sgaofen/murmur/main/app/src/components/Postmark.tsx

## 交付预期

希望你产出：
1. `RelationshipReportView.tsx` —— 接真实 polling、顶部带硬证据条
2. `PairAnalysisPanel.tsx` —— 替换当前 Graph 里的 PairExportRow，做成产品级
3. `YearbookCover.tsx` —— 单页可分享封面
4. 各自的 README 写明「在 Friend.tsx / Graph.tsx 哪一行替换什么」

直接贴 .tsx 文本回来即可，我接到工程里。

## 不要做

- 不要重新设计已经做好的 `AIAssistantDrawer.tsx`（架构 OK 了）
- 不要动 `Yearbook.tsx` 的现有内容（24×7 热力图、年度卡片、签名段——保持不动）
- 不要引入图标库
- 不要把 BRIEF 的色值换掉（`#FF6B47` 是约定值）
