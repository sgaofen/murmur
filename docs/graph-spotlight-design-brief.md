# 关系网核心圈 / 桥梁可视化 — Design Brief

## 给设计 AI 的一句话目标

Murmur 关系网图（3D 力导图）后端已经算好了「核心圈」和「桥梁人物」，前端有完整的数据通道但**没有任何视觉呈现**。请设计并实现两个交互式聚焦视觉：

1. **核心圈聚焦**：用户能选一个核心圈，图上明确呈现该圈包了哪些人、长什么形状
2. **桥梁聚焦**：用户能选一个桥梁人，图上明确呈现 ta 连接的两个不同群体 + 连接关系

## 仓库 + 当前 commit

- GitHub：https://github.com/sgaofen/murmur
- 当前 main 分支 HEAD：`0844b83`（"GraphView: real core-circle + bridge detection"）
- 关键文件：
  - `app/src/components/extras/GraphView.tsx` — 关系网 SVG 组件（要改的主战场）
  - `app/src/pages/Graph.tsx` — 页面入口 + layout
  - `cli/etcli.py` — 后端拓扑算法 `_compute_friend_topology`（**不要改**）

## 后端算法（已实装，不要改）

`cli/etcli.py` 里 `_compute_friend_topology(nodes, edges, contacts)`：

- **核心圈**：加权 label-propagation 跑在「朋友 ↔ 朋友」子图上（去掉 self），≥3 人才算一个圈，圈名 = 度最高成员的名字 + " 这一圈 (N 人)"
- **桥梁**：Brandes betweenness centrality（BFS-based, undirected），top 12% 朋友，卡在 [2, 8] 之间

API：`GET /api/graph?scope=private&top_n=80`

返回（已型化在 `Graph.tsx`）：

```ts
interface BackendNode {
  id: string; wxid: string; name: string;
  is_self: boolean;
  tier: 'self' | 'A' | 'B' | 'C' | 'D' | 'E';
  size: number;
  combined_score?: number;
  cluster?: string | null;   // "core_1" / "core_2" / ... 或 null
  bridge?: boolean;          // 是否桥梁
  // ...
}
interface BackendCluster {
  id: string;          // "core_1"
  label: string;       // "太の 这一圈 (11 人)"
  members?: string[];  // 成员 wxid 列表
}
interface BackendStats {
  core_circles?: number;  // 核心圈总数
  bridges?: number;       // 桥梁人数
}
```

测试数据（开发者本人，可重现）：81 朋友，230 朋友间边，9 核心圈（3-13 人），3 桥梁（kevin / Alex Zhang / SHY）。

跑后端拿真实 payload：
```
python cli/etcli.py serve --port 9101
curl 'http://127.0.0.1:9101/api/graph?scope=private&top_n=80' | python -m json.tool
```

## 前端当前状态（关键 — 默认画布是干净的）

`GraphView.tsx` 现在：

- ✅ `GraphNode` 已有 `cluster?: string | null` 和 `bridge?: boolean`
- ✅ `GraphCluster` 已有 `id / label / members?` (cx/cy/cz/color/n 是 legacy 可选)
- ✅ `GraphData.clusters` 从 backend 流过来，是 `[{id, label, members}]` 数组
- ✅ `GraphData.stats.clusters` 和 `.bridges` 是计数（数字显示在右下角 OverviewPanel）
- ❌ **默认渲染：完全不画 cluster halo，不画 bridge 标记，节点纯 tier 色**
- ❌ 没有 spotlight 状态、没有点击交互、OverviewPanel 数字不可点

`OverviewPanel`（在 `GraphView.tsx` 底部）有 4 个 `<Stat>`，其中两个：
- 「9 个核心圈」(stats.clusters)
- 「3 个桥梁人物」(stats.bridges)

目前是纯展示数字，无交互。

## 用户的视觉要求（曾尝试过几次都没满足）

> 「核心圈应该把圈内的人**包裹起来，每个人**」 — 指向 metaball 风格，每人外面有一个球，球之间熔合，但**不是凸包**（凸包不贴合每个人）

> 「桥梁要用不同的颜色包裹不同的群体，然后把桥梁的那两条线高亮处理」 — 桥梁聚焦时画两个不同色 metaball + 两条粗高亮线连桥梁与各群代表

> 用户说过的禁忌：
> - 不要硬圆（hardcoded `<circle>` 套人）
> - 不要凸包（hull）
> - 不要把整张图都遮黑
> - 颜色区分要明显（不要用 HSL hash，色相会贴近 — 用 hand-picked 高饱和调色板）
> - 默认状态要干净，不要任何高亮或包裹（**这点用户已经验收，回退过 1 次，不要再破坏**）

## 设计要求

### A. 核心圈聚焦（用户点「9 个核心圈」 → 列表 → 选一个）

