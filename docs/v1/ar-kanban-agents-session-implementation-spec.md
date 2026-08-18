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

实现补充（S7）：

- 评分只读本机已存的 `activities` 与 `observations`，不回查 Gateway，因此离线可算、可重算。权重表见 `SIGNAL_PENALTIES`，每一类都带上限，避免单个病态会话把分数拉到任意负值——那会让 F 这个桶失去意义。
- 给分门槛：必须存在**已分类的终态结论**或**至少一次已结算的工具调用**，否则返回 `unscored`。「有东西结束了」不是结论：会话级终态事件经常不带任何 outcome，把它当成功会仅凭「运行停了」就发出干净的分数。
- 判定用哪一行终态时，**最新的已分类结论优先于更新的未分类行**。`unknown` 不携带信息，而它经常就是最新的一行：运行结束后才到的事件会开出一个新的 attempt，下一轮快照发现 Gateway 不再广告它，就把它关成 `unknown`。直接取最新行会让这类记账盖掉 Gateway 真正给过的结论。
- 与之配套，`sessions.changed` 的终态 `status` 现在按别名表映射成 outcome，其中包含 `succeeded`（`done` / `completed` / `finished` …）。此前只分类失败、其余一律 `unknown`，结果是所有健康会话都拿不到结论，读起来与「无从判断的会话」完全一样。
- 重算由后台循环按批推进（`SIGNAL_RECOMPUTE_BATCH`），挑选未评分、算法版本落后、或活动时间晚于 `computed_at` 的会话，活跃会话优先。打开详情页时对该会话按需重算一次：那正是结论最要紧的时刻，一个会话只值几次带索引的读。

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

实现补充（S6）：

- 每个候选发一次 `sessions.usage`，与 §9.1 的开销模型一致；投影器同时接受单行、列表与「以 sessionKey 为键」三种回包形状，字段走 `USAGE_FIELD_ALIASES` 别名表。
- 补采（`stale`）单独限额 20 个，与 100 的总限额分开算。否则几千个闲置会话的长尾会把用户正在看的活跃会话挤出本轮。
- coverage 由本轮结果决定：全部请求失败才是 `error`，只要有一个成功就按 `demand > limit ? "snapshot" : "live"` 取值。单个会话抖动不应该把整张成本卡涂成故障。
- §2.2 的 `SessionCoverage.usage` 联合类型原本没有 `snapshot`，与本节要求矛盾，已按本节补齐。
- 快照是**累计读数**而非增量，因此任何聚合都取每个会话的最新一行，绝不对多行求和。
- `usage.cost` 按 300s 独立节奏刷新，结果只驻内存：它是对某个区间的交叉校验，落库会造出第二份可能与快照冲突的成本口径。重连即失效。

### 3.4 能力探测

`sessions.usage`、`sessions.usage.timeseries`、`usage.cost`、`chat.history` 都按 v1.1 修订 §4.3 处理——前三个不在 hello 的发现列表中，`chat.history` 在本机 2026.7.1-2 上会 advertise，但**不能因此只信发现列表**：§4.3 的要点是「未 advertise 不等于不可用」，而正文同步原先正是按字面反过来用的，遇到不列出 `chat.history` 的构建就每轮判 `unavailable`、一条正文都不归档，且没有任何探测或重试能走出来。现在探测结果（任一确定verdict）优先于发现列表，只有还没探测出结果时才回落到发现列表。

```text
连接就绪后 → 对每个不可发现方法执行一次最小参数探测
→ METHOD_NOT_FOUND  → coverage=unavailable，本 connection generation 内不再调用
→ 权限错误           → coverage=unauthorized，不再调用
→ 其他失败           → coverage=error，下一轮 reconcile 重试
→ 成功               → coverage=live，进入正常调度
```

探测结果绑定在 connection generation 上；重连必须重新探测。

