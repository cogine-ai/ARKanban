# 真机字段校准记录

## 这份文档是给谁的

给**准备对着真实 OpenClaw Gateway 排查字段问题的人**。

原来这里写的是「字段名是照协议文档猜的，去真机上查出错在哪」。查已经查过了，所以本文档现在记录的是**查到了什么、改了什么、还剩什么不确定**。先读第 1 节，别重复劳动。

---

## 0. 怎么拿真实响应（不用碰 token）

`openclaw gateway call` 用的是 CLI 自己的认证，所以取真实 payload 完全不需要处理 token：

```bash
openclaw gateway call sessions.list --json --params '{"limit":20}' \
  | npx tsx scripts/inspect-gateway-payload.ts sessions
```

`scripts/inspect-gateway-payload.ts` 有五个模式：`shape` 只打印字段名、类型和字符串长度；`sessions`/`history`/`usage`/`audit` 把真实 payload 喂进 collector 自己的投影器，报出哪些字段真的填上了。

**它不打印任何字符串值。** payload 里除了对话正文，还有 `senderName` 这类联系人标识和 `MediaPath` 这类宿主机路径——「正文不进日志和诊断」这条规矩同样管这个脚本。抓下来的 payload 文件用完就删，别留在 `.fixtures/` 里。

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

### 真机复核（2026.7.1-2，有真实对话的 Gateway）

上面的修正随后在真机 payload 上逐条复核过，全部成立：`agentRuntime` 确实是 `{id, source}`、`model` 在名册里确实是 `{primary}`、行上确实没有 `agentId`（从 key 解析出 `main`，1/1 成功）、`kind` 确实是 `direct`、正文确实用 `offset`/`nextOffset` 分页且 id 与 seq 在 `__openclaw` 里（30 条消息 id 全拿到，序号是 Gateway 自己的 14..43）。

真机还暴露了两件包里看不出来的事，见 §2.5 和 §2.6。

### `runtime` 里就能看出 Codex / Claude Code

`agentRuntime.id` 不是固定的 `"openclaw"`。它是这个会话实际跑在哪个 harness 上：真机两个会话分别是 `{id: "codex", source: "implicit"}`（model `gpt-5.6-sol`、provider `openai`）和 `{id: "auto"}`（provider `codex`）。

session key 里带 `:acp:` 段的会话另算：`applyAcpRuntimeOverlay` 会把 runtime 覆盖成 **ACP 后端名**（拿不到名字才退化成 `acpx`），所以 Codex CLI、Claude Code 这类被 OpenClaw 当后端驱动的 agent，runtime 上直接写着是谁。

两个推论：

- 这正是「`runtime` 读成对象」那个 bug 的实际代价。修之前这一列每行都是 NULL，Agents 卡片一律显示 `runtime not reported`，**任何 runtime 都分不出来**；
- 反过来，脱离 OpenClaw 单独跑的 `claude` / `codex` CLI，Gateway 不知道它们的存在，collector 也就看不到——collector 只读 Gateway，这是边界而不是缺陷。

### 反方向的发现：`sessions.list` 带着几个用量字段——但不能用

会话行里就有 `inputTokens`、`outputTokens`、`totalTokens`、`estimatedCostUsd`、`contextTokens`、`totalTokensFresh`，以及一个我们没读的 `status`。

这份文档早先的版本据此提出：S6 那套「探测 `sessions.usage` → 存快照 → rollup」有一部分可以由每 8 秒本来就要拉的索引直接给出，不额外发请求。**这个结论是错的，别照着做**，理由见 §2.7。这些字段全部描述**最后一次运行**，不是会话累计。

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

### 2.5 `toolCall` 块没有任何文本字段

真机上一条助手回合的 content 是 `[{ type: "toolCall", id, name, arguments, input }]`——**没有 `text`，也没有 `content`**。原来的 `flattenContent` 只探 `text`/`content`/`value`，探不到就返回空串，而空正文的消息会被当成空行丢弃。

在一段 30 条消息的真实对话上，**13 条会被静默丢掉，全部是助手调用工具的回合**。归档下来的会读成：助手说了句话，然后工具结果自己冒出来了——调用那一步凭空消失。工具交换里信息量最大的恰恰是那一行。

