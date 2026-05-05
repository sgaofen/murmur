# 关系网核心圈 / 桥梁可视化 — Design Brief

## 给设计 AI 的一句话目标

Murmur 关系网图（3D 力导图）需要两个交互式的"聚焦"视觉效果，目前都做得很差。请重新设计：

1. **核心圈聚焦**：用户点击右下角面板里的某个核心圈名字（例如「太の 这一圈 (11 人)」），图上要清楚地显示这个圈包了哪些人、长什么形状
2. **桥梁聚焦**：用户点击桥梁人物的名字（例如「kevin」），图上要清楚地显示 kevin 连接了哪两个不同的群体、用什么连接

---

## 项目结构

- 技术栈：Tauri 2.x + React + TypeScript + SVG（没有 force-graph、d3 等第三方图库，纯手写）
- 关系网组件单文件：`app/src/components/extras/GraphView.tsx`（1100+ 行）
- 关系网页面入口：`app/src/pages/Graph.tsx`
- 后端拓扑算法：`cli/etcli.py:_compute_friend_topology`（label propagation 找核心圈，Brandes 算桥梁）
- 当前 commit：`b0b484a` — 之前的 hull-wrap 尝试已 revert

## 数据接口（已定型，不要改）

后端 `/api/graph?scope=private&top_n=80` 返回：

```ts
interface BackendNode {
  id: string;          // wxid
  name: string;
  is_self: boolean;
  tier: 'self' | 'A' | 'B' | 'C' | 'D' | 'E';
  size: number;
  combined_score?: number;
  cluster?: string | null;   // "core_1", "core_2", ... 或 null（未归类）
  bridge?: boolean;          // 是否是桥梁人物
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

实测数据规模（开发者本人）：
- 81 个朋友节点 + 230 条朋友间边
- 9 个核心圈，最大 13 人，最小 3 人
- 3 个桥梁人物：kevin / Alex Zhang / SHY

## 现有视觉系统（不要破坏）

GraphView 是一个 SVG 3D 投影图：
- **节点**：球状，颜色按 tier (A=红 #FF6B47 / B=琥珀 / C=蓝 / D=灰 / E=浅米)，自己在原点
- **边**：朋友间互连用细虚线 / 朋友间高互动用实线 / 自己↔朋友用橙色实线
- **3D 视角**：拖拽旋转、滚轮 / 触控板缩放、自动慢转
- **侧栏**：右下角 OverviewPanel 列了核心圈名字 + 桥梁人物名字（都是按钮）
- **当前 spotlight 实现**：点击按钮后只是把不在聚焦集里的节点 dim 成 0.32 opacity，同时 dim 边。**没有任何包裹/包络效果**。

## 用户尝试过的失败方案（避免重复）

### 失败 1：凸包 + Catmull-Rom 平滑
- 用 Andrew's monotone chain 算成员投影坐标的凸包，外扩 32px
- Catmull-Rom 转 cubic Bezier 平滑成有机 blob
- 双层（外圈 56px halo + 内圈 32px blob）
- 用户反馈：「圈圈包裹的太多了，体现不出来圈圈」「不是 3D 的」「桥梁也没显示出两个不同群体」

### 失败 2：紧凸包 + 单层
- 同样凸包但 margin 缩到 8px，只画一层，纯色描边 1.8px
- 用户反馈：「核心圈的覆盖不是 3D 的」「桥梁颜色根本不明显」「不同群体颜色区分没做」「核心圈应该把圈内的人包裹起来，每个人」

## 用户真正想要的（关键洞察）

> 「核心圈应该把圈内的人**包裹起来，每个人**」

这句话指向 **metaball / 软体 blob** 风格 — 每个成员节点周围有一个小球，所有小球熔合成一个有机的整体形状。轮廓会在每个人附近凸出来，在两人靠近的地方平滑融合。

这不是凸包（凸包是个外接外壳，不会贴合每个人）。

## 设计要求

### A. 核心圈聚焦（点 cluster 名字时）

**视觉目标**：在 SVG 平面上画出一个 3D 感的有机包络，明确表示「这 13 个人在一个圈里」。每个成员都被这个包络贴合包住。其他人和边都暗下去。

**必须满足**：
1. **每个人都被贴合包住**（metaball 效果，不是凸包）
2. **看上去有 3D 立体感**（不是平面填充。可以用 radial gradient / shadow / blur layered approach 实现立体感）
3. **颜色区分明显**：用一个**饱和度高、对比度强的色板**（不要 HSL hash，因为 hash 出来的色相经常贴近）。建议 12 色调色板（Material Design vivid 系列：`#E63946 #2196F3 #4CAF50 #FF9800 #9C27B0 #009688 #E91E63 #FFC107 #3F51B5 #8BC34A #D81B60 #039BE5`）
4. 不能遮挡节点本身（节点要在包络上方可见、可点）
5. 旋转/缩放图时包络跟着重算（用投影坐标，每帧）

