# AR Kanban 自适应看板：范围、分组、排序与配额实施规格

状态：Final for implementation

冻结日期：2026-08-14

适用范围：AR Kanban Live Flow、Settled 展开层、Archive

补充关系：本规格细化并覆盖 v1 蓝图中与 Settled 默认范围、分组、公平展示及单元格配额相关的模糊部分。

## 1. 目标

本规格解决以下产品问题：

1. Settled 原始记录不能挤压 Incoming、In Flight、Waiting 的操作信号。
2. 高频任务不能因为运行次数多而获得更多卡片或更高排序优先级。
3. 低频任务不能在“最近 N 条原始记录”截断前就被淘汰。
4. 用户必须同时看懂任务系列数、真实运行数、统计范围和结果分布。
5. 每个 Agent × Stage 单元格必须有独立的容量边界，不能由全局记录数统一降密度。

本规格不包含：

- 自定义键盘导航模型。
- 专项无障碍设计与验收。
- 月度关键任务 Pin、重要级别或预期调度周期；这些列为后续能力。
- 原始 Activity 数据的删除、确认、重试或其他写操作。

Radix UI 自带的基础语义可以保留，但不作为本规格的额外验收项。

## 2. 规范用语

- **MUST**：实现不可偏离。
- **SHOULD**：默认遵循；偏离时必须留下明确理由。
- **MAY**：可选增强。

## 3. 核心术语

### 3.1 Run / Activity

一次 Task ledger 记录或一次 observed attempt。Archive 展示这一层级。

### 3.2 Series

一组可以被可靠视为同一任务系列的运行记录。Settled 主看板展示这一层级。

### 3.3 Group summary

某个 Series 在选定时间范围内的聚合结果，至少包含：

- `seriesKey`
- `groupingConfidence`
- `agentId`
- `kind`
- `title`
- `rangeStart` / `rangeEnd`
- `runCount`
- `succeededCount`
- `failedCount`
- `timedOutCount`
- `cancelledCount`
- `unknownCount`
- `latestActivityId`
- `latestOutcome`
- `latestEndedAt`
- `failureRate`
- `priorityTier`

### 3.4 Operational activity

Incoming、In Flight、Waiting、Unresolved 中尚未可靠终结的 Activity。它不受 Settled 时间范围影响。

## 4. 数据处理顺序

实现 MUST 使用以下顺序：

```text
完整时间范围
→ 按 Agent 分区
→ 按 Series 分组
→ 计算 Group summary
→ 按产品优先级排序
→ 应用单元格容量
→ 生成具体卡片与 Overflow card
```

禁止使用：

```text
最近 200 条原始记录 → 分组
```

因为低频 Series 可能在分组前已经被高频 Run 淘汰。

## 5. 默认范围

### 5.1 首次默认值

Settled 和 Archive 首次打开时 MUST 使用最近 `7d`。

范围选择器提供：

- `24h`
- `7d`
- `30d`

用户修改后 SHOULD 在本机记住最后选择；新设备仍从 `7d` 开始。

### 5.2 影响边界

- Incoming、In Flight、Waiting、Unresolved MUST 始终包含全部当前 Activity。
- 范围只影响 Settled group summary、Settled 展开层和 Archive。
- 切换范围 MUST 原子替换完整结果，不能暂时混合两个范围的计数。

### 5.3 时间字段

Settled 范围以：

```text
terminalAt = endedAt ?? updatedAt
```

为准。

不能使用 `lastObservedAt` 延长终态记录的统计生命，否则周期性快照会让旧记录永远留在范围内。

范围边界为：

```text
terminalAt >= rangeEnd - duration
terminalAt <= rangeEnd
```

存储和计算使用 epoch；界面按用户本地时区显示。

### 5.4 界面标签

Settled 标题 MUST 同时显示：

```text
SETTLED · {seriesCount} series · {runCount} runs · {range}
```

例：

```text
SETTLED · 20 series · 233 runs · 7d
```

## 6. Series 身份

### 6.1 正式身份

数据源提供稳定身份后，MUST 使用：

