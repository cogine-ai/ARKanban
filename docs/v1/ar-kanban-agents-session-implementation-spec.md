# AR Kanban Agents 会话面实施规格

状态：Draft

提出日期：2026-08-15

实现基线：`7af4cfb fix(deps): upgrade @fastify/static to 10.1.3`

适用范围：Agents 总览、Agent 详情、Session 详情三个新页面，及其所需的采集、存储与 API

补充关系：本规格依赖 [v1.1 契约修订](./openclaw-collector-v1.1-amendment.md)，补充 [OpenClaw Collector v1 完整蓝图](./openclaw-collector-v1-blueprint.md)，与 [自适应看板](./ar-kanban-adaptive-board-implementation-spec.md) 和 [Incoming Cron](./ar-kanban-incoming-cron-implementation-spec.md) 并列。

## 1. 产品目标

Live Flow 回答「此刻在发生什么」。Agents 会话面回答的是另外三个问题：

```text
这个 Agent 最近干得怎么样？
这次会话发生了什么、花了多少？
哪些会话值得复盘？
```

产品定义：

```text
Agents 会话面 = Agent 名册 × 会话档案 × 会话正文归档 × 用量成本 × 派生健康信号
```

必须同时满足：

1. 与 Live Flow 共享同一份 Gateway 连接和同一个 SQLite 库，不新开采集进程。
2. 任何新增 Gateway 能力缺失时，Live Flow 保持 Live，不降级。
3. 会话档案的可查询历史长于 terminal Activity 的 30 天保留期。
4. 会话正文严格遵守 v1.1 修订第 6 节的 `local_archive` 不变量。
5. 会话列表规模按 2,000 会话设计，不使用「全量下发 + 前端过滤」。
6. 正文与全文检索在 Gateway 断线时照常可用。

本规格不包含：

- 语义搜索与嵌入。它们要求外部 egress，v1 的禁令继续有效。
- 会话导出为文件。正文已落盘，导出是独立的产品决策，且会引入新的外流路径。
- 文件级变更流。文件路径在 tool args 中，继续禁止采集。
- 项目分类与 worktree 映射规则。Agent 与 Session 归属由 Gateway 直接给出，无需纠错层。
- 任何写方法、审批、取消、重试。
- 多 Gateway 与远程数据库。

## 2. 领域模型

### 2.1 Agent

```ts
export type AgentSummary = {
  id: string;
  displayName: string;
  kind: "agent" | "system" | "unknown";
  runtime?: string;
  model?: string;
  origin: "roster" | "observed";
  firstObservedAt: number;
  lastActivityAt?: number;
};
```

`origin` 区分「来自 `agents.list` 的权威名册」与「从已观测 `agentId` 反推」。反推得到的 Agent 必须在 UI 上可辨认，不能与权威名册混为一谈。

写入优先级：反推写入携带的是占位 `displayName`（等于 id）与 `kind: "unknown"`，它们是真实值而非 null，因此 COALESCE 保护不到。名册刷新周期（`AGENT_RECONCILE_MS`）远长于会话对账周期，若不额外约束，权威名册会在数秒内被占位值覆盖。约束为：**当已存行 `origin = "roster"` 而本次写入不是 roster 时，`displayName`、`kind` 与指纹一律保留已存值**；此类写入不得触发 revision 变更。roster 写入之间仍以后写为准，Gateway 才能改名。

反推来源除会话外还包括 cron 作业的 `agentId`（含 `defaultId` 兜底）。取自完整作业列表而非「未来一小时」窗口——否则 Agent 会随 cron 临近而在名册中忽隐忽现。缺此反推时，`agents.list` 未列出的 Agent 其排期将渲染在不存在的卡片上。

### 2.2 Session

```ts
export type SessionKindHint = "main" | "fork" | "subagent" | "global" | "unknown";

export type SessionSummary = {
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  label: string;
  runtime?: string;
  model?: string;
  category?: string;
  kindHint: SessionKindHint;
  archived: boolean;
  hasActiveRun: boolean;
  placement?: string;
  createdAt?: number;
  lastActivityAt: number;
  lastObservedAt: number;
  activityCount: number;
  coverage: SessionCoverage;
};

export type SessionLineage = {
  parentSessionKey?: string;
  previousSessionId?: string;
  forkSourceKey?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  subagentRole?: string;
  worktreeBranch?: string;
};
```

