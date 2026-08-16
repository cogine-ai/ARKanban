# 真机字段校准记录

## 这份文档是给谁的

给**准备对着真实 OpenClaw Gateway 排查字段问题的人**。

原来这里写的是「字段名是照协议文档猜的，去真机上查出错在哪」。查已经查过了，所以本文档现在记录的是**查到了什么、改了什么、还剩什么不确定**。先读第 1 节，别重复劳动。

---

## 1. 已经核实过的部分（OpenClaw 2026.7.1-2）

不需要连上 Gateway 就能核实字段形状：`openclaw` 的 npm 包里带着未混淆的响应构造代码和协议文档。

```
$(npm root -g)/openclaw/dist/
  session-utils-DD3pe_2A.js      buildGatewaySessionRow / classifySessionKey
  usage-Suf4MGML.js              sessions.usage / usage.cost 的 handler
  session-cost-usage-B0dBxiXW.js 用量与成本的累加逻辑
  chat-pg-BxhF6.js               chat.history / chat.message.get
  schema-BuOFpc7K.js             全部请求参数 schema（含 additionalProperties）
```

**看 handler 构造响应的那几行，比看协议散文可靠。** 参数 schema 尤其重要：多数方法带 `additionalProperties: false`，多传一个键就是整个调用失败，不是被忽略。

以下都已按真实名字修正并落了回归测试（提交 `9610080`）：

| 逻辑字段 | 真实形状 | 原来错在哪 |
|---|---|---|
| 会话的 agent | 行上**没有** `agentId` | 只能从 `key` 解析，回退路径本来就在，但清单会一直报 `agentId` 缺失，这是正常的 |
| 创建时间 | **不存在** | 别名里的 `startedAt` 是最近一次 run 的开始，会把跑了三个月的会话标成刚创建 |
| fork 来源 | `forkedFromParent` | 猜的三个名字全不存在 |
| 运行时 | `agentRuntime` 是 `{ id, source }` | 名字命中、类型不符，取 string 得到 undefined |
| Agent 的模型 | `model` 是 `{ primary, fallbacks }` | 同上 |
| Agent 的名字 | `name` | `displayName` 不存在（好在它是第二个别名） |
| Agent 的种类 | **不存在** | 名册里没有任何 system/内建标记，全部只能是 `unknown` |
| 会话 `kind` | 只有 `global`/`unknown`/`group`/`direct` | 见 §2.1 |
| 正文分页 | `offset` / `nextOffset` | 发 `cursor` 会被 schema 拒收 |
| 消息 id 与序号 | `__openclaw.id` / `__openclaw.seq` | 顶层没有，幂等键和 `chat.message.get` 都会落空 |
| 用量选择器 | `key` | 发 `sessionKey` 时整个 `sessions.usage` 调用报错 |
| 用量计数 | 嵌在 `usage` 对象里 | 读顶层得到 undefined，静默归零 |
| 成本 | `usage.totalCost`，单位**美元** | 我们的 micro-USD 换算方向本来是对的，问题只是路径 |
| 未定价信号 | `missingCostEntries`（计数） | `unpricedModels` 不存在，且真机**不告诉你是哪些模型** |
| 上下文峰值 | **不存在** | 别名里的 `contextTokens` 是模型的上下文**窗口**，会把 200k 预算报成 200k 已用 |

### 这些修正已经端到端验证过

模拟 Gateway（`scripts/mock-gateway.ts`）的响应形状已按真机改写，包括 `sessions.usage` 会像真机一样**拒收** `sessionKey` 参数。对着它跑一轮 64 会话：

| 指标 | 结果 | 修之前会是 |
|---|---|---|
| `runtime` 非空的会话 | 64 / 64 | 0（对象当字符串读） |
| `model` 非空的会话 | 64 / 64 | 0（同上，Agent 侧） |
| `kind_hint` 分布 | fork 21 / main 22 / subagent 21 | 全部 main（`kind` 恒为 `direct`） |
| 用量快照 | 52 行（36 已定价、16 只是下界） | 0（调用被 schema 拒收） |
| 归档消息 | 263 条，序号与 id 来自信封 | 0（幂等键读不到 id） |
| 名册 agent | 17 条 roster | 名字退化成 id |

诊断端点的 `unknown` 列表现在只剩**真机确实返回、而我们有意不读**的键，可以当作待办清单读：`sessions.list` 的 `totalTokens`/`estimatedCostUsd`/`contextTokens`/`totalTokensFresh`/`status`、`agents.list` 的 `workspace`（宿主机路径，隐私约束不存）、`usage.cost` 的 `daily`/`totals`（见 §2.4）。