```text
seriesKey = sourceDefinitionRef | scheduleId | canonicalJobId
```

Series 身份不能由运行次数、相似时间或模糊标题推断。

### 6.2 第一阶段回退

在稳定身份缺失时，允许：

```text
fallbackSeriesKey = agentId + exactTitle + kind
groupingConfidence = display_exact
```

规则：

- 标题必须精确匹配，不做 trim 之外的模糊归一化。
- Task 与 Attempt MUST 分开。
- 不同 Agent MUST 分开。
- 卡片或展开层必须标明“Same displayed title”，不能宣称它们必然是同一业务任务。
- 每个 Group 必须能展开还原所有原始 Activity。

## 7. Group summary 分类与排序

### 7.1 优先级层级

| Tier | 条件 | 用户语义 | 默认色调 |
|---|---|---|---|
| P0 | `latestOutcome` 为 `failed` 或 `timed_out` | 当前最新结果失败 | red |
| P1 | `latestOutcome` 为 `unknown` | 最新结果无法确认 | neutral/unknown |
| P2 | 最新成功但范围内存在失败/超时，或最新为 cancelled | 结果混合或已恢复 | amber |
| P3 | 范围内全部为 succeeded | 健康 | green/neutral |

`Settled` 仅表示“已经结束”，不参与上述结果色调。

### 7.2 指标

```text
failureRate = (failedCount + timedOutCount) / runCount
```

分母包含 succeeded、failed、timed_out、cancelled、unknown 的全部 Run。卡片同时显示精确计数，不能只显示百分比。

### 7.3 稳定排序键

排序 MUST 使用以下键：

1. `priorityTier ASC`
2. P2 内：`failureRate DESC`
3. P3 健康组内：`runCount ASC`，优先给低频健康 Series 覆盖机会
4. `latestEndedAt DESC`
5. `title` 本地稳定排序
6. `seriesKey ASC`

额外规则：

- 高频 Run 数不能提升 Tier。
- 高频 Run 数不能生成额外卡片。
- 绝对失败次数不能覆盖最新结果和失败率的排序语义。
- 相同输入 MUST 产生相同顺序，避免实时刷新时无原因跳动。

## 8. 单元格容量

### 8.1 Settled 容量

Settled 单元格容量 `C` 包含 Overflow card：

| 模式 | C | 使用场景 |
|---|---:|---|
| compact | 3 | 较窄桌面单元格 |
| standard | 4 | 标准桌面参考模式 |
| wide | 8 | 宽屏或用户主动聚焦 |

Group card 尺寸约束：

| 模式 | 最小尺寸 | 展示内容 |
|---|---:|---|
| compact | 120 × 44px | title + outcome counts |
| standard | 156 × 64px | title + runs/range + latest + counts |
| wide | 176 × 72px | standard 内容 + 更完整时间/标签 |

布局常量：

- cell padding：8px
- card gap：6px
- Settled 可驱动的 Agent row 高度上限：196px

物理容量计算：

```text
columns = floor((cellWidth - 2*padding + gap) / (cardMinWidth + gap))
rows    = floor((cellHeightCap - 2*padding + gap) / (cardMinHeight + gap))
physicalCapacity = max(1, columns) * max(1, rows)
C = clamp(physicalCapacity, 3, 8)
```

参考 standard 单元格为 340 × 160px，可形成 2 列 × 2 行，因此 `C=4`。

若物理空间不足以容纳 3 个合法卡片，界面 MUST 切换到 Stage focus / responsive 模式，不能继续缩小到不可读尺寸。

空单元格显示 0 张卡；“最小 3”是容量下限，不是虚构占位数量。

### 8.2 配额应用

令 `G` 为单元格内 Group 数：

```text
G = 0      → 空状态
G <= C     → 展示全部 G 张 Group card
G > C      → 展示排序前 C-1 张 Group card + 1 张 Overflow card
```

Settled 内容 MUST 在容量内结束，不能继续增加 Agent 行高度。

### 8.3 Overflow card

Overflow card MUST 按 Series 而不是 Run 计数：

```text
+6 series
6 runs · 7d
? 6 unknown
```

