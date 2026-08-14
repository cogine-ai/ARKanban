# AR Kanban Incoming：Queued Task 与未来 Cron 实施规格

状态：Implemented

冻结日期：2026-08-15

实现基线：`e370bb9 feat: forecast upcoming cron work in Incoming`

适用范围：AR Kanban Live Flow 的 Incoming 列、Collector snapshot、Gateway Cron 只读适配

补充关系：本规格补充 [OpenClaw Collector v1 完整蓝图](./openclaw-collector-v1-blueprint.md)，并与 [自适应看板实施规格](./ar-kanban-adaptive-board-implementation-spec.md) 共同定义当前 Live Flow。

## 1. 产品目标

Incoming 回答的是“接下来即将发生什么”，而不仅是“当前已经进入 Task ledger 队列的工作”。因此当前定义为：

```text
Incoming = queued Task + 未来 1 小时内确定了 nextRunAt 的 enabled Cron
```

该定义必须同时满足：

1. queued Task 始终优先，不能被大量 Cron 预测挤出首屏。
2. Cron 是只读预测，不是已经发生的 Activity，也不增加运行数。
3. 只展示 Gateway 给出的下一次权威运行时间，不在 Collector 内重新计算 cron expression。
4. 每个 Agent × Incoming 单元格独立应用容量，不能使用全局“最近 N 条”。
5. Cron 能力缺失或失败时，Task/Session 主采集仍可保持 Live。

本规格不包含：

- 创建、编辑、启停或立即运行 Cron。
- 预测同一 Cron 的多个未来 occurrence。
- 为 Cron 预测创建 Inspector、Activity timeline 或 SQLite 历史。
- 自定义时间窗口；第一阶段固定为 1 小时。
- 键盘导航和专项无障碍验收。

## 2. 数据语义

### 2.1 Queued Task

Queued Task 是现有 `ActivityItem`，满足：

```text
kind = task
state = queued
stage = incoming
```

它继续进入 Activity summary、关系、Inspector 和 SQLite projection。

### 2.2 Upcoming Schedule

Cron 预测使用独立的 `UpcomingSchedule`，不伪装成 `ActivityItem`：

```ts
type UpcomingSchedule = {
  id: `cron:${string}`;
  jobId: string;
  agentId: string;
  title: string;
  nextRunAt: number;
  scheduleKind: string;
  timezone?: string;
};
```

约束：

- 一个 Cron job 最多生成一个 Upcoming Schedule。
- `id` 只用于当前预测卡片稳定渲染，不进入 Activity detail route。
- `summary.incoming` 仍只统计真实 Activity；预测数量由 `schedule.items.length` 单独表达。
- 预测不写入 Collector SQLite，避免“未来事件”污染历史与 Settled 运行次数。

## 3. 时间窗口

固定参数：

```text
windowMinutes = 60
dueGraceMinutes = 3
```

令 `now` 为本轮服务端 reconcile 的时间，Cron 纳入条件为闭区间：

```text
nextRunAt >= now - 3 minutes
nextRunAt <= now + 60 minutes
```

3 分钟 grace 用于避免 Gateway 已到点、但尚未推进 `nextRunAtMs` 时卡片瞬间消失。超过 grace 后必须移除，不能长期显示为 Due now。

权威时间读取顺序：

```text
job.state.nextRunAtMs
?? job.nextRunAtMs
```

Collector 不解析 `schedule.expr`，也不自行处理夏令时、时区或 stagger；这些都由 Gateway 计算后的 epoch 决定。

## 4. 过滤、归属与排序

Cron job 必须依次满足：

1. `enabled === true`。
2. 存在非空 `job.id`。
3. 存在有限数值 `nextRunAtMs`。
4. 时间落在第 3 节窗口内。
5. 能解析 Agent identity。

Agent 归属顺序：

```text
job.agentId
?? agents.list.defaultId
```

显式 `agentId` 优先。无显式 Agent 的 Cron 使用当前 Gateway 的默认 Agent；若 `agents.list` 不可用且无法归属，只省略这些 Cron，并把 Schedule snapshot 标记为 `partial`。不得创建 `Unattributed` 预测泳道。

