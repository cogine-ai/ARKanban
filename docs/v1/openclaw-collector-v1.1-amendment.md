# OpenClaw Collector v1.1 契约修订：Agents 会话面

状态：Proposed

提出日期：2026-08-15

修订基线：`7af4cfb fix(deps): upgrade @fastify/static to 10.1.3`

被修订文件：[OpenClaw Collector v1 完整蓝图](./openclaw-collector-v1-blueprint.md)

配套实施规格：[AR Kanban Agents 会话面实施规格](./ar-kanban-agents-session-implementation-spec.md)

## 1. 为什么需要这份修订

蓝图 §13.3 列出的重新评审触发器中，以下两条已被本次需求命中：

```text
要求保存 prompt、transcript、tool args/result 或合规级审计
```

蓝图同时在最后一段规定：

```text
没有明确 amendment 的实现不得偏离本文件
```

因此在写任何代码之前，必须先冻结这份修订。本文件只修改被明确列出的条目；未列出的条款一律继续按 v1 蓝图执行。

本次修订服务于一个新增的产品面：**Agents 会话面**（Agents 总览 / Agent 详情 / Session 详情）。它回答的是「回顾」类问题，与 Live Flow 回答的「此刻」类问题互补。

需要一句话说清这份修订的性质：它不是在 v1 的白名单上追加字段，而是**撤销 v1 最核心的一条隐私不变量**。v1 可以宣称「数据库泄露不等于对话泄露」，v1.1 之后不能。第 2.2 节说明为什么这个代价无法回避，第 6 节给出替代的约束集。

## 2. 修订 §8.2 数据白名单

### 2.1 新增允许存储的字段

在原有允许清单（ID、Agent、runtime、闭集状态、时间、tool name/toolCallId、bounded sanitized Task display fields、audit errorCode）之外，新增：

**会话档案（来自 `sessions.list` / `sessions.describe` / `sessions.get`）**

| 字段 | 说明 |
|---|---|
| `sessionId` | Gateway 侧稳定会话 ID |
| `label` | Gateway 已公开的 bounded 会话标签，与 Task `title` 同级，属于允许的用户派生展示元数据 |
| `agentRuntime` | 运行时后端标识 |
| `model` | 已解析的 canonical model 名 |
| `category` | 自定义分组名 |
| `parentSessionKey`、`forkSource`、`previousSessionId` | 会话血缘引用 |
| `spawnedBy`、`spawnDepth`、`subagentRole` | subagent 血缘，闭集或引用 |
| `createdVia`、`createdAt`、`archivedAt` | 创建来源与生命周期时间 |
| `placement` | 闭集放置状态 |
| `worktree.branch` | 分支名。**不存 `repoRoot` 等宿主绝对路径** |

**用量与成本（来自 `sessions.usage` / `usage.cost`）**

| 字段 | 说明 |
|---|---|
| input / output / cache 读写 token 计数 | 纯数值 |
| 成本 | 固定为整数微美元，禁止浮点 |
| 模型名与计价来源标记 | 闭集或已公开的模型标识 |
| peak context token | 纯数值 |

**消息生命周期元数据（来自 `audit.activity.list` 的 `kind: "message"`）**

| 字段 | 说明 |
|---|---|
| `direction`、`channel`、`conversationKind`、`outcome` | 均为闭集 |
| `durationMs`、`resultCount` | 纯数值 |
| `reasonCode`、`errorCode` | 闭集 code |

明确排除：该 audit 变体携带的 `hmac-sha256:v1:...` 消息身份引用与 channel sender actor id **不得入库**，与 v1 对 audit `sessionKey/sessionId` 的处理保持一致。

### 2.2 撤销对会话正文的存储禁令

这是本修订影响最大的一条，单独列出。

v1 §8.2 规定 message body 与 assistant 文本禁止进入任何持久化存储。产品决策要求会话正文可搜索、可留档、且在 Gateway 断线时仍可读取。这三项能力没有任何一项能在不落盘的前提下实现：搜索需要索引，索引即副本；留档要求正文在 Gateway 侧清理后仍然存在；离线可读要求本地是完整副本而非缓存。

因此撤销该禁令，改为受控存储：

```text
会话正文（user / assistant / system / tool 消息文本）允许以完整原文形式
持久化到本机 SQLite，并建立全文索引。
```

这条改动使 ARKanban 的本地数据库从「元数据观测库」变为**一份完整的对话副本**。安全立场随之改变：数据库文件本身成为高价值目标，其文件权限、备份文件与磁盘加密从次要事项升级为主要防线。第 6 节给出替代性的约束集。