Overflow card 必须汇总被折叠 Group 的：

- `seriesCount`
- `runCount`
- outcome breakdown
- 最高 `priorityTier`

只要 Overflow 中存在 P0/P1，卡片就不能使用普通健康色调。

点击后打开该 Agent、该范围、仅包含 Overflow Series 的完整列表。

## 9. 卡片内容

### 9.1 Group card

标准卡片至少显示：

```text
{title}
{runCount} runs · {range}
Latest: {latestOutcome} · {relativeTime}
✓ {succeeded}  ! {failed+timedOut}  ? {unknown}
```

当 `cancelledCount > 0` 时，卡片必须追加明确的 `cancelled {N}` 文本；为 0 时可以省略。

例：

```text
awaab-pm-patrol-weekday
43 runs · 7d
Latest: succeeded · 18m ago
✓19  !24  ?0
```

### 9.2 数量语义

- Group card 上的倍数表示选定范围内的 Run 数。
- Agent cell header 显示 Series 数和 Run 数。
- Overflow card 主数字表示 Series 数。
- 任何地方都不能使用一个未注明单位的 `+N`。

## 10. 交互层级

### 10.1 Live Flow

显示全部 Operational Activity 和有界的 Settled Group card。

### 10.2 Settled 展开层

点击 Group card 后显示该 Series 的全部范围内 Run。默认排序为最新 Run 在前，可按 Outcome 筛选。

点击 Overflow card 后显示其包含的全部 Series，不直接跳到原始 Run 列表。

### 10.3 Archive

Archive 展示原始 Run，使用时间范围与 keyset pagination。Archive 不受主看板卡片容量限制。

### 10.4 搜索

搜索命中折叠的子 Run 时：

- 对应 Group card 必须出现。
- 卡片标注 `{N} matching runs`。
- 打开后默认只显示命中的 Run，用户可清除匹配筛选。

## 11. 更新稳定性与 Motion

- 新 revision 到达后，范围、分组、排序和配额作为一个派生视图批量重算。
- 90ms 事件合并可以保留；布局模式变化继续使用 12% hysteresis 和 300ms quiet window。
- Motion 只用于 Group card 增删、结果色调变化和 Inspector 进入退出。
- 不能对每次相同快照刷新播放动画。
- 不能为所有卡片持续启用 layout measurement。
- Group card 重新排序时，已打开的 Inspector 必须继续绑定原 Activity/Series。

## 12. Radix UI + Tailwind + Motion 映射

| 产品组件 | 实施责任 |
|---|---|
| Range selector | Radix ToggleGroup；Tailwind 管理 active/hover 状态 |
| Group card | React component + Tailwind variants |
| Overflow card | 独立 Variant，不复用普通成功卡色调 |
| Series run list | Radix Dialog/Sheet；长列表虚拟化 |
| Outcome filter | Radix ToggleGroup/Select |
| Inspector | Radix Dialog/Sheet |
| Motion | 仅 enter/exit、result change、Inspector transition |

建议的 Tailwind Variant 轴：

```text
density × stage × priorityTier × groupingConfidence × selected
```

## 13. 数据/API 要求

当前 `/api/v1/snapshot?recentLimit=200` 不能作为 Settled Group summary 的输入。

实现 MUST 满足以下任一方式：

1. 新增按完整范围聚合的 Settled groups endpoint；或
2. 在 snapshot 中增加由服务端基于完整范围生成的 `settledGroups`。

建议响应至少包含：

```ts
type SettledGroupSnapshot = {
  range: "24h" | "7d" | "30d";
  rangeStart: number;
  rangeEnd: number;
  complete: boolean;
  totalSeries: number;
  totalRuns: number;
  outcomeCounts: Record<string, number>;
  groupsByAgent: Record<string, SettledGroupSummary[]>;
};
```

服务端 MUST 在应用任何返回条数限制前完成范围查询和 Series 聚合。

如果数据不完整，UI 必须显示 `Partial coverage`，不能无提示地展示失败率或总数。

## 14. 标准桌面真实数据演算

数据时间：2026-08-14 17:53:45 +08