`SessionCoverage` 逐来源表达这一行的证据完整度，与 Activity 的 `EvidenceState` 同构：

```ts
export type SessionCoverage = {
  index: "live" | "snapshot" | "stale" | "unavailable";
  detail: "live" | "not_observed" | "unavailable";
  usage: "live" | "not_observed" | "unavailable" | "unauthorized" | "error";
  messages: "live" | "not_observed" | "unavailable";
};
```

四路 coverage 是硬性要求，不能合并成一个布尔。用量不可用与用量为零是两件不同的事，UI 必须能分辨。

### 2.3 用量

```ts
export type SessionUsage = {
  sessionKey: string;
  observedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  peakContextTokens?: number;
  costMicroUsd?: number;
  hasCost: boolean;
  models: string[];
  unpricedModels: string[];
};
```

成本固定为整数微美元，禁止浮点。`hasCost=false` 与 `costMicroUsd=0` 必须区分：前者是「拿不到价」，后者是「确实没花钱」。

### 2.4 派生信号

```ts
export type SessionSignalGrade = "A" | "B" | "C" | "D" | "F" | "unscored";
export type SessionOutcomeClass = "completed" | "abandoned" | "errored" | "unknown";
export type SessionConfidence = "high" | "medium" | "low";

export type SessionSignals = {
  sessionKey: string;
  algorithmVersion: number;
  computedAt: number;
  grade: SessionSignalGrade;
  score?: number;
  outcome: SessionOutcomeClass;
  confidence: SessionConfidence;
  toolFailures: number;
  toolRetries: number;
  consecutiveFailureMax: number;
  penalties: Array<{ code: string; points: number }>;
};
```

`algorithmVersion` 是必需字段。评分模型是启发式，一定会调整；没有版本号就无法判断一行是否需要重算。

`unscored` 是合法结果。证据不足时必须返回 `unscored`，不得给一个看起来精确的分数。

上下文类信号（compaction、context pressure）在真实 Gateway 验证可得之前**整体省略**，不进入 `penalties`，也不在 UI 占位。

## 3. Gateway 采集

### 3.1 方法与频率

| 方法 | 频率 | 触发 | 分页 |
|---|---|---|---|
| `agents.list` | 300s | 连接建立、`config.changed` 事件 | 无 |
| `sessions.list` | 8s（复用现有） | 现有 reconcile 循环 | limit 500 |
| `sessions.describe` | 按需 | 打开 Session 详情、或该会话首次转 terminal | 单条 |
| `sessions.usage` | 60s | 只覆盖候选集，见 3.3 | 见 3.3 |
| `usage.cost` | 300s | Agents 总览的成本卡 | 按范围 |
| `audit.activity.list`（`kind: "message"`） | 300s，后台 | 增量游标 | limit 500 |
| `chat.history` | 30s（活跃会话增量）+ 空闲期回填 | 见第 7 节 | 游标 |

`sessions.list` 参数继续保持 v1 的隐私设置，**不得**为了拿标题而打开 `includeLastMessage` 或 `includeDerivedTitles`：

```text
sessions.list({ limit: 500, offset, includeGlobal: true, includeUnknown: true,
                includeDerivedTitles: false, includeLastMessage: false })
```

### 3.2 sessions.list 的处理顺序变更

v1 的 `syncSessions` 把每一行直接投影成 Activity 后丢弃原始行。改为：

```text
sessions.list 分页
→ 逐行 upsert 到 sessions 表（会话档案）
→ 再执行现有的 Activity 投影
→ 用 sessionKey 回填 activities.session_id
```

这一步不改变任何既有 Activity 行为，只是在丢弃之前先把行存下来。

### 3.3 用量候选集

对 2,000 个会话每分钟全量拉用量是不可行的。候选集定义为：

```text
候选 = 当前 hasActiveRun 的会话
     ∪ 最近 15 分钟内 lastActivityAt 变化过的会话
     ∪ 最近一次用量观测距今超过 6 小时且未 archived 的会话（每轮最多补 20 个）
```

每轮候选上限 100 个。超出部分留到下一轮，并把 `usage` coverage 标为 `snapshot` 而非 `live`。