### 2.3 仍然禁止的内容

撤销只针对会话正文。以下内容继续禁止进入任何持久化存储、日志与 SSE：

- tool args、tool result、command output
- approval reason / command / message
- raw error text、完整 stack
- secret、token、凭据，以及任何宿主绝对路径

正文中若内联出现上述内容（例如用户把一段 stack 粘进对话），按正文处理——它已经是对话的一部分，不做二次切分。这是一个自觉接受的模糊边界，不假装能精确剥离。

### 2.4 新增类别：local_archive

v1 白名单只区分「允许存储」与「禁止」。本次新增第三个类别：

```text
local_archive —— 允许以完整原文持久化到本机 SQLite 并建立索引，
                 允许经 HTTP 响应体到达本机浏览器，
                 但禁止进入日志、禁止进入 SSE、禁止进入 diagnostic bundle、
                 禁止任何形式的外部 egress。
```

当前唯一属于该类别的数据是**会话正文**，来源为 `chat.history` 与 `chat.message.get`。

约束该类别的硬性不变量见第 6 节。

## 3. 修订 §14 完成门第 5 条

原条款：

```text
浏览器 bundle、SSE、普通日志和 observations 中无 secret、完整 raw prompt、
message/assistant/thinking body、tool args/result/raw error；
HTTP/SQLite 只允许本文件白名单中的 bounded Task display fields。
```

修订为：

```text
浏览器 bundle、SSE、普通日志、observations 和 diagnostic bundle 中无 secret、
tool args/result/command output、approval 内容、raw error text。

会话正文属于 local_archive：允许存入 SQLite 的 session_messages 及其全文索引，
允许经 HTTP 响应体到达本机浏览器，但不得出现在日志、SSE 与 diagnostic bundle 中。

SQLite 的其余部分只允许 §8.2（含 v1.1 修订）白名单中的字段。
```

配套要求：完成门必须验证 diagnostic bundle 在数据库含正文时导出的产物内不含任何正文片段。

## 4. 修订 Gateway 方法清单

### 4.1 必需方法不变

```text
tasks.list
sessions.list
sessions.subscribe
```

新增能力全部为可选。任何一项缺失都不得让 `syncState` 变为 `incompatible`，只降级对应的 coverage。

### 4.2 新增可选方法

| 方法 | 用途 | 缺失时 |
|---|---|---|
| `agents.list` | Agent 名册、model/runtime、`kind` | 从已观测的 `agentId` 反推名册，标 `partial` |
| `sessions.describe` | 单会话完整行与血缘 | Session 详情只用 `sessions.list` 行，血缘标 `unavailable` |
| `sessions.usage` | 每会话 token 与成本 | 用量 coverage 标 `unavailable`，不影响其他面 |
| `sessions.usage.timeseries` | 单会话用量趋势 | 详情页隐藏趋势图 |
| `usage.cost` | 按范围聚合成本 | 回退为按会话累加，并标注为估算 |
| `audit.activity.list`（`kind: "message"`） | 消息生命周期元数据 | 消息计数标 `not_observed` |
| `chat.history` | 会话正文同步（local_archive） | 正文停留在最后一次成功同步的位置，标 `stale`；已同步部分仍可读可搜 |
| `chat.message.get` | 单条消息补齐 | 该条标 `truncated`，不阻塞其余消息 |

`agents.list` 在 v1 中已被 Cron 归属使用但结果未暴露；本修订把它提升为 Agents 会话面的正式数据源。

### 4.3 新增规则：不可发现方法的探测

蓝图 §10 的 hello preflight 假设「advertise 即可用、未 advertise 即不可用」。OpenClaw protocol 文档明确否定了后半句：

```text
hello-ok.features.methods 是一份保守的发现列表，不是完整枚举；
sessions.usage 等方法被刻意排除在外，但真实可调用。
```

因此新增规则：

1. 对标记为「不可发现」的方法，preflight **不得**依据 hello 判定不可用。
2. 连接建立后执行一次最小参数的探测调用，结果缓存在当前 connection generation 内。
3. 必须区分三种结果：`METHOD_NOT_FOUND` 归为 `unavailable`（不再重试）；权限错误归为 `unauthorized`；其他失败归为 `error`（下一轮 reconcile 重试）。
4. 探测调用本身必须是只读且无副作用的。

当前适用于该规则的方法：`sessions.usage`、`sessions.usage.timeseries`、`usage.cost`。

### 4.4 保留的禁令