**SVG 实现思路（推荐）**：
- 在 `<defs>` 里定义一个 metaball filter：`feGaussianBlur` + `feColorMatrix` 阈值化 alpha
- 一个 `<g filter="url(#metaball-CLUSTERID)">` 包住若干 `<circle>`，每个 circle 落在一个成员节点位置，半径 = `nodeSize * depth + 14`
- circles 有 fillOpacity = 0.55 + 该集群的饱和色
- 模糊半径 12-14px，阈值矩阵 `0 0 0 22 -10`，让接近的圆熔合
- 如果想更 3D：再叠一层略高 highlight（同色但更亮，offset 上左 3px）+ 一层 drop-shadow

### B. 桥梁聚焦（点 bridge 名字时）

**视觉目标**：清楚地显示「这个人 = 桥梁」，连接「这两个不同的群体」。两个群体颜色明显不同。桥梁本人和它通向两个群体的两条线高亮。

**必须满足**：
1. **两个 metaball blob**，每个用所属 cluster 的鲜艳色（颜色明显不同）
2. **两条粗高亮线**：从桥梁人物中心 → 各自群体里跟 ta 连接最强的那个人（按 edge weight 排序取最强）
3. 桥梁本人节点用脉冲 / 发光 / 描边强调
4. 两个 metaball blob 之间的空隙可以有视觉「缺口」，让 viewer 看到桥梁是在缝合两个分开的群体

**SVG 实现思路**：
- 同核心圈的 metaball，但渲染**两个独立 group**（每个有自己的 filter id 和颜色）
- 两条线：`<line>`，stroke = 该 cluster 色，strokeWidth = 5-6px，1.0 opacity，可加 drop-shadow 让它在 blob 之上突出
- 桥梁节点：保留现有的 dashed-pulse 圈，但叠加一个 stronger glow filter

### C. 颜色系统的基础约束

- **不用 HSL hash**（之前用过，色相贴近问题）
- 用一个 hand-picked palette（10-12 色），按 cluster id 哈希到 palette index
- palette 要确保任意两色对比度足够（OKLCH 距离 ≥ 0.15 比较安全）
- 同时保留 dark mode + light mode 都能看清

### D. 不要做

- 不要硬圆（`<circle r=...>` 把所有人圈进去）— 用户明确说过这不行
- 不要凸包（hull）— 跟「每个人单独包裹」诉求不符
- 不要全屏覆盖效果，不要全黑遮罩
- 不要破坏现有的 3D 自动旋转 / 节点选中 / 边高亮 等交互
- 不要引入第三方动画库（framer-motion 等）

## 现有相关代码（你可能要 patch 的地方）

`app/src/components/extras/GraphView.tsx` 里：

1. 颜色函数：搜 `function clusterColor` — 当前是 HSL hash，**改成 palette lookup**
2. spotlight state：搜 `const [spotlight, setSpotlight]` — 不动逻辑，只动渲染
3. spotlightSet / bridgeClusters：搜 `const spotlightSet = useMemo` — 已经能算出该聚焦谁，不动
4. 实际渲染：在 `{/* Cluster halos */}` 那段下面（约 line 708）插入新的 metaball 渲染代码
5. 桥梁连接线：在 metaball 渲染下面再插入两条高亮 `<line>`
6. SVG `<defs>`：搜 `</defs>` 在 line 706 附近，往里加每个聚焦 cluster 的 metaball filter

OverviewPanel 的按钮逻辑（在 `function OverviewPanel` 里）已经做了 onSpotlight + onSelect — 不用动。

## 验收标准

设计 AI 改完后，下面 4 个手动测试要通过：

1. 打开关系网页，右下角面板点「太の 这一圈 (11 人)」 →
   - 11 个该圈成员被一个有机彩色 blob 包住，每个人附近都凸出贴合
   - blob 看上去有 3D 立体感（不是平面色块）
   - 其他人 dim 到几乎看不见
   - 顶部出现「聚焦：太の 这一圈」胶囊

2. 点同一个按钮再点一次 → blob 消失，恢复正常

3. 点桥梁人物「kevin」 →
   - 屏幕上出现两个明显不同色的 metaball blob（kevin 连的两个圈）
   - 两个 blob 之间是 kevin 节点
   - kevin 到每个 blob 的最强连接对方有一条粗高亮线（线的颜色 = 该 blob 颜色）
   - kevin 自己有 pulse / 发光

4. 旋转图 / 缩放图 → blob 跟着节点位置变化平滑重绘，不闪烁、不卡顿

## 备注

- 用户在 Windows 笔记本（无鼠标滚轮）上测试，touchpad 已支持 pinch / two-finger scroll
- 当前已有动效（节点选中、自动旋转）保留，不要扰动
- 不需要后端改动，所有视觉都在前端 SVG 渲染层
- 测试数据：自己 81 个朋友、9 个核心圈、3 个桥梁，可以 `python cli/etcli.py serve --port 9101` 然后 `curl http://127.0.0.1:9101/api/graph?scope=private&top_n=80` 拿真实 payload

## 截图

（用户需要自己提供：当前失败状态截图 + 期望参考图）