现在 `flattenToolCall()` 把它渲染成 `工具名 + 参数 JSON`，参数照原样保留（和归档其余部分一致）。

### 2.6 `sessions.usage` 在真机上恒为零，而零不等于免费

真机上两个刚聊过的会话，`sessions.usage` 的 `totals` 全零、`aggregates.byAgent` 里 token 全零。第一次撞见时以为是缓存没算好（那个会话确实是 `cachedFiles: 0, pendingFiles: 1, staleFiles: 1`），但复核第二个会话时 `cacheStatus.status` 是 **`fresh`、`staleFiles: 0`，token 照样全零**，而 `aggregates.messages` 同时报着 27 条消息、17 次工具调用。`chat.history` 里逐条消息的 `usage` 也全是零。

所以不是缓存问题：这个接口是把会话自己的记账文件求和，而 codex harness 根本没往里写 token 数。**这台机器上没有任何一处有会话累计用量。**

危险的地方在于零是"合法数值"：`missingCostEntries` 是 0、`totalCost` 是 0，于是 `hasCost` 会算成 `true`——等于对着一个真花了钱的会话断言「$0.00，数据完整」。契约里那句「usage unavailable 和 usage is zero 在成本视图上意思相反」正是这一条。

现在的处理：

1. `projectUsageRow` **丢掉全零读数**（除非成本为正），不存编造的零；
2. `UsageStore.record` 有高水位闸门，累计读数不得被更低的读数覆盖，所以一次全零回复也无法擦掉已经量到的总量；
3. 新增 coverage 状态 **`unreported`**：接口答了、并且没有用量可报。它和 `error`（什么都没回来）、`not_observed`（还没读）都分开，UI 上写成「Gateway reports no usage for these sessions」而不是 `$0.00`；
4. `cacheStatus` 会读，但只用来判断「稍后再来」：`status !== "fresh"` 或 `staleFiles`/`pendingFiles` 非零时，空读数不算 `unreported`，因为数可能还在路上。

### 2.7 `sessions.list` 的 token 与成本是"最后一次运行"，不是会话累计

`inputTokens`、`outputTokens`、`totalTokens`、`estimatedCostUsd` 名字都像会话总量，四个都不是。真机上第一个会话是 `inputTokens: 1036, outputTokens: 4, totalTokens: 59148, estimatedCostUsd: 0.034356`——1036 + 4 加不出 59148，也换不出 $0.034。

包里 `agent-runner.runtime` 写这些字段的地方全是**赋值，不是累加**：

```js
patch.inputTokens = params.usage?.input ?? 0;          // 本次运行
patch.estimatedCostUsd = runEstimatedCostUsd;          // estimateSessionRunCostUsd(...)
patch.totalTokens = deriveSessionTotalTokens({ usage: lastCallUsage, contextTokens, promptTokens });
```

`estimatedCostUsd` 的来源函数名就叫 `estimateSessionRunCostUsd`；`totalTokens` 是拿最后一次调用的用量对着上下文窗口推出来的，所以它是**上下文占用量**。Gateway 自己的 `/usage` 命令印证了这一点：它把 `totalTokens / contextTokens` 显示成"Context: N%"，而把 "Total" 显示为 `input + output`。

后果：把它当会话用量，在 agent 卡片上按会话求和之后，屏幕上会出现一个「看着像花费、实际是某一轮上下文大小」的数字。**成本视图上宁可空着也不能这样填。** 这就是 §1 里那条建议被推翻的原因，也是 codex 会话现在报 `unreported` 而不是补数的原因。

（`totalTokens` 作为"上下文占用"倒是真实的，`SessionUsage.peakContextTokens` 至今没有数据源——这是一条还没做的事，见 §4。）

### 2.4 `usage.cost` 没有 per-agent 分解

响应是 `{ updatedAt, days, daily[], totals }`。`agentScope: "all"` 只是把所有 agent 合并进 `totals`，不会分开。**按 agent 分解只有 `sessions.usage` 的 `aggregates.byAgent` 有。**

原来发的 `{ from, to, groupBy: "agent" }` 三个参数在真机上都不存在，调用直接失败。成本覆盖层现在改走 `sessions.usage`，`usage.cost` 不再被调用（也从能力探测清单移除）。

### 按 agent 的成本：形状与参数（从包里读出来的）