`sessions.messages.subscribe` 与 `session-scoped-events` capability **继续禁止声明**。理由与 v1 相同：一旦声明，公共 `agent` 事件的全局 fanout 会转为逐 Session 订阅模式，直接破坏现有 Live Flow 的事件覆盖。

正文同步只能通过请求-响应式的 `chat.history` 增量拉取，不能订阅。这意味着本地副本相对 Gateway 存在同步延迟，正文视图必须显示同步水位而不是假装实时。

## 5. 修订 §6 领域模型

v1 只有 Activity 一个一等实体，Session 以 `session_key` 字符串字段的形式挂在 Activity 上。本修订把领域模型改为三层：

```text
Agent  1 ── N  Session  1 ── N  Activity
```

约束：

1. `Session` 的主键是 Gateway 的 `sessionKey`；`sessionId` 作为附加事实存储，用于识别同一 key 下的 transcript 代际更替。
2. Activity 新增 `session_ref` 外键列。既有的 `session_key` 列保留：`session_key` 是事件声称的 key，`session_ref` 是已确认存在于 `sessions` 表的引用，「有 sessionKey 但该 Session 尚未被 `sessions.list` 观测到」是合法中间态，合并两者会抹掉这个状态。
3. `Agent` 不是权威注册表的副本，而是 Collector 观测到的名册。`agents.list` 可用时以它为准，不可用时由观测反推并标 `partial`。
4. Session 实体的生命期与 Activity 的 retention **解耦**，见第 7 节。
5. Message 成为第四层实体：`Agent 1─N Session 1─N Message`。它与 Activity 是同一 Session 下的两个平行子集，互不派生。

## 6. local_archive 的硬性不变量

正文落盘换来了能力，也换掉了 v1 「数据库泄露不等于对话泄露」这条最省心的性质。以下不变量是它的替代品，违反任意一条即为 P0。

**边界约束**

1. 正文不出本机。禁止任何形式的外部 egress，包括遥测、崩溃上报、云端索引与嵌入式向量服务。语义搜索继续不做，理由与 v1 相同。
2. 正文不进日志，包括 debug 级别。同步失败只记录 sessionKey 的 keyed digest、消息序号与闭集错误码。
3. 正文不进 SSE。同步进度以计数与水位时间戳的形式广播，不含任何片段。
4. 正文不进 diagnostic bundle。bundle 生成器必须显式白名单化其收集的表，不得使用「导出整库」式实现。
5. 正文端点与其余 API 共用同一套 loopback、Host、Origin、`Sec-Fetch-Site` guard，不得有任何放宽。
6. 正文以 React text node 渲染，不执行 Markdown 或 HTML，遵守现有 CSP。存储的是不可信输入，渲染路径必须假定其中含有攻击载荷。

**存储约束**

7. 数据库文件 `0600`、数据目录 `0700`。迁移备份文件（`*.bak`）同样含正文，必须以 `0600` 创建并纳入同一套清理策略。
8. 正文写入只允许经由一个集中的 archive 写入模块。仓库中不得存在第二条把 `chat.history` 结果写入其他表的代码路径。
9. 必须提供 `purge-transcripts` 运维命令：一次性删除全部正文与索引、保留元数据、执行 `VACUUM` 使数据不可从空闲页恢复，并同时清理迁移备份文件。

**用户可见性**

10. UI 必须持续明示「本机已存档完整对话正文」，而不是把它藏在设置里。首次启用正文同步时必须显式告知，不得静默开启。
11. 正文视图必须显示同步水位（最后成功同步时间与已同步消息数），不得让延迟的本地副本看起来像实时内容。

## 7. 修订保留策略

v1 只有一个 `terminalRetentionDays`，`prune` 只删除 `catalog = 'terminal_history'` 的 Activity。本修订改为分表策略：

| 数据 | 保留 | 理由 |
|---|---|---|
| Session 档案 | 长期，不随 Activity 被裁剪 | 会话是分析的骨架；跟随 30 天 Activity 裁剪会让历史一到期就断片 |
| **会话正文与全文索引** | **默认 180 天，可配置；另受体量上限约束** | 体量最大且最敏感的一类，需要时间与容量双闸门 |
| 用量原始快照 | 默认 90 天，可配置 | 体量次大 |
| 用量按天 rollup | 长期 | 体量小，承载长周期趋势 |
| 消息生命周期元数据 | 跟随 Gateway audit 的 30 天窗口 | 上游本身就是 30 天，存更久也无法补齐 |
| 派生信号 | 随 Session；可随时重算 | 存算法版本号，便于升级后重算 |
| Terminal Activity | 维持 `terminalRetentionDays` | 不变 |