会话进入 terminal 且已采过一次用量后，不再定期刷新，只在用户打开详情时按需刷新一次。

### 3.4 能力探测

`sessions.usage`、`sessions.usage.timeseries`、`usage.cost` 不在 hello 的发现列表中，按 v1.1 修订 §4.3 处理：

```text
连接就绪后 → 对每个不可发现方法执行一次最小参数探测
→ METHOD_NOT_FOUND  → coverage=unavailable，本 connection generation 内不再调用
→ 权限错误           → coverage=unauthorized，不再调用
→ 其他失败           → coverage=error，下一轮 reconcile 重试
→ 成功               → coverage=live，进入正常调度
```

探测结果绑定在 connection generation 上；重连必须重新探测。

### 3.5 失败隔离

新增的每一路采集都在独立的 try 边界内。任何一路失败只影响自己的 coverage，不得：

- 改变 `CollectorSyncState`
- 阻塞 `syncTasks` 或 `syncSessions`
- 触发全局 reconcile

新增的定时器不得与 8 秒的 session 循环共用同一个 tick。

## 4. SQLite Schema 与迁移

### 4.1 迁移框架

当前 `CollectorRepository` 构造函数内联 `CREATE TABLE IF NOT EXISTS`，没有版本概念。本次必须先引入：

```text
meta.schema_version  —— 整数，缺失视为 1
migrations[]         —— 有序数组，每项 { version, up(db) }
```

启动流程：

```text
读取 schema_version
→ 若低于目标版本：复制数据库文件到 <path>.pre-v<N>.bak（0600）
→ 在单个事务内顺序执行待应用的 migration
→ 写入新的 schema_version
→ 失败则整体回滚并 fail closed，不带着半迁移的库启动
```

v1 基线库视为 version 1；本次交付 version 2。

### 4.2 新增表

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  runtime TEXT,
  model TEXT,
  origin TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_activity_at INTEGER
);

CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  session_id TEXT,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  runtime TEXT,
  model TEXT,
  category TEXT,
  kind_hint TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  has_active_run INTEGER NOT NULL DEFAULT 0,
  placement TEXT,
  parent_session_key TEXT,
  previous_session_id TEXT,
  fork_source_key TEXT,
  spawned_by TEXT,
  spawn_depth INTEGER,
  subagent_role TEXT,
  worktree_branch TEXT,
  created_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  coverage_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);

CREATE INDEX idx_sessions_agent_activity ON sessions(agent_id, last_activity_at DESC);
CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC);

CREATE TABLE session_usage_snapshots (
  session_key TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  peak_context_tokens INTEGER,
  cost_micro_usd INTEGER,
  has_cost INTEGER NOT NULL,
  models_json TEXT NOT NULL,
  PRIMARY KEY (session_key, observed_at),
  FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
);

CREATE TABLE usage_daily_rollup (
  day INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER,
  session_count INTEGER NOT NULL,
  PRIMARY KEY (day, agent_id, model)
);

CREATE TABLE session_signals (
  session_key TEXT PRIMARY KEY,
  algorithm_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  grade TEXT NOT NULL,
  score INTEGER,
  outcome TEXT NOT NULL,
  confidence TEXT NOT NULL,
  tool_failures INTEGER NOT NULL,
  tool_retries INTEGER NOT NULL,
  consecutive_failure_max INTEGER NOT NULL,
  penalties_json TEXT NOT NULL,
  FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
);

CREATE TABLE session_message_stats (
  session_key TEXT NOT NULL,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL,
  outcome TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  PRIMARY KEY (session_key, direction, channel, outcome)
);

-- 会话正文归档（local_archive）
CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  session_id TEXT,
  message_id TEXT,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  channel TEXT,
  tool_name TEXT,
  content TEXT NOT NULL,
  content_bytes INTEGER NOT NULL,
  superseded_by_session_id TEXT,
  divergent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE (session_key, seq, session_id)
);

CREATE INDEX idx_session_messages_session ON session_messages(session_key, seq);
CREATE INDEX idx_session_messages_created ON session_messages(created_at DESC);
CREATE INDEX idx_session_messages_message_id ON session_messages(message_id);