```
sessions.usage 参数（additionalProperties: false）
  key? agentId? agentScope?:"all"
  startDate? endDate?   YYYY-MM-DD
  mode?:"utc"|"gateway"|"specific"   省略即 UTC
  utcOffset?            mode="specific" 时用，形如 UTC+8 / UTC+5:30
  range?:"7d"|"30d"|"90d"|"1y"|"all"   注意最小是 7d
  groupBy?:"instance"|"family"  includeHistorical?  limit?(≥1)  includeContextWeight?

回包
  { updatedAt, startDate, endDate, sessions[], totals, aggregates, cacheStatus }
  aggregates.byAgent = [{ agentId, totals: CostUsageTotals }]   按成本降序
  CostUsageTotals = { input, output, cacheRead, cacheWrite, totalTokens,
                      totalCost（美元）, inputCost, outputCost,
                      cacheReadCost, cacheWriteCost, missingCostEntries }
```

四条容易踩的：

1. **不发 `agentScope: "all"` 就只统计默认 agent**。handler 里是 `requestedAgentId ?? specificKeyAgentId ?? resolveDefaultAgentId(config)`，一个跨 agent 的总览必须显式声明作用域，而它又不能与 `key`/`agentId` 同时出现。
2. **`limit` 只截断 `sessions` 数组，不影响聚合**（`if (entryIndex < limit) sessions.push(...)`，聚合循环跑遍范围内全部条目）。所以成本这次调用发 `limit: 1`：分解照样完整，回包却小。
3. **`utcOffset` 写错不会报错**。schema 的 pattern 是 `^UTC[+-]\d{1,2}(?::[0-5]\d)?$`（`schema-BuOFpc7K.js`），而 handler 侧的 `parseUtcOffsetToMinutes` 一旦解析失败就**静默退回 `mode: "utc"`**（`usage-Suf4MGML.js`），不抛错。也就是说格式错了的后果不是调用失败，是被按 UTC 日定价、界面照样显示。`UTC+0`（宿主机在 UTC 时的输出）和 `UTC+5:30` 都在 pattern 内，已按几个时区断言过格式。
4. **只有日历天，没有滚动窗口**。`range` 最小 `7d`，单日只能 `startDate === endDate`；`mode` 默认 UTC，`gateway` 用宿主机本地日，`specific` 用你给的偏移。我们发 `mode: "specific"` + 本机偏移，把「哪一天」钉死在采集端；回包会把 `startDate`/`endDate` 回显，界面就按这个跨度标签，不把一天的花费挂在写着 24h 的标签下。

顺带：`aggregates.messages` 有 `{ total, user, assistant, toolCalls, toolResults, errors }`——这是除 `chat.history` 的 `isError` 之外，另一处 Gateway 直接给出的错误计数。

### 真机复核（2026-08-18，改完之后）

三次调用，全在真机上：

| 调用 | 结果 |
|---|---|
| `{agentScope:"all", range:"7d", groupBy:"family", limit:1, mode:"specific", utcOffset:"UTC+8"}` | 接受；回显 `2026-08-12` → `2026-08-18`（7 个日历天）；`aggregates.byAgent = [{agentId:"main", totals:{...}}]` |
| 同上但 `startDate = endDate = "2026-08-18"` | 接受；回显同一天；`byAgent` 里当天 0 token、0 成本、0 未定价 |
| 旧参数 `{from, to, groupBy:"agent"}` | `INVALID_REQUEST: unexpected property 'from'` —— 旧的成本覆盖层从来就不可能成功 |

**推翻 §2.6 的一半**：区间聚合**有** token 数。7 天窗口报 `input: 27762, output: 82, totalTokens: 27844`，而同一批会话在 `sessions` 数组里 `usage` 是 `null`、按会话读也是零。也就是说这台机器上「没有任何一处有会话累计用量」只对**按会话**那条路成立；范围聚合能给出总量。

**但成本仍然没有**：`totalCost: 0` 配 `missingCostEntries: 1`（provider 是 `codex`，没有价目表）。这个组合很危险——它不是「几乎免费」，而是「一分钱都没定出价」。投影器因此多一条规则：**成本为 0 且有未定价条目时不算金额**，该窗口宁可报没有价格，也不显示 `$0.00+`——把下界标记挂在一个什么都没量到的数字上，比空着更糟。零成本只在没有任何未定价条目时才当作事实保留（例如今天确实还没干活）。