新增配置项：

| 配置 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `storage.usageRetentionDays` | 90 | 7–730 | 用量原始快照保留期 |
| `storage.transcriptRetentionDays` | 180 | 1–3650 | 正文保留期 |
| `storage.transcriptMaxBytes` | 2 GiB | 64 MiB–64 GiB | 正文加索引的体量上限 |
| `storage.transcriptSync` | `"enabled"` | `enabled` / `disabled` | 关闭后停止同步，已存内容保留至过期或被 purge |

体量上限的降级行为必须是可预期的：达到上限时停止拉取新的历史回填，继续同步活跃会话的增量，并按会话最后活动时间从最旧一端驱逐，同时在 UI 上标明已进入容量驱逐状态。**不得**静默丢弃新消息。

### 7.1 实测的体量基准

以下数据来自本机 Node 22.16 内置 `node:sqlite` 的实测，作为容量规划依据：

| 方案 | 10 万条消息（109 MB 中英混合原文） | 可搜索 |
|---|---|---|
| 纯文本表 | 130 MB | 否 |
| 文本 + trigram FTS5 | 204 MB | 是 |
| gzip blob | 21 MB | 否 |

全文索引开销约为原文的 0.67 倍。默认上限 2 GiB 约对应 100 万条消息。

### 7.2 分词器选择及其能力边界

`node:sqlite` 编译时启用了 `ENABLE_FTS5`，无需替换 SQLite 驱动。但默认 `unicode61` 分词器把连续中文视为单一 token，**完全无法检索中文**，实测 `登录接口` 在含该词的文档上命中 0 条。

因此固定使用 `tokenize='trigram'`。随之而来的能力边界必须写进产品行为而不是留给用户猜：

1. 搜索词短于 3 个字符时 FTS5 无法匹配。两字中文词（`登录`、`部署`、`报错`）属于此列。
2. 短查询回退为 `LIKE` 扫描，且必须限定在已按时间或会话收窄的候选集内，不得全库扫描。
3. UI 必须说明最小搜索长度，而不是返回空结果了事。

## 8. 新增完成门条目

在 §14 现有 12 条之外新增：

13. 自动化审计证明 local_archive 的边界不变量：正文不进日志、不进 SSE、不进 diagnostic bundle，且写入路径只有一个集中模块。审计必须在数据库确实含正文的状态下运行。
14. schema 迁移具备版本号、顺序执行、迁移前自动备份和回滚验证；从 v1 基线库升级到 v1.1 后，既有 Live Flow 行为无回归。
15. `sessions.usage` 不可用、未授权与失败三种情况分别显示 `unavailable`、`unauthorized`、`error`，且不影响 Task/Session 主同步的 Live 状态。
16. `purge-transcripts` 命令执行后，正文与索引均不可从数据库文件（含空闲页）与迁移备份文件中恢复。
17. 正文体量达到 `transcriptMaxBytes` 后进入容量驱逐状态，活跃会话的增量同步不中断，且无新消息被静默丢弃。
18. 中文检索验证：≥3 字符的中文查询能命中，<3 字符的查询走受限 `LIKE` 回退且 UI 给出最小长度说明。

## 9. 明确未修订的条款

以下 v1 不变量继续完整生效，本修订不触碰：

- 只申请 `operator.read`，不调用任何 Gateway 写方法。
- 固定监听 loopback；非 loopback 配置拒绝启动。
- Host / Origin / `Sec-Fetch-Site` guard 与 CSP 不放宽。
- 远程 Gateway 必须 `wss://`。
- 单 Gateway、单机 SQLite；不引入 PostgreSQL、DuckDB 或任何远程数据库。
- 不引入外部网络 egress，因此不做语义搜索与生成式 insight。正文落盘后这一条的重要性不降反升。
- 数据目录 `0700`、数据库文件 `0600` 不变，且现在适用于迁移备份文件。
- tool args 中的文件路径继续禁止采集，因此不实现文件级变更流。

## 10. 遗留决策

以下条目留待实现期间用真实 Gateway 验证后补充修订，不阻塞本文件冻结：

1. `session.observer` 事件携带的 headline 属于「模型生成的有界摘要」，既不是原始正文也不是纯元数据。是否纳入白名单需要先观测其真实内容边界。当前默认**不采集**。
2. `artifacts.list` 返回的 transcript 派生 artifact 摘要是否含内容派生文本，需要实测确认。当前默认**不调用**。
3. compaction 与 context pressure 是否可从公开事件面观测，需实测。若不可得，健康信号中的上下文类扣分项整体省略，而不是猜测。