来源：本机 Collector SQLite 完整最近 7 天 Settled 数据

模拟容量：standard，`C=4`

完整范围结果：

- 233 Runs
- 20 fallback Series
- 8 Agents
- 138 succeeded
- 86 failed
- 9 unknown

同一时刻当前 API 只返回最近 200 条，并完全遗漏低频 Series `AI成交顾问 18:30 交付跟进`。这证明必须先按完整范围分组，再应用卡片容量。

### 14.1 每个 Agent 最终卡片

| Agent | Series / Runs | C=4 最终展示 |
|---|---:|---|
| `main` | 2 / 23 | `Memory Dreaming Promotion`；`plugin:memory-core` |
| `pcd-conrad` | 1 / 14 | `Conrad Coginer Wiki sync` |
| `pm-awb` | 3 / 48 | `awaab-pm-patrol-weekday`；`awaab-pm-patrol-weekend`；`AI成交顾问 18:30 交付跟进` |
| `pm-begin` | 1 / 37 | `berger-pm-patrol` |
| `pm-coginework` | 1 / 35 | `chadwick-pm-patrol` |
| `pm-dearclaw` | 2 / 39 | `declan-pm-patrol-weekday`；`declan-pm-patrol-weekend` |
| `pm-jianyan` | 1 / 28 | `jaya-pm-patrol` |
| `Unattributed` | 9 / 9 | 最新 3 个 unknown Attempt；`+6 series · 6 runs · ?6 unknown` Overflow |

最终主看板只需要 15 个 Settled 卡位表达 233 次运行，同时仍保留低频 Series。

### 14.2 卡片结果示例

| Agent / Series | Runs | Outcome | Latest | Tier |
|---|---:|---|---|---|
| `pm-begin / berger-pm-patrol` | 37 | ✓17 / !20 | failed | P0 |
| `pm-coginework / chadwick-pm-patrol` | 35 | ✓14 / !21 | succeeded | P2 |
| `pm-awb / awaab-pm-patrol-weekday` | 43 | ✓19 / !24 | succeeded | P2 |
| `pm-awb / awaab-pm-patrol-weekend` | 4 | ✓3 / !1 | succeeded | P2 |
| `pm-awb / AI成交顾问 18:30 交付跟进` | 1 | ✓1 | succeeded | P3 |
| `pm-jianyan / jaya-pm-patrol` | 28 | ✓27 / !1 | succeeded | P2 |
| `Unattributed / OpenClaw run …` | 1 each | ?1 | unknown | P1 |

## 15. 验收标准

### 15.1 数据真相

- 在相同 7d 数据上，Group summary 总 Run 数必须等于完整范围原始 Run 数。
- 展开所有 Group 后必须能还原全部原始 Activity ID。
- 先截断再分组的实现判定为 FAIL。
- Task 与 Attempt 被错误合并判定为 FAIL。

### 15.2 公平性

- 同一 Series 的 1 次和 100 次运行都只能生成 1 张 Group card。
- `runCount` 不能提升卡片 Tier 或占用额外卡位。
- 健康组剩余配额优先低 `runCount` Series。
- Overflow 必须按 Series 显示精确数量与结果分布。

### 15.3 容量

- standard 模式每个 Settled 单元格最多 4 个卡位。
- Group 超量时只允许 `C-1` 个具体卡 + 1 个 Overflow。
- Settled 超量不能继续增加 Agent 行高度。
- P0/P1 被折叠时，Overflow 必须使用异常语义并显示数量。

### 15.4 交互与稳定性

- 切换 24h/7d/30d 后计数、卡片和 Archive 范围一致。
- 相同数据重复刷新不改变卡片顺序。
- 选中的 Series/Activity 在重分组或更新后保持 Inspector 上下文。
- 搜索命中折叠 Run 时能到达该 Run，最多两次交互。

## 16. 后续但不阻塞第一阶段

- 用稳定 `seriesKey` 替换 `display_exact` fallback。
- 为月度或关键任务增加 Pin、重要级别和预期调度周期。
- 根据真实使用数据校准 7d 默认值与 compact/standard/wide 容量阈值。