### 反方向的发现：`sessions.list` 已经带用量

会话行里就有 `inputTokens`、`outputTokens`、`totalTokens`、`estimatedCostUsd`、`contextTokens`，还有一个 `totalTokensFresh` 说明这数准不准，以及一个我们没读的 `status`。

也就是说 S6 那一整套「探测 `sessions.usage` → 存快照 → 做 rollup」，有相当一部分可以由每 8 秒本来就要拉的会话索引直接给出，不额外发一次请求。**动手改之前先量一下** `totalTokensFresh` 在真机上的占比，它为 false 时那个数字是转写自 transcript 的估算。

---

## 2. 语义陷阱（名字对、意思不对，最危险）

这类问题诊断端点查不出来——字段命中了，清单显示一切正常。

### 2.1 `kind` 无法表达 fork 与 subagent

`classifySessionKey` 只回答四个值，判断逻辑是「`global` → `unknown` → `chatType` 是群 → 否则 `direct`」。fork 出来的会话和 subagent 会话都报 `direct`。

所以 `projectSession` 用**血缘**决定这两类：`subagentRole`/`spawnedBy`/`spawnDepth>0` → subagent，`forkedFromParent` → fork，然后才轮到 `kind`。`group` 不映射成 `main`，留在 `unknown`——它确实不是主会话。

这条推翻了原来第 6 节的验收标准之一：**`kind_hint` 里出现 `unknown` 不再是映射表没补全**，群会话本来就该在那里。

### 2.2 `sessions.usage` 是范围聚合，不是会话累计

返回的是**日期窗口内**的求和，默认最近 30 天，不是会话生命周期快照。照默认参数轮询，一个老会话的总量会随着早期消息滑出窗口而**变小**，而存储层把每次读数当累计值。

现在的调用是 `{ key, range: "all", groupBy: "family" }`：

- `range: "all"` 把聚合窗口拉到全部历史，读数才真的是累计值；
- `groupBy: "family"` 把 transcript id 轮转过的会话合成一行，这正是归档按 `sessionKey` 而不是 `sessionId` 存的那件事。

### 2.3 `sessions.usage.timeseries` 一个点上有两套数

`input`/`cost` 是这一轮的增量，`cumulativeTokens`/`cumulativeCost` 才是会话内累计。混用会算错，目前没有代码读它。

### 2.4 `usage.cost` 没有 per-agent 分解

响应是 `{ updatedAt, days, daily[], totals }`。`agentScope: "all"` 只是把所有 agent 合并进 `totals`，不会分开。**按 agent 分解只有 `sessions.usage` 的 `aggregates.byAgent` 有。**

我们现在发的 `{ from, to, groupBy: "agent" }` 三个参数在真机上都不存在，调用会直接失败——失败是诚实的，所以先留着，但 S6 的成本覆盖层需要重写成走 `aggregates.byAgent`。**这是还没做的事**，见 §4。

---

## 3. 版本差异：audit

蓝图里写的 `audit.activity.list`（配 `kind: "message"`）和 `audit.run.inspect` 在 2026.7.1-2 上**都不存在**，只有 `audit.list`，`kind` 只接受 `agent_run` 和 `tool_action`。

它的状态词表是 `started`/`succeeded`/`failed`/`cancelled`/`timed_out`/`blocked`/`unknown`，和我们派生信号的结论对得上。

而且：**collector 目前一个 audit 方法都没调用。** 蓝图要求的「advertise 之后必须采集」从未落地。所以这里既是版本差异，也是功能缺口——真机上先跑 `openclaw` 的 `audit.list` 看看有没有数据，再决定要不要接。

---

## 4. 还没做的事

1. **`usage.cost` 的成本覆盖层**要改成读 `sessions.usage` 的 `aggregates.byAgent`（§2.4）。现在它每轮都拿不到可用数据，诊断端点里 `usage.cost` 的 `consumed` 是空的。
2. **考虑用 `sessions.list` 自带的 token/成本**替代部分 `sessions.usage` 轮询（§1）。
3. **audit 采集**完全没实现（§3）。
4. **Agents 页的「系统 agent 折叠」没有数据来源**。`web/src/views/Agents.tsx` 按 `agent.kind === "system"` 分组，而名册里没有任何字段能区分内建 agent，真机上所有 agent 都会落在主列表。要么找别的信号（例如只由 cron 触发的 agent），要么去掉这个分组。
5. **真机跑通**：本机 Gateway 的会话库还是空的（`sessions.json` 0 entries），得先有真实对话才能验证投影。