探测本身必须是 Gateway 会接受的调用：`chat.history` 报告的是某个会话，拿一个编造的 key 去问，答案说的是那个 key 而不是这个方法存不存在。因此它用采集器已经见过的最近一个会话键（`repository.mostRecentSessionKey()`）；还没有任何会话时该项探测跳过、verdict 保持 `unknown`，下一轮再来。

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
→ 若高于目标版本：拒绝启动并说明降级不受支持（否则等于让当前代码跑在它没见过的 schema 上）
→ 若低于目标版本：复制数据库文件到 <path>.pre-v<N>.bak（0600）
→ 在单个事务内：再读一次 schema_version（写锁下的权威值）→ 顺序执行待应用的 migration → 写入新的 schema_version
→ 失败则整体回滚并 fail closed，不带着半迁移的库启动
→ 成功后删除其余 <path>.pre-v*.bak，只留本次这一份
```

事务内重读版本号是为并发启动准备的：两个进程几乎同时读到旧版本，后到的那个原先会去建已经存在的表，然后在一个其实完全迁移好的库上假失败。备份只留一代，是因为备份是含全部正文的完整库副本：永久保留会让它活过 `transcriptRetentionDays` 承诺删掉的那段正文——文本就躺在数据库旁边的文件里可读可搜，此前只有 `purge-transcripts` 会删它。

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

-- 已随迁移 v4 删除：这张表在 v2 建了，但没有任何写入路径，也没有任何读取方。
-- 空表不是中性的——它读起来像「这套按渠道的消息分解存在，只是暂时没数据」，
-- 与「从未采集」是两个不同的断言，正是本项目在别处一律拒绝的那种塌缩。
-- 等真正实现填充它的采集路径时再连表一起加回来。
-- CREATE TABLE session_message_stats (...);

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
     （豁免 15 分钟内有活动或仍有 open run 的会话）
  6. 保持现有的 terminal_history prune 不变
  7. 让同步器的容量估算失效，下一轮重新做权威测量
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

用量 rollup 的实现细节（S6）：

- 顺序上用量必须先折叠再删会话。rollup 要通过 session 行拿到 `agent_id`，先删会话会让这段花费变成无归属的孤儿。
- 每个「会话 × 天」只折叠当天最后一条快照，同样因为快照是累计值。rollup 行按 `(day, agent_id, model)` 覆盖写入，同一天重复折叠是幂等的。
- 一个会话可能跨多个模型，而累计读数无法拆分到单个模型，因此多模型会话在 rollup 里落在一个合并标签（`a+b`）下，不做重复计数。
- `usage_daily_rollup` 没有 `has_cost` 列，所以「这一桶从未定价」只能用 `cost_micro_usd IS NULL` 表达。日内部分定价的细节会在跨过折叠地平线后丢失，总额退化为下界。

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
| `GET /api/v1/usage/summary` | 按范围的成本与 token 汇总，默认最近 24h，按 agent 与 model 分组 |

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

### 5.1.2 Agent 汇总卡的成本段（S6）

```ts
cost: {
  coverage: SessionUsageCoverage;
  source: Record<"24h" | "7d", "gateway" | "snapshots">;
  windows: Record<"24h" | "7d", UsageTotals>;
}
```

`source` 必须暴露，因为同一笔花费有两个来源：`usage.cost` 按区间一次定价，`sessions.usage` 按会话逐个定价。卡片优先用前者（一次定价整个区间，比把不同时刻的读数相加更准），`/api/v1/usage/summary` 只报后者。两者不一致时，`source` 是唯一能解释差异的线索。

`source` 与成本 coverage 都**按窗口**记录，因为 24h 与 7d 是两次独立的 `usage.cost` 请求、会各自失败。整卡一个标签的写法有两处失真：一是任一窗口成功就把「由 Gateway 定价」盖在另一个它根本没答的窗口上；二是原实现把两个窗口的结果先攒成一份再整体替换，于是失败的那个窗口以**空 map** 落地——已知价格被静默清空——同时凭另一个窗口的成功把 coverage 报成 `live`，正是这条成本链路本身要防的「没人定价却显示成已定价」。现在每个窗口只被自己那次成功的应答替换，失败的窗口保留上次已知价格并单独降级为 `error`。

但覆盖只替换金额，不替换 `hasCost`。区间定价不可能定出 `sessions.usage` 自己都报为未定价的模型，把 `hasCost` 一并设成 true 会让一个下界读起来像完整值——这正是 §2.3 禁止的那种塌缩。

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

S6 起 `cost` 已可用，取每个会话最新快照的 `cost_micro_usd`。倒序扫描要求每行都有数值，因此从未定价的会话按 0 参与排序、落在末尾；该行自己的 `coverage.usage` 才是「这个 0 不是测量值」的依据。

S7 起 `grade` 已可用，四个排序键全部落地，`sort_not_yet_collected` 这条分支随之退役。`grade` 按严重度倒序（F 最先），未评分的行排在末尾——与 `cost` 里未定价行的处置一致：`unscored` 是「没有证据支撑一个数」，不是「表现良好」。列表行只带 `signals` 的摘要（grade/score/outcome/confidence），完整的 penalty 明细留给详情页。

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

**事件流断开要说清是哪一种断开。** Gateway 连不上是采集端的事，由 `status.syncState` 表达；事件流断开是「这个页面已经不再听到任何变化」，页面上的每个数字都停在断线那一刻。两者过去都塌缩成一个静态的 offline。`EventSource` 自己会重试并自己决定间隔，因此 UI 能诚实报出的是重试次数与断线时刻，而不是一个本代码并未设定的倒计时；只有 `readyState === CLOSED`（浏览器彻底放弃，例如响应不被当作事件流）才是终局，此时给出手动重连。重连成功后按 `ALL_TOPICS` 重拉一次——断线期间发生的变化没有人通报过。

**时间必须能被定位。** 列表与正文行用紧凑格式（不带时区，否则每行都在重复同一个事实），精确时刻带完整日期与时区放在 `title`，并以 `<time dateTime>` 承载机器可读的瞬间；正文面板另外一次性声明「Times shown in <zone>」。跨时区读同一份归档时，「11:54」本身不说明是谁的 11:54。

**虚拟滚动的视口高度由 CSS 决定，再被量测回来。** 写死的常量在小窗口上高于可视区（要靠外层滚动条才能读到列表末尾），在大屏上又只占一小块。高度归 CSS（`.session-list[data-virtualized="true"]` 按窗口收敛），窗口化的计算读 `ResizeObserver` 量到的实际高度，避免两处各存一份高度而漂移。

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

Agent 详情页（`/agents/:agentId`）在卡片之上多出的那一层是**结局分布**：卡片给的是成功率，而成功率分不清「失败」「被取消」「超时」和「压根没有结论」。这四种情况要采取的行动完全不同，压成一个百分比就看不出来了。分布以按比例的色条呈现，未分类的一段与失败段并列可见——`unknown` 占了半数的 Agent，问题往往出在观测面而不是它本身。其余分段（此刻、成本、归属 cron、近期会话）复用总览卡的口径与组件，避免同一个数在两处算法不同。

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
3. 达到 `transcriptMaxBytes` 时停止空闲回填，仅保留活跃会话增量，并按会话最后活动时间从最旧一端驱逐。驱逐**豁免**近 15 分钟内有活动或仍有 open run 的会话；若豁免后仍到不了目标，本轮进入 `capacity: "full"`：**完全停止归档并在 UI 明示**，而不是撕碎正在被写入（也最可能正被阅读）的那条会话——撕碎的结果是下一轮把它重新拉回来、再下一轮再驱逐，请求预算全花在同一条正文的删与拉上。

实现补充（`src/collector/transcript-sync.ts`）：

- 每个会话每轮只拉一页。长回填跨轮推进，而不是一次占满请求预算。
- 活跃增量与回填是两种读，不共用游标。上面伪码写的「活跃会话按 `cursor` 增量拉」按字面实现是错的：`cursor` 由回填写入，指向更旧的一页，活跃会话于是把每轮唯一的那次请求花在早已读过的页上，尾部要等整条历史走完才出现——50 页历史的会话，正文 25 分钟才更新一次。因此活跃读固定取最新一页（不带 `offset`），回填读跟随 `cursor`；活跃读不回写 `cursor`（否则回填进度被重置回第二页），只在该会话还没有任何游标时顺手播种一个，让回填从尾部下面一页开始而不是重读刚取的那页。
- 活跃读拿到「没有更旧的一页」时可以直接判定 `complete`：它从最新一条开始读，Gateway 又说后面没有了，那就是整条历史。绝大多数会话一页装得下，这条省掉它们各自一次多余的回填请求。
- 翻页方向与分页字段已在真机（openclaw 2026.7.1-2，protocol 4）核对：
  - `offset` **从最新一条往回数**，且**确实生效**（同一会话 `{limit:1}` 与 `{limit:1,offset:1}` 返回不同页）；越界 offset 返回空数组。上面的 tail / backfill 分工成立。
  - 该构建**完全不返回分页字段**。`chat.history` 的响应只有 `{ sessionKey, sessionId, messages, defaults, sessionInfo, thinkingLevel }`，无论历史多长都没有 `hasMore`、`nextOffset`、`totalMessages`。因此 `projectHistoryPage` 不能只信响应：满页（`messages.length >= limit`）即视为还有更旧的，下一个 offset 由 `offset + 本页条数` 自行推算；短页即历史到底。别名保留，会答的构建仍然优先采信。
  - 若按字面只信响应，后果是每个会话在一次 tail 读后就被判 `complete`：超过一页（200 条）的会话只存下最新一页，却对外声明「已完整归档」，同时回填拿不到 offset，永远重读同一页。这条已修，回归测试见 `message-projector.test.ts`「keeps walking a full page the Gateway said nothing about」。
- 消息字段同批核对：真机的频道字段是 `sourceChannel`（不是 `channel`），`sessionId` 只在**页面顶层**、消息行内没有——后者改为从页面读取，因为它正是判断 transcript 是否换代的依据，比会话表里存的那个更新。实测两个真实会话 6/6、2/2 全部成功投影，无丢弃，角色 / messageId / 时间戳全部命中。仍未被任何别名认领的键：`api`、`idempotencyKey`、`isError`、`model`、`provider`、`stopReason`、`toolCallId`、`usage`、`sender*`——前者多为逐条用量与工具错误标记（可作为后续信号来源），`sender*` 是刻意不入库的身份信息。
- 容量判定不在写路径上做。`usage()` 依赖 `dbstat`，会遍历全部页——按定时器去问，等于只要 collector 在跑就每隔几分钟在同步路径上走一遍整个库。改为：启动时测一次，驱逐搬动了大量数据后测一次，每轮 prune 之后（由 `markUsageStale()` 通知）测一次；三者都是罕见或本来就在做重活的时机。其间用本轮写入量递增估算。
- 估算必须换算到页字节口径。预算比的是 `dbstat` 的页字节（含索引与 FTS 影子表），而一轮只知道自己写了多少 UTF-8 内容字节，两者相加是把两种量当同一种：估算实际以真实增速的约三分之一爬升，越线时早已超出。因此按上次测量得到的 `storedBytes / contentBytes` 比率放大后再累加（下限 1，空库不会算出「文本比自身还小」）。
- `chat.history` 的字段名与 `sessions.list` 一样来自协议文档而非实测，经 `MESSAGE_FIELD_ALIASES` 声明式读取，未命中项由 `/api/v1/diagnostics/field-coverage` 的 `chat.history` 报告列出。
- 幂等键要求 Gateway 给出消息序号。若未给出，序号由本地水位续编，此时改以 `messageId` 去重——否则重复拉取同一页会拿到一批新序号，绕过唯一约束。

### 7.2 幂等与代际

`(session_key, seq)` 是幂等键。重复拉取同一段历史必须是无操作而不是产生重复行。

`sessionId` 变化意味着同一 `sessionKey` 下 transcript 换代（compaction 或重建）。此时不覆盖旧消息，而是给旧消息打上 `superseded_by_session_id`，新代际从 `seq = 0` 重新开始。理由是压缩前的原始对话往往正是回顾时想看的内容，直接覆盖等于让归档失去意义。

Gateway 侧若重写了已同步区间的内容，本地保留先到的版本并记 `divergent` 标记，不做自动覆盖。实现落在 `append()`：插入冲突后再判一次正文是否真的不同，不同才置 `divergent = 1`（相同则连写都不发生）。这个标记必须在阅读器里露出来（消息头的 `rewritten upstream`），否则等于没标——页面会读起来像某个上游早已改口的回合的忠实副本。

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

检索没有自己的路由，落在 `/sessions` 上，`q=` 与其余筛选一样进 query string。它与列表回答的是两个问题——「哪些会话提到过这个」与「哪些会话值得复盘」——所以渲染成独立的结果块，不伪装成对下方列表的过滤（会话列表无法按正文过滤，硬做只会让两种语义混在一处）。同一个页面上的 `agentId` 筛选同时收窄检索，这正是两字中文查询能被服务的前提。

`mode: "fallback"` 与 `truncated` 必须在界面上明示。截断的结果不是「就这些」，回退扫描也只覆盖了被收窄的那部分；把这两点藏起来，读者会把一次不完整的检索当成结论。同理，`query_too_short` 的 `hint` 要原样透出——服务端已经说清了出路，只显示「400」等于把它扔掉。

### 7.4 渲染

正文是不可信输入。以 React text node 渲染，不执行 Markdown、不注入 HTML，遵守现有 CSP。搜索高亮基于字符偏移量在文本节点内切分，不拼接 HTML 字符串。

### 7.5 抹除

```text
openclaw-collector purge-transcripts --config <path>
```

删除 `session_messages` 与 FTS 索引全部内容、保留会话与用量元数据、执行 `VACUUM` 使数据不可从空闲页恢复，并删除 `*.bak` 迁移备份文件（备份同样含正文）。命令必须在非交互环境下要求 `--yes` 显式确认。

该命令不要求 Gateway token。抹除是纯本机操作，而需要抹除正文的场景往往正是 token 已被吊销之后；要求先恢复 token 才能删除本机数据是本末倒置。`loadConfig` 因此对这一条命令放开 token 校验，其余校验不变。

不变量 10 要求「持续明示、不得静默开启」。这是两条，要两处落地：

- **持续明示**在 Connections 页的归档面板：存了多少条、占多少空间、保留多久、上一轮同步结果，以及抹除命令本身。
- **不得静默开启**意味着 `transcriptSync` 默认必须是 `disabled`。首版默认 `enabled`，而配置样例里没有这个键、README 里也没有记载——升级进这个版本的人从没被问过，唯一的告知在一个他可能永远不会打开的页面上。这正是不变量要禁止的情形，即使功能本身是用户要的。改为显式选择后，`storage` 下的其余键只决定「留多少」，而不再决定「要不要留对话原文」。
- 开启时每次启动都在终端打印一行：存在哪、留多久、怎么抹除。开关是在配置文件里拨的、进程是在终端里起的，所以终端必须是知情的一环——只在浏览器里告知，管不到用脚本起服务的那条路径。

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
- 达到 `transcriptMaxBytes` 后停止历史回填、活跃增量不中断、按会话整体驱逐，无消息被静默丢弃。驱逐不会命中近 15 分钟内有活动或仍有 open run 的会话；若只剩这类会话仍超限，则停止归档并在 Connections 面板明示「Full — new messages not stored」，同样不静默。
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
- 检索输入连打不产生每键一次请求：防抖后只发一次，被取代的在途请求被 abort，且取消不显示为错误。
- 事件流被阻断时页面顶部明示状态：仍在重试报出第几次，浏览器放弃则报「已停止」并给手动重连；重连成功后提示消失且数据刷新。
- 时间：紧凑显示不含时区，`title` 与 `dateTime` 给出带时区的精确时刻，正文面板声明一次所用时区。
- 窗口化列表的视口高度随窗口收敛（900×600 与超高窗口下均无需外层滚动即可读到列表末尾），滚动到底不出现空白段。

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
| S8 | Agent 详情页 + 跨会话检索接入界面 | 三个页面齐备 |

S1 到 S3 没有界面产出。跳过它们会导致后续每一步都建在错误的地基上：没有迁移框架就无法安全加表，没有 Session 实体就无法做任何 per-session 聚合，没有分页 API 就只能把会话塞进全量 snapshot。

正文相关的表在 S1 的 version 2 迁移里一次建好，即使写入逻辑要到 S5 才落地。理由是正文表会改变整库的体量与安全定级，把它留到后面意味着第二次迁移加一次全库回填。

## 11. 明确的后续项

- `session.observer` 的 headline 是否纳入采集，待实测其内容边界后由 v1.2 修订决定。
- compaction 与 context pressure 若被证实可从公开面观测，再补充上下文类扣分项。
- 两字中文词的检索目前只能走 `LIKE` 回退。若实际使用中这类查询占比高，再评估引入 CJK bigram 自定义分词器——`node:sqlite` 不支持加载扩展，届时需要重新评审 SQLite 驱动的选型。
- 正文归档是否需要静态加密，取决于用户的磁盘加密状况。当前依赖操作系统全盘加密，不在应用层再加一层。
- 健康评分的 penalty 权重需要在真实数据上标定，首版直接沿用 AgentsView 的取值只作为起点，且必须带 `algorithmVersion`。
- 键盘导航模型（蓝图完成门第 7 条）在 Agents 会话面落地后统一补齐，不在本规格内拆分。