### `isError` 的真机投影复核（同日）

把真机一页历史喂给投影器（`openclaw gateway call chat.history --params '{"sessionKey":"…","limit":30}' | awk 'NR>1' | npx tsx scripts/inspect-gateway-payload.ts history 30`）：6 条消息全部投影、无丢弃，工具结论 `failed=1 ok=1 absent=4`，`isError` 从 `unknown` 键列表里消失。

顺手修了这个脚本：`projectHistoryPage` 早先加了必填的 `request`（分页要靠它反推），脚本没跟上，任何 `history` 模式的调用都会先崩在 `request.limit` 上。现在把调用时用的 `limit` 作为第二个参数传进去——传错的话打印出来的分页结论说的是另一次请求。

---

## 3. 版本差异：audit

蓝图里写的 `audit.activity.list`（配 `kind: "message"`）和 `audit.run.inspect` 在 2026.7.1-2 上**都不存在**，只有 `audit.list`，`kind` 只接受 `agent_run` 和 `tool_action`。

它的状态词表是 `started`/`succeeded`/`failed`/`cancelled`/`timed_out`/`blocked`/`unknown`，和我们派生信号的结论对得上。

### 真机形状与参数（2026-08-19，已接入）

契约来自装好的那份构建自己的文档与 handler（`docs/gateway/protocol.md` 第 533 节起、`dist/audit-*.js`），不是从回包猜的：

```text
audit.list({ limit?: 1..500 (默认 100), cursor?, agentId?, sessionKey?, runId?, kind?, status?, after?, before? })
→ { events: [...] }                             最新在前
→ { events: [...], nextCursor: "<sequence>" }   仅当还有更旧的记录
```

- `limit` 超界是**截断而不是报错**（handler 写的是 `Math.min(params.limit ?? 100, 500)`），所以分页上限不是一条能把采集打断的路——这与 `sessions.usage` 的 `additionalProperties: false` 正相反，那边多一个参数就整轮失败。我们发 500。
- 权限是 `operator.read`，与现有 token 一致，不需要新 scope。
- **Gateway 自己会裁剪这份轨**：超过 30 天的记录查不到，共享 SQLite ledger 上限 10 万行，启动时 / 每小时 / 后续写入时都会删。所以本机保留期不能比它短（删掉的结论取不回来），倒序水位线也必须能识别序号回退。
- `audit.enabled` 关掉之后，方法仍然存在、仍然返回此前写下的记录。**空轨不是错误**：能力探测会判 `live`，而回包里一条都没有。

实机复核（`openclaw gateway call audit.list --params '{"limit":100}' | awk 'NR>1' | npx tsx scripts/inspect-gateway-payload.ts audit`，脚本新增 `audit` 模式）：

```text
events in payload: 54      projected: 54      dropped: 0
kinds:             agent_run=14 tool_action=40
statuses:          succeeded=22 started=27 failed=5
tool verdicts:     failed=5 ok=15 unsettled=20
run outcomes:      classified=7/14
sessions attached: 54/54    tool call ids: 40/40
sequence range:    1..54     nextCursor: none
unknown keys:      none
```

读法：`unsettled=20` 与 `classified=7/14` 都是 `started`——一条只有开始的记录什么都没结算，把它算成任何一种结论都是编的。54 条全部带 `sessionKey`、40 条工具记录全部带 `toolCallId`，这两项是它比 observation 更可信的原因：配对是它自己做的，不是我们按时间猜的。`redaction` 全为 `metadata_only`，文档也写了「always」——投影器仍然检查并整条丢掉别的值，因为那种构建等于绕过归档的全部开关递出内容。

一处名字上的坑：`sequence` 是 ledger 的行号，`sourceSequence` 是来源事件的序号，真机两者都发。分页、水位线与排序全用前者；后者只存下来备查。上面那一页的 `missing` 只有 `nextCursor`，因为整条轨（54 条）一页就装完了——最后一页没有游标是正常的，回填正是靠它判「走到底了」。

---

## 4. 还没做的事