---

## 5. 仍然有用的排查手段

### 诊断端点

```bash
curl -s http://127.0.0.1:47123/api/v1/diagnostics/field-coverage | jq
```

**只输出字段名，不输出任何会话内容。**

| 字段 | 含义 | 该怎么办 |
|---|---|---|
| `consumed` | 命中的 key | 不用管 |
| `unknown` | 真机返回了、没有任何别名认领的 key | 重点看这里 |
| `missing` | 某个逻辑字段的**整个**别名列表都没命中 | 和 `unknown` 对照配对 |

注意 `missing` 里有几项是**预期**的，不是 bug：`agentId`（行上确实没有）、`createdAt`、`placement`、`previousSessionId`、`worktree`、`peakContextTokens`——真机不提供它们。

### 改映射的规则

改 `src/activity/session-projector.ts`、`message-projector.ts`、`usage-projector.ts` 顶部的别名表，**把真名加到列表最前面，不要删旧别名**（别的 Gateway 版本可能还在用）。匹配按顺序取第一个非 null 值。

如果真名对应的是**对象**，别名不够——得用 `asNamed()` 那类取值函数，见 session projector 里 `agentRuntime` 的处理。

### 用量与正文的嵌套读法

`chat.history` 的消息元数据在 `__openclaw` 下，`sessions.usage` 的计数在 `usage` 下。两个 projector 都是先读顶层、再读嵌套层，所以别名表里写内层的名字也能命中。

---

## 6. 验收（真机有数据之后）

```bash
sqlite3 <db路径> <<'SQL'
SELECT COUNT(*) AS sessions_total FROM sessions;
SELECT kind_hint, COUNT(*) FROM sessions GROUP BY kind_hint;
SELECT origin, COUNT(*) FROM agents GROUP BY origin;
SELECT COUNT(*) AS with_runtime FROM sessions WHERE runtime IS NOT NULL;
SELECT COUNT(*) AS with_usage FROM session_usage_snapshots;
SQL
```

判断标准：

1. `sessions_total` 应明显大于 Live Flow 里的活跃会话数——归档发生在过滤之前，两个数字相等说明接错线了。
2. `agents` 的 `origin` 应以 `roster` 为主。全是 `observed` 说明 `agents.list` 没成功，而它的失败是静默的。
3. **`with_runtime` 应该非零**。这一项专门盯 §1 里那个「对象当字符串读」的错误——它修好之前这里恒为 0。
4. **`with_usage` 应该非零**。修好之前 `sessions.usage` 每次调用都报错，这张表永远是空的。
5. `kind_hint` 的 `unknown` 占比高**不一定**是问题，见 §2.1。

---

## 7. 设计约束（改代码时别破坏这些）

1. **归档失败不得改变 `CollectorSyncState`**。`archiveSessions()` 用独立的 `sessionArchiveError` 诊断字段，不要改成 `setSource()`——那会让次要功能的失败拖垮主同步状态。
2. **`agents.list` 的失败必须静默**，退化成从 session 推断（`inferAgents`），`observed` 条目不覆盖 `roster` 条目。
3. **agent 名册用独立定时器**（300s），不搭 session 的 8s 车。
4. **探测和名册在首次快照之后才跑**，不延迟第一次权威快照。
5. **探测保持只读**（`PROBE_PARAMS` 都是 `{ limit: 1 }`），绝不能有副作用。
6. **worktree 只取 `branch`**。宿主机路径不允许落库（v1.1 修正案 §8.2），这是隐私约束，不是遗漏。

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `src/activity/session-projector.ts` | 会话与 Agent 的别名表和投影 |
| `src/activity/message-projector.ts` | 正文的别名表、`__openclaw` 信封、offset 分页 |
| `src/activity/usage-projector.ts` | 用量与成本的别名表、`usage` 嵌套 |
| `src/collector/usage-sync.ts` | `sessions.usage` / `usage.cost` 的调用参数 |
| `src/collector/field-inventory.ts` | 字段清单统计 |
| `src/collector/capability-probe.ts` | 不可发现方法的探测与分类 |
| `src/http/server.ts` | `/api/v1/diagnostics/field-coverage` |
| `scripts/mock-gateway.ts` | 模拟 Gateway，形状应当照真机改 |

改完跑 `npm run typecheck && npm test`。