稳定排序：

1. `nextRunAt ASC`
2. `title ASC`
3. `id ASC`

## 5. Gateway 聚合

### 5.1 能力边界

Cron 预测依赖：

- `cron.status`
- `cron.list`
- 可选 `agents.list`

`cron.status` 或 `cron.list` 未 advertise 时，Schedule 状态为 `unavailable`；它们不是 Task/Session Collector 的必需方法，因此不能让整体 `syncState` 变为 incompatible。

### 5.2 读取流程

Gateway 连接成功后，Task、Session 和 Schedule 首次同步并行执行。Schedule 流程为：

```text
cron.status
→ enabled 时分页 cron.list(includeDisabled=true, limit=200)
→ 必要时读取并按 connection 缓存 agents.list.defaultId
→ 服务端过滤时间窗口与 Agent
→ 发布 UpcomingScheduleSnapshot
```

`cron.list` 每页上限必须为 200，以符合真实 OpenClaw Gateway 参数约束。当前实现最多读取 20 页；超过 4,000 个 Cron definitions 需要后续扩大扫描守卫并增加 partial 语义。

### 5.3 刷新与失效

- 固定每 60 秒 reconcile 一次 Schedule。
- `lastSnapshotAt` 可以更新，但只有 `state`、`schedulerEnabled` 或可见 `items` 变化时才增加 Schedule revision 并发送现有 SSE invalidate。
- 前端不增加 Cron 专用轮询；仍由 canonical snapshot replacement 更新。
- 连接断开、未授权或协议不兼容时清空预测并标记 `offline`。
- RPC 失败时 fail closed：清空预测并标记 `error`，不保留可能已过期的未来卡片。

该策略的稳定态 Gateway 开销为每分钟一次 `cron.status` 加必要的 `cron.list` 分页；默认 Agent 成功解析后，每个连接只读取一次。

## 6. Snapshot 合同

`ActivitySnapshot` 增加与 Activity projection 平级的 Schedule envelope：

```ts
type UpcomingScheduleSnapshot = {
  revision: number;
  state: "live" | "partial" | "unavailable" | "offline" | "error";
  schedulerEnabled: boolean;
  windowMinutes: 60;
  dueGraceMinutes: 3;
  lastSnapshotAt?: number;
  items: UpcomingSchedule[];
};
```

状态语义：

| 状态 | 含义 | UI 文案 |
|---|---|---|
| `live` | Cron 读取完整，或 scheduler 明确关闭 | Schedule live / Cron disabled |
| `partial` | 可读取 Cron，但部分 job 无法解析 Agent | Schedule partial |
| `unavailable` | Gateway 未提供必要 Cron read methods | Schedule unavailable |
| `offline` | Gateway 未连接或未授权 | Schedule offline |
| `error` | 本轮 Cron RPC/解析失败 | Schedule error |

## 7. Incoming 单元格配额

Incoming 复用 Settled 已实现的单元格宽度模式和 12% hysteresis：

| 模式 | 初始宽度 | 容量 C |
|---|---:|---:|
| compact | `< 334px` | 3 |
| standard | `334–737px` | 4 |
| wide | `>= 738px` | 8 |

ResizeObserver 在 300ms quiet window 后更新模式。升级阈值使用 12% hysteresis，避免窗口拖动和实时刷新时反复跳动。

令 `Q` 为 queued Task，`S` 为 Upcoming Schedule：

```text
|Q| + |S| <= C
→ 全部显示

|Q| + |S| > C
→ C-1 个真实卡位 + 1 个 Incoming Overflow card
```

真实卡位分配顺序：

1. queued Task 按 `createdAt ?? updatedAt ASC`，最早排队的优先。
2. queued Task 占完所需卡位后，Cron 按 `nextRunAt ASC` 填充剩余卡位。
3. Overflow 精确记录隐藏的 queued 数和 scheduled 数。

示例，`C=4`：

```text
2 queued + 3 scheduled
→ 2 queued + 1 scheduled + “+2 scheduled”

5 queued + 2 scheduled
→ 3 queued + “+2 queued · +2 scheduled”
```