**视觉**：metaball 软体 blob 包住该圈所有成员（凸出每个人的位置），3D 立体感（gradient / shadow / blur 多层叠加），独特高饱和颜色（避免与 tier 色撞）。其他人 + 边都暗下去。

**实现思路**（推荐 SVG metaball）：

```tsx
<defs>
  <filter id="metaball-CLUSTERID">
    <feGaussianBlur in="SourceGraphic" stdDeviation="14" />
    <feColorMatrix mode="matrix" values="
      1 0 0 0 0
      0 1 0 0 0
      0 0 1 0 0
      0 0 0 22 -10" />
  </filter>
</defs>
<g filter="url(#metaball-CLUSTERID)">
  {members.map(n => (
    <circle cx={n.proj.x} cy={n.proj.y} r={nodeSize + 14}
      fill={clusterColor} fillOpacity={0.55} />
  ))}
</g>
```

模糊 + 阈值化 alpha → 接近的圆熔合成一团。每人外面凸出一个鼓包，整体连成有机形状。

3D 感可加：第二层略偏移高光、drop-shadow、或 inset radialGradient。

### B. 桥梁聚焦（用户点「3 个桥梁人物」 → 列表 → 选一位）

**视觉**：
- 找到桥梁连接的最大两个 cluster（按桥梁邻居所在 cluster 的成员数排）
- 两个 metaball blob，**不同色**
- **两条粗高亮线**：桥梁人物中心 → 各自圈内跟 ta 连接最强的那个人（按 edge weight 取最强）
- 桥梁本人用脉冲 / 描边 / 发光强调

### C. 颜色系统

**不要 HSL hash**（贴近 / 撞色）。用 hand-picked 调色板（10-12 色），按 cluster id hash 进 palette index。建议：

```ts
const CLUSTER_PALETTE = [
  '#E63946', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA',
  '#00897B', '#E91E63', '#FBC02D', '#3949AB', '#7CB342',
];
```

这些色任意两个对比度足够。同时 dark mode + light mode 都要可读。

### D. 交互流程（建议）

1. 用户点 OverviewPanel 里的「9 个核心圈」数字 → 弹出居中列表，按成员数从大到小排，点一个 → 进入核心圈聚焦
2. 用户点「3 个桥梁人物」数字 → 弹出列表，按连接朋友数从大到小排，点一位 → 进入桥梁聚焦
3. 进入聚焦后：顶部 banner「正在看：xxx 这一圈」 + × 退出
4. 退出方式：点 × / Esc / 再点列表里同一项

### E. 不要做

- 不要硬圆 / 凸包
- 不要 framer-motion 等第三方动画库（保持 SVG 原生）
- 不要破坏现有 3D 拖拽旋转 / 触控板缩放 / 自动旋转
- **不要在默认状态下加任何高亮或包裹** — 用户验收过的 baseline，是 0 视觉
- 不要改后端、不要引新依赖

## 现有文件参考点

- `GraphView.tsx:38` — `GraphCluster` 类型（id/label/members + 可选 legacy 字段）
- `GraphView.tsx:7` — `GraphNode` 类型（已有 cluster/bridge）
- `GraphView.tsx:932` — `OverviewPanel` 函数 + Stat 组件，把数字改成可点
- `GraphView.tsx:587` — `<defs>` 结尾 + 渲染入口（在这里插 metaball filter / cluster blobs）
- `GraphView.tsx:587-606` — Legacy cluster halo 块（用 c.cx，已加 typeof guard，不渲染。可以删除或留作参考）
- `Graph.tsx:128` — designClusters 已 map backend clusters 过来

## 验收标准

1. 默认打开关系网：画布干净，只有 tier 色节点 + 边，无任何 cluster/bridge 视觉
2. 点「9 个核心圈」数字 → 出现居中列表（9 项，从大到小）→ 点一项 → 该圈被 metaball blob 包住，颜色独特，每个人附近凸出，3D 立体感
3. 点「3 个桥梁人物」数字 → 出现居中列表（3 项）→ 点一位 → 两个不同色 blob 出现，桥梁人物在中间，两条粗高亮线从桥梁延伸到两个 blob 内的代表
4. 旋转 / 缩放 / 拖拽图：blob 跟随节点位置平滑重绘，不闪烁
5. 退出聚焦：恢复到验收标准 1 的状态

## 备注

- 用户在 Windows 笔记本（trackpad，无鼠标滚轮）
- WebView2 缓存路径 `~/AppData/Local/com.sgaofen.murmur/EBWebView` —— 改完代码 build + reinstall 后必须清，否则用户看到的是缓存
- Build: `cd app && npm run tauri:build`
- Install: `Murmur_0.3.17_x64-setup.exe /S` 静默安装