CREATE VIRTUAL TABLE session_messages_fts USING fts5(
  content,
  content='session_messages',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER session_messages_ai AFTER INSERT ON session_messages BEGIN
  INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER session_messages_ad AFTER DELETE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER session_messages_au AFTER UPDATE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE session_transcript_sync (
  session_key TEXT PRIMARY KEY,
  cursor TEXT,
  last_seq INTEGER,
  last_message_id TEXT,
  synced_count INTEGER NOT NULL DEFAULT 0,
  synced_bytes INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER,
  error_code TEXT,
  FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
);
```

唯一约束取 `(session_key, seq, session_id)` 而不是 `(session_key, seq)`，因为同一 key 下 transcript 换代后 `seq` 会从 0 重新开始，旧代际必须能与新代际共存。

FTS5 使用 external content 模式（`content='session_messages'`），索引不重复存储原文。触发器负责索引同步，写入路径不得绕过 `session_messages` 直接写索引。

### 4.3 activities 表变更

```sql
ALTER TABLE activities ADD COLUMN session_ref TEXT;
CREATE INDEX idx_activities_session_ref ON activities(session_ref);
```

沿用新列名而不复用既有的 `session_key`，因为二者语义不同：`session_key` 是「事件里声称的 key」，`session_ref` 是「已确认存在于 sessions 表的外键」。存在 `session_key` 非空但 `session_ref` 为空的合法中间态。

### 4.4 保留与 rollup

```text
每 6 小时（复用现有 prune 定时器）：
  1. 把超过 7 天的 session_usage_snapshots 聚合进 usage_daily_rollup
  2. 删除超过 storage.usageRetentionDays 的原始快照
  3. 删除 archived 且 last_activity_at 超过 sessionRetentionDays 的 sessions
  4. 删除 created_at 超过 transcriptRetentionDays 的 session_messages
  5. 若正文体量仍超过 transcriptMaxBytes，按会话最后活动时间从最旧一端继续驱逐
  6. 保持现有的 terminal_history prune 不变
```

新增配置项：

```json
{
  "storage": {
    "usageRetentionDays": 90,
    "sessionRetentionDays": 365,
    "transcriptRetentionDays": 180,
    "transcriptMaxBytes": 2147483648,
    "transcriptSync": "enabled"
  }
}
```

`sessionRetentionDays` 必须显著大于 `terminalRetentionDays`，否则会话档案会跟着 Activity 一起断片。配置校验强制 `sessionRetentionDays >= terminalRetentionDays`。

正文按时间与容量双闸门裁剪。容量驱逐以整个会话为单位而不是单条消息，避免留下一半的对话——半截 transcript 在回顾场景里几乎没有价值，还会让搜索结果产生误导。

## 5. HTTP API

### 5.1 新增端点

| 路由 | 说明 |
|---|---|
| `GET /api/v1/agents` | Agent 名册 + 每个 Agent 的汇总卡数据 |
| `GET /api/v1/agents/:id` | 单 Agent 详情：趋势、分布、归属 cron |
| `GET /api/v1/sessions` | 分页会话列表 |
| `GET /api/v1/sessions/:key` | 单会话档案 + 血缘 + 用量 + 信号 |
| `GET /api/v1/sessions/:key/activities` | 该会话下的 Activity 时间线 |
| `GET /api/v1/sessions/:key/messages` | 本地归档的会话正文，带同步水位，见第 7 节 |
| `GET /api/v1/search/messages` | 跨会话全文检索，见第 7 节 |
| `GET /api/v1/usage/summary` | 按范围的成本与 token 汇总 |

### 5.1.1 Agent 汇总卡的近期 rollup

`GET /api/v1/agents` 的每一项在 `AgentSummary` 与会话计数之外，带一个终态活动 rollup：

```ts
recent: Record<"24h" | "7d", {
  completed: number;                // 窗口内的终态活动总数
  succeeded / failed / cancelled / timedOut / blocked / unknown: number;
  successRate?: number;             // completed 为 0 时缺省，不是 0
  avgDurationMs?: number;           // 无可用样本时缺省，不是 0
  durationSampleCount: number;      // 同时观测到 started_at 与 ended_at 的运行数
}>
```

两个窗口在服务端一次算完。理由是 §6.4 要求卡片同屏展示 24h 与 7d，而 `settled-groups` 一次只覆盖一个区间，让前端拉两次既多一轮往返，也无法给出时长。

`successRate` 与 `avgDurationMs` 可缺省，与 `SessionCoverage` 同一条原则：没跑过任何任务和成功率为 0 是相反的事实，不能塌缩成同一个数。

平均时长只统计同时观测到 `started_at` 与 `ended_at` 的运行，并暴露 `durationSampleCount` 让调用方判断这个均值的代表性。回退到 `updated_at` 会让 reconcile 的节奏而不是运行本身决定这个数字。

### 5.2 会话列表分页

```text
GET /api/v1/sessions
  ?agentId=        可选，精确
  &state=          可选，active | terminal | archived
  &outcome=        可选，闭集
  &grade=          可选，A..F | unscored
  &since=          可选，Unix ms
  &until=          可选，Unix ms
  &sort=           lastActivity | cost | duration | grade，默认 lastActivity
  &limit=          1..200，默认 50
  &cursor=         不透明游标
```

固定使用 keyset 游标，不使用 offset。排序键必须与游标键一致，且始终以 `session_key` 作为最后一级 tiebreaker，保证稳定。

游标内嵌它被签发时的排序键。把 `lastActivity` 的游标喂给 `duration` 扫描会比较两个不同量纲的值，静默产出一页错乱结果，因此解码时直接拒绝这种错配，返回 `invalid_cursor` 而不是从第一页重来——后者会在无限滚动中重复用户已经看过的行。

`cost` 与 `grade` 的排序在 S3 阶段返回 400 `sort_not_yet_collected`，并在响应里注明数据将由哪个分片采集（分别是 S6、S7）。不做静默降级到 `lastActivity`：那会让调用方以为排序生效了，只是结果不对。

**会话列表不进入 `ActivitySnapshot`。** 现有 snapshot 是全量下发模型，把上千会话塞进去会让每次 SSE invalidate 都产生一次全量传输。

### 5.3 SSE topic

现有 `invalidate` 帧是粗粒度的，前端收到后会重拉全部三个接口。新增 topic 字段：

```ts
export type CollectorChange = {
  epoch: string;
  revision: number;
  full: boolean;
  topics: Array<"activities" | "sessions" | "usage" | "agents">;
  ids: string[];
  reasons: string[];
  syncState: CollectorSyncState;
};
```

兼容性：`topics` 为新增字段，缺失时前端按 `["activities"]` 处理，与现有行为一致。

用量刷新只发 `usage` topic。Agents 总览订阅 `agents` 与 `usage`，Live Flow 只订阅 `activities`，互不打扰。

## 6. 前端

### 6.1 路由

当前 `View` 是四值联合加 `useState`，没有 URL。Session 详情必须可深链、可后退、可分享，因此引入路由。

```text
/                      Live Flow（保持现有行为为默认路由）
/relations
/archive
/connections
/agents                Agents 总览
/agents/:agentId       Agent 详情
/sessions              会话列表（可带筛选 query）
/sessions/:sessionKey  Session 详情
```

约束：

1. 使用 history API，不使用 hash 路由。
2. 筛选与排序状态全部写进 query string，刷新后可复原。
3. 现有四个 View 的路径必须与旧行为等价，不引入回归。
4. 路由库的选择不在本规格内约束，但必须是单一依赖、无状态管理副作用。

实现选择：不引入依赖，`web/src/router.tsx` 自建（约 110 行）。需要的只有路径匹配、不触发整页刷新的链接、以及 query string 读写；路由库附带的 loader 与数据缓存会与 `collector-context` 并存并重复一份数据层，正是约束 4 想避免的情况。

导航使用真实 `<a href>`：中键、Cmd 点击、复制链接、辅助技术都依赖它。只有普通左键点击被拦截，带修饰键与非左键的点击交还浏览器。

服务端已有 `GET /*` 回退到 `index.html`，深链无需额外改动。

### 6.2 App.tsx 拆分（前置条件）

`web/src/App.tsx` 当前超过 1,000 行。在新增任何页面之前必须先拆：

```text
web/src/views/LiveFlow.tsx
web/src/views/Relations.tsx
web/src/views/Archive.tsx
web/src/views/Connections.tsx
web/src/state/collector-context.tsx   （现有 useCollector 提升为 context）
web/src/state/use-paged-query.ts      （新增，供会话列表使用）
```

拆分本身不改行为，作为独立提交先落地。

### 6.3 数据获取的两种模式

必须明确区分，不得混用：

| 模式 | 用途 | 机制 |
|---|---|---|
| 全量快照 | Live Flow、Agents 总览 | 现有 `useCollector`，SSE invalidate 后 debounce 90ms 重拉 |
| 分页查询 | 会话列表 | `use-paged-query`，游标翻页，SSE 只标记「有新数据」而不自动重拉 |

会话列表在用户滚动时不得因为 SSE 自动重排。参照 AgentsView 的做法：显示一个刷新提示，由用户决定何时拉取。

### 6.4 第一批交付：Agents 总览

每个 Agent 一张卡，四段信息：

```text
身份    displayName · runtime · model · kind 标记（system 类需明确区分）
此刻    活跃会话数 · 活跃 run 数 · 当前 attention 数
近期    24h 与 7d 的完成数、成功率、平均时长
未来    未来 1 小时的 cron 预测数（直接复用现有 UpcomingScheduleSnapshot）
成本    24h 与 7d 的 token 与成本，用量不可用时显示 coverage 状态而不是 0
```

「未来」这一段是本产品相对 AgentsView 的差异点：AgentsView 没有 Gateway 的调度视角，拿不到这个数。数据已经在 `ActivitySnapshot.schedule` 里算好了，直接按 `agentId` 分组即可。

卡片排序默认按「当前活跃 → 最近活动时间」。`kind: "system"` 的 Agent 默认折叠，与 OpenClaw 客户端对 system roster 的处理保持一致。

### 6.5 视觉

沿用现有 CSS 变量与 Tailwind 组合，不引入新的设计体系。Agent 卡片复用 `--agent` 色值，与 Live Flow 的泳道保持同一视觉语言。

## 7. 会话正文归档（local_archive）

正文以完整原文存入本机 SQLite 并建立全文索引，Gateway 断线时仍可读可搜。约束见 v1.1 修订第 6 节。

### 7.1 同步循环

同步是增量拉取，不是订阅。`sessions.messages.subscribe` 的禁令继续有效。

```text
每 30s：
  活跃会话（has_active_run 或 15 分钟内有活动）
  → 按 session_transcript_sync.cursor 增量拉 chat.history
  → 写入 session_messages，FTS 索引由触发器同步维护
  → 更新游标与水位

空闲配额（每轮不超过 5 个会话）：
  尚未回填完整的历史会话
  → 从最早未同步位置向前拉
  → complete = 1 时停止
```

三条边界：

1. 每轮总请求数不超过 20，避免正文同步挤占 Task/Session 主同步的 Gateway 配额。
2. 主同步失败时正文同步整轮跳过。正文是次要目标，不得拖累 Live Flow。
3. 达到 `transcriptMaxBytes` 时停止空闲回填，仅保留活跃会话增量，并按会话最后活动时间从最旧一端驱逐。

实现补充（`src/collector/transcript-sync.ts`）：

- 每个会话每轮只拉一页。长回填跨轮推进，而不是一次占满请求预算。
- 容量判定不在写路径上做。`usage()` 依赖 `dbstat`，会遍历全部页，因此权威测量最多每 5 分钟一次，其间用本轮写入字节数递增估算；越线时立即重新测量再驱逐。
- `chat.history` 的字段名与 `sessions.list` 一样来自协议文档而非实测，经 `MESSAGE_FIELD_ALIASES` 声明式读取，未命中项由 `/api/v1/diagnostics/field-coverage` 的 `chat.history` 报告列出。
- 幂等键要求 Gateway 给出消息序号。若未给出，序号由本地水位续编，此时改以 `messageId` 去重——否则重复拉取同一页会拿到一批新序号，绕过唯一约束。

### 7.2 幂等与代际

`(session_key, seq)` 是幂等键。重复拉取同一段历史必须是无操作而不是产生重复行。

`sessionId` 变化意味着同一 `sessionKey` 下 transcript 换代（compaction 或重建）。此时不覆盖旧消息，而是给旧消息打上 `superseded_by_session_id`，新代际从 `seq = 0` 重新开始。理由是压缩前的原始对话往往正是回顾时想看的内容，直接覆盖等于让归档失去意义。

Gateway 侧若重写了已同步区间的内容，本地保留先到的版本并记 `divergent` 标记，不做自动覆盖。

### 7.3 读取与搜索

```text
GET /api/v1/sessions/:key/messages?afterSeq=&limit=    读本地归档
GET /api/v1/search/messages?q=&agentId=&sessionKey=&from=&to=  全文检索
GET /api/v1/transcripts/status                         归档体量与同步状态（无正文）
```

翻页参数落地为 `afterSeq` 而非不透明 cursor：归档内的 `seq` 在单个会话代际内本就单调，再包一层游标只是多一层编解码。

`/api/v1/transcripts/status` 支撑不变量 10 的常态告知，只回计数、水位与配置，不含任何片段。

两个端点都只读本地表，不回源 Gateway，因此在 Gateway 断线时照常工作。响应必须携带该会话的同步水位（`syncedAt`、`syncedCount`、`complete`），前端据此显示归档状态而不是假装实时。

检索使用 `tokenize='trigram'`。查询串长度 <3 时不进 FTS5，改为在已按 `agentId` 或时间窗收窄的候选集上做 `LIKE` 扫描，并在响应中标 `mode: "fallback"`。候选集为空时拒绝执行全库 `LIKE`，返回「请输入至少 3 个字符」而不是慢查询。

### 7.4 渲染

正文是不可信输入。以 React text node 渲染，不执行 Markdown、不注入 HTML，遵守现有 CSP。搜索高亮基于字符偏移量在文本节点内切分，不拼接 HTML 字符串。

### 7.5 抹除

```text
openclaw-collector purge-transcripts --config <path>
```

删除 `session_messages` 与 FTS 索引全部内容、保留会话与用量元数据、执行 `VACUUM` 使数据不可从空闲页恢复，并删除 `*.bak` 迁移备份文件（备份同样含正文）。命令必须在非交互环境下要求 `--yes` 显式确认。

该命令不要求 Gateway token。抹除是纯本机操作，而需要抹除正文的场景往往正是 token 已被吊销之后；要求先恢复 token 才能删除本机数据是本末倒置。`loadConfig` 因此对这一条命令放开 token 校验，其余校验不变。

不变量 10 要求「持续明示、不得静默开启」。正文视图属于 S7，因此常态告知先落在 Connections 页的归档面板上：存了多少条、占多少空间、保留多久、上一轮同步结果，以及抹除命令本身。

## 8. 性能边界

1. 用量采集每轮最多 100 个会话，稳定态 Gateway 开销为每分钟 1 次探测加不超过 100 次 `sessions.usage`。
2. 会话列表查询在 2,000 会话规模下必须走索引，不得出现全表扫描。
3. 用量 rollup 在 6 小时定时器内完成，且不阻塞写路径超过既有的页间 yield 预算。
4. SSE topic 拆分后，用量刷新不得触发 Live Flow 的 snapshot 重拉。
5. 会话列表渲染超过 100 行时启用虚拟滚动。
6. 新增写入不得让 v1 的性能门（10k Task / 2k Session / 50 事件每秒）失守；性能门需要按新写入路径重新测量。

## 9. 验收标准

### 9.1 迁移

- v1 基线库升级到 version 2 后，既有 Live Flow、Settled 聚合、Archive 行为无回归。
- 迁移前自动生成 `0600` 备份；迁移中途失败整体回滚且进程 fail closed。
- 重复启动不重复执行已应用的 migration。
- 从备份回滚到 v1 二进制后数据库可正常打开。

### 9.2 采集

- `agents.list` 缺失时，Agent 名册由观测反推并标 `origin: "observed"`，Live Flow 不受影响。
- `sessions.usage` 的三种失败分别产生 `unavailable`、`unauthorized`、`error`，且都不改变 `CollectorSyncState`。
- `METHOD_NOT_FOUND` 后在同一 connection generation 内不再重试；重连后重新探测。
- 用量候选集上限生效，超限部分 coverage 标 `snapshot`。
- `sessions.list` 的隐私参数未被修改。

### 9.3 存储

- `sessionRetentionDays < terminalRetentionDays` 的配置被拒绝启动。
- terminal Activity 被 prune 后，对应 Session 档案仍可查询。
- 超过 7 天的用量快照被正确聚合进日 rollup，聚合前后总量一致。

### 9.4 API

- 会话列表游标翻页在并发写入下不丢行不重行。
- 排序键与游标键不一致的请求返回 400。
- SSE `topics` 缺失时前端按 `activities` 处理，与旧行为一致。

### 9.5 会话正文归档

- 同一段历史重复拉取不产生重复行；`(session_key, seq, session_id)` 幂等成立。
- `sessionId` 换代后旧消息保留并标 `superseded_by_session_id`，新代际从 `seq = 0` 独立计数。
- Gateway 断线时正文与搜索照常工作，且界面显示同步水位而非「实时」。
- 主同步失败的那一轮，正文同步整轮跳过。
- 达到 `transcriptMaxBytes` 后停止历史回填、活跃增量不中断、按会话整体驱逐，无消息被静默丢弃。
- 中文检索：`登录接口` 能命中含该词的消息；`登录` 走 `LIKE` 回退并标 `mode: "fallback"`；无候选集收窄的短查询被拒绝而不是全库扫描。
- 自动化审计通过：正文不进日志、不进 SSE、不进 diagnostic bundle，写入路径只有一个集中模块。审计在数据库确实含正文时运行。
- `purge-transcripts` 后正文不可从数据库空闲页与 `*.bak` 备份中恢复。
- 含攻击载荷的正文（HTML、脚本、Markdown 注入）渲染为纯文本，CSP 无告警。

### 9.6 前端

- 四个既有 View 的路径与旧行为等价。
- 会话列表的筛选与排序可通过 URL 完整复原。
- 会话列表在用户滚动期间不因 SSE 自动重排。
- `kind: "system"` 的 Agent 默认折叠。
- 用量不可用时显示 coverage 状态，而不是显示 0。

## 10. 分片顺序

| 分片 | 内容 | 产出 |
|---|---|---|
| S1 | 迁移框架 + Agent/Session/Message 实体 + schema version 2 | 无 UI 变化 |
| S2 | `agents.list` 采集、`sessions.list` 落表、能力探测 | 后端数据齐备 |
| S3 | `/agents`、`/sessions` 分页 API + SSE topic | 前端可开工 |
| S4 | App.tsx 拆分 + 路由 + **Agents 总览** | 第一个可见页面 |
| S5 | 正文同步循环 + 归档读取 + 全文检索 + `purge-transcripts` | 正文能力上线 |
| S6 | `sessions.usage` 采集 + rollup + 成本视图 | 成本能力上线 |
| S7 | 派生信号 + Session 详情页 | 复盘闭环 |

S1 到 S3 没有界面产出。跳过它们会导致后续每一步都建在错误的地基上：没有迁移框架就无法安全加表，没有 Session 实体就无法做任何 per-session 聚合，没有分页 API 就只能把会话塞进全量 snapshot。

正文相关的表在 S1 的 version 2 迁移里一次建好，即使写入逻辑要到 S5 才落地。理由是正文表会改变整库的体量与安全定级，把它留到后面意味着第二次迁移加一次全库回填。

## 11. 明确的后续项

- `session.observer` 的 headline 是否纳入采集，待实测其内容边界后由 v1.2 修订决定。
- compaction 与 context pressure 若被证实可从公开面观测，再补充上下文类扣分项。
- 两字中文词的检索目前只能走 `LIKE` 回退。若实际使用中这类查询占比高，再评估引入 CJK bigram 自定义分词器——`node:sqlite` 不支持加载扩展，届时需要重新评审 SQLite 驱动的选型。
- 正文归档是否需要静态加密，取决于用户的磁盘加密状况。当前依赖操作系统全盘加密，不在应用层再加一层。
- 健康评分的 penalty 权重需要在真实数据上标定，首版直接沿用 AgentsView 的取值只作为起点，且必须带 `algorithmVersion`。
- 键盘导航模型（蓝图完成门第 7 条）在 Agents 会话面落地后统一补齐，不在本规格内拆分。