Overflow Dialog 中，隐藏 queued Task 可继续打开 Activity Inspector；Cron 预测只读展示标题、相对时间、绝对时间和时区/类型。

## 8. 视觉与筛选

- Queued Task 使用现有 Incoming Activity Card。
- Cron 使用蓝色低强调、虚线边框和时钟符号，明确区别“将发生”与“已排队”。
- Cron Card 不响应 Inspector 点击，因为当前没有对应 Activity。
- Radix Dialog 承担 Overflow 展开层。
- Tailwind 负责 Schedule/Overflow variant；现有 CSS 负责密度与表格几何。
- Motion 只用于卡片 enter/exit，不为静态倒计时持续播放动画。

筛选规则：

| 筛选 | queued Task | Cron |
|---|---:|---:|
| All | 显示 | 显示 |
| Tasks | 显示 | 隐藏 |
| Attempts | 隐藏 | 隐藏 |

搜索匹配 Cron 的 `title + agentId`。顶部、列头、Agent 行和 Footer 必须把 `operational`、`queued`、`scheduled next 1h` 分开计数。

## 9. 性能边界

1. Cron 不进入 SQLite，不增加 Settled 聚合、Archive 查询或 Activity relation 的成本。
2. Stable schedule reconcile 不发 SSE，因此不会每分钟触发浏览器全量 snapshot refresh。
3. 每个 Incoming 单元格最多渲染 8 个卡位；超量内容进入一个 Overflow card。
4. Cron 数量不参与 queued Task 的优先级；大量 Cron 只能进入 Overflow，不能挤掉 queued Task。
5. 现有 Activity event 仍可能触发 canonical snapshot refresh；这是共享 SSE 机制，不是 Cron 专用轮询。

## 10. 验收标准

### 10.1 服务端

- `now - 3m` 与 `now + 60m` 边界均包含；边界外 1ms 排除。
- disabled、无 ID、无 nextRunAt 的 Cron 不出现。
- `state.nextRunAtMs` 优先于顶层兼容字段。
- 无显式 Agent 的 Cron 正确回退到 default Agent。
- 无法归属的 Cron 被省略且状态为 partial，不产生 Unattributed。
- `cron.list.limit` 不超过 200。
- Cron items 不进入 `ActivitySnapshot.items`，也不增加 `summary.incoming`。
- Gateway 不支持 Cron 方法时，Task/Session 主同步仍为 Live。

### 10.2 前端

- All 显示 Cron；Tasks 和 Attempts 不显示 Cron。
- queued Task 始终先于 Cron 分配可见卡位。
- 恰好等于容量时不生成 Overflow；超量时只生成一个 Overflow。
- Overflow 能精确还原全部隐藏 queued Task 和 Cron。
- 搜索可定位 schedule-only Agent lane。
- compact / standard / wide 分别执行 C=3 / 4 / 8。

### 10.3 已完成验证

- 单元测试覆盖窗口边界、disabled/缺失字段、Agent fallback/partial、真实分页上限和配额排序。
- Mock Gateway 验证 5 个未来 Cron、schedule-only lane、queued 优先、Overflow Dialog、筛选及响应式容量。
- 2026-08-15 真实 Gateway 验证：scheduler enabled、12 个 definitions；验证时最近一次 next wake 在窗口外，因此 UI 正确显示 `0 scheduled next 1h` 与 `Schedule live`。
- `pnpm verify`：8 个测试文件、27 个测试、类型检查与生产构建通过。

## 11. 明确的后续项

- 若真实环境接近 4,000 个 Cron definitions，取消固定页数守卫或暴露明确 partial coverage。
- 若产品需要“未来一天/一周”，应新增可配置窗口和服务端索引，不在浏览器解析 cron expression。
- 若需要 Cron 详情或编辑，必须设计独立 Schedule Inspector 与写权限模型，不能复用 Activity Inspector。
- 若 Gateway 后续提供 schedule event/revision，可用事件作为 reconcile hint，但 canonical `cron.list` 仍是恢复来源。