1. ~~**`usage.cost` 的成本覆盖层**要改成读 `sessions.usage` 的 `aggregates.byAgent`~~ 已改，见 §2.4 末尾的形状与参数。真机复核（同节）修正了 §2.6 的适用范围：**范围聚合有 token**（7 天窗口 27,844），零 token 只对按会话读那条路成立；**但成本仍然没有**——`totalCost: 0` 配 `missingCostEntries: 1`，即一条都没定出价，按上面那条规则不报金额。所以这条修完在这台机器上看到的是 token 而不是钱：它修掉的是「每轮调用直接失败」，金额要等一个有价目表的 provider。
2. ~~**消息级 `isError` 没被读**~~ 已接：`session_messages` 加了 `is_error`（schema v5），投影器只认布尔值——`NULL` 表示「这条不是工具结果」，和「调用成功」是两件事，混同会把每条普通消息都算成一次成功的工具调用。派生信号在审计轨、归档与 observations 之间取已结算调用更多的那一份（打平按「审计 > 归档 > 观测」，见下面第 4 条）：两边描述的是同一批调用，相加等于同一次失败罚两次分；而回填到一半的归档只有最新一页，无条件优先它会把更早的失败丢掉。已换代（`superseded_by_session_id`）的那一代不计，否则跨过一次压缩的会话每条失败都会翻倍。算法版本 2 → 3，存量行自动重算。（同一批消息的 `usage` 全是零，见 §2.6，别指望它。）
3. **`peakContextTokens` 没有数据源**，而 `sessions.list` 的 `totalTokens` 就是上下文占用量（§2.7）。要接的话得单独走一条不进成本聚合的写入路径——直接写进用量快照会让零 token 的会话进入成本视图。
4. ~~**audit 采集**完全没实现~~ 已接（§3 有真机形状与复核）：`audit_events` 表（schema v6）按 `eventId` 幂等，同步是「尾读到已知水位线 + 往下回填」，水位线只在读到已知记录后前移，并识别 Gateway 侧裁剪导致的序号回退。审计结论成为派生信号的**首选**工具证据（算法版本 3 → 4），`agent_run` 的结论只在「本机 Activity 行一条都没分类出结论」**且**「会话当前没有在跑的 run」时补位——在跑的 run 没有结束可言，轨上那条结论属于已经结束的某次运行。诊断端点新增 `audit`（同步结果 + 行数 + 序号区间）。
5. ~~**Agents 页的「系统 agent 折叠」没有数据来源**~~ 已按后者处理：分组与 SYSTEM 徽号都已删除，规格第 7 节与 §9.6 同步修订。换别的信号（例如只由 cron 触发的 agent）是采集器自己编的区分，不做。`kind` 仍留在契约里，别的 Gateway 版本发这个字段时它就是诚实数据。

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

改 `src/activity/session-projector.ts`、`message-projector.ts`、`usage-projector.ts`、`audit-projector.ts` 顶部的别名表，**把真名加到列表最前面，不要删旧别名**（别的 Gateway 版本可能还在用）。匹配按顺序取第一个非 null 值。

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
SELECT kind, COUNT(*) FROM audit_events GROUP BY kind;
SELECT COUNT(*) AS scored_v4 FROM session_signals
  WHERE algorithm_version >= 4 AND grade <> 'unscored';
SQL
```

判断标准：

1. `sessions_total` 应明显大于 Live Flow 里的活跃会话数——归档发生在过滤之前，两个数字相等说明接错线了。
2. `agents` 的 `origin` 应以 `roster` 为主。全是 `observed` 说明 `agents.list` 没成功，而它的失败是静默的。
3. **`with_runtime` 应该非零**。这一项专门盯 §1 里那个「对象当字符串读」的错误——它修好之前这里恒为 0。
4. **`with_usage` 应该非零**。修好之前 `sessions.usage` 每次调用都报错，这张表永远是空的。
5. `kind_hint` 的 `unknown` 占比高**不一定**是问题，见 §2.1。
6. `audit_events` 两个 `kind` 都该有行；全空要先分诊断端点的 `audit.sync`——`errorCode` 有值是调用失败，能力判 `unavailable` 是这个构建没这个方法，两者都不是「没有数据」。轨本身空掉也可能是 `audit.enabled` 被关了（§3）。
7. `scored_v4` 非零说明审计结论真的进了评分：这一项与 `audit_events` 同时非零、而 `scored_v4` 为零，意味着重算没跑或证据没接上。

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
