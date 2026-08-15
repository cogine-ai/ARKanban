# S2 真机校准交接说明

## 这份文档是给谁的

给**运行在真实 OpenClaw Gateway 那台环境里的 agent**。

S2 的字段映射是照着协议文档写的，没有对着真实 Gateway 响应验证过。本文档告诉你怎么在 5 分钟内查出映射错在哪、改哪一行。

---

## 1. 背景：为什么需要校准

`sessions.list` 和 `agents.list` 的返回字段名是从协议文档推断的。推错了**不会报错**——比如真机返回 `archivedAt` 而我们读 `archived`，结果就是所有会话永远显示"未归档"，静默错误。

所以代码里内置了一个字段清单机制，把静默错误变成可见报告。

---

## 2. 第一步：跑起来，看诊断端点

```bash
# 连上真机 Gateway 后
curl -s http://127.0.0.1:47123/api/v1/diagnostics/field-coverage | jq
```

输出长这样：

```json
{
  "capabilities": {
    "sessions.usage": "unavailable",
    "sessions.usage.timeseries": "unavailable",
    "usage.cost": "unavailable"
  },
  "fields": [
    {
      "source": "sessions.list",
      "rowsObserved": 192,
      "consumed": ["agentId", "archived", "key", "..."],
      "unknown": ["activeRunIds", "startedAt", "status"],
      "missing": ["model: model|modelId", "previousSessionId: previousSessionId|priorSessionId"]
    }
  ]
}
```

**这个端点只输出字段名，不输出任何会话内容。**

### 怎么读这三个列表

| 字段 | 含义 | 该怎么办 |
|---|---|---|
| `consumed` | 映射成功命中的 key | 不用管 |
| `unknown` | 真机返回了、但没有任何别名认领的 key | **重点看这里**——很可能是我们名字猜错了 |
| `missing` | 某个逻辑字段的**整个别名列表**都没命中 | 和 `unknown` 对照，配对起来 |

`missing` 的格式是 `逻辑字段名: 别名1|别名2`，只有当所有别名都没命中才会列出。所以 `key` 命中了就不会把 `sessionKey` 报成缺失。

### 典型的配对推理

假设看到：

```
"unknown": ["archivedAt", "lastMessageTs"]
"missing": ["archived: archived|isArchived|archivedAt", "lastActivityAt: lastActivityAt|updatedAt|lastMessageAt"]
```

等一下——`archivedAt` 同时出现在 `unknown` 和 `archived` 的别名里？那说明真机返回的 `archivedAt` 是 `null`（`pick` 跳过 null/undefined），不是名字问题。

而 `lastMessageTs` 在 `unknown` 里，`lastActivityAt` 整组没命中 → 真机用的是 `lastMessageTs`，需要加别名。

---

## 3. 第二步：改映射

**只需要改一个地方**：`src/activity/session-projector.ts` 顶部的别名表。

```ts
export const SESSION_FIELD_ALIASES = {
  // ...
  lastActivityAt: ["lastMessageTs", "lastActivityAt", "updatedAt", "lastMessageAt"],
  //               ^^^^^^^^^^^^^^^ 把真机的名字加到最前面
} as const satisfies Record<string, readonly string[]>;
```

规则：
- **加到列表最前面**，不要删掉原有别名（别的 Gateway 版本可能还在用）
- 别名匹配是按顺序取第一个非 null 的值
- Agent 的表在同一个文件里，叫 `AGENT_FIELD_ALIASES`

改完重启，再看一遍诊断端点，直到 `missing` 里只剩你确认真机确实不提供的字段。

---

## 4. 需要注意的语义问题（不只是改名字）

### 4.1 `archived` 可能是时间戳

`asFlag()` 已经处理了：布尔、0/1、`"true"`、以及**可解析的时间戳字符串**都算 true。如果真机返回 `archivedAt: "2026-01-01T..."`，直接能用，不用改。

但如果真机返回 `archivedAt: null` 表示未归档、有值表示已归档——也能正常工作。

### 4.2 `kind` 的取值可能不一样

`sessionKindHint()` 里有个映射表，认识 `main/direct/primary/fork/forked/subagent/sub/child/global`。真机如果返回别的词（比如 `"conversation"`），会落到 `unknown`。

查一下真机实际有哪些取值：

```bash
# 在 collector 数据库里看
sqlite3 <db路径> "SELECT kind_hint, COUNT(*) FROM sessions GROUP BY kind_hint;"
```

如果 `unknown` 占比很高，去 `KIND_HINTS` 里补映射。

### 4.3 worktree 只取 branch

这是**故意的隐私约束**，不是遗漏。`worktree.repoRoot` 之类的宿主机路径不允许落库（见 v1.1 修正案 §8.2）。如果真机的分支名在别的字段里，改 `branchOf()`，但不要顺手把路径也存进去。

### 4.4 没有 session key 的行会被丢弃

`projectSession` 对没有 key 的行返回 `undefined`。如果真机大量返回这种行，说明 key 字段名猜错了——先查 `unknown` 列表。

---

## 5. 能力探测（capabilities）

`sessions.usage` 这类方法**不会出现在 `hello-ok.features.methods` 里**，协议文档说发现列表是保守的。所以代码在连上之后主动试探一次。

三种结果：

| 状态 | 含义 | 会不会重试 |
|---|---|---|
| `live` | 可用 | 不再探测 |
| `unavailable` | 方法不存在 | 本次连接内不再重试 |
| `unauthorized` | 权限/scope 不够 | 本次连接内不再重试 |
| `error` | 网络等临时错误 | 下次 reconcile 重试 |

探测结果**绑定连接代次**——每次重连清空重来，因为重连可能落到不同的 Gateway 构建。

如果真机上 `sessions.usage` 显示 `unavailable` 但你确认它应该可用，检查 `classifyProbeFailure()` 的错误串匹配是否覆盖了真机的错误格式（现在匹配 `method_not_found` / `unknown method` / `not found`）。

探测参数在 `PROBE_PARAMS`，都是 `{ limit: 1 }` 的只读调用。**保持只读**，探测绝不能有副作用。

---

## 6. 验收：确认 S2 真的通了

```bash
sqlite3 <db路径> <<'SQL'
SELECT COUNT(*) AS sessions_total FROM sessions;
SELECT COUNT(*) AS archived FROM sessions WHERE archived = 1;
SELECT kind_hint, COUNT(*) FROM sessions GROUP BY kind_hint;
SELECT origin, COUNT(*) FROM agents GROUP BY origin;
SELECT COUNT(*) FROM activities WHERE session_ref IS NOT NULL;
SQL
```

判断标准：

1. **`sessions_total` 应该明显大于 Live Flow 里看到的活跃会话数**。S2 的核心改动就是在"过滤掉不活跃会话"之前先落表，如果两个数字相等，说明归档发生在过滤之后，接错线了。
2. **`agents` 的 `origin` 应该以 `roster` 为主**。如果全是 `observed`，说明 `agents.list` 没成功——它的失败是静默的（名册缺失只降级元数据，不影响同步状态）。
3. **`kind_hint` 的 `unknown` 占比应该很低**，否则去补 §4.2 的映射表。
4. **`session_ref` 非空的 activity 数量应该接近活跃会话数**，这是 activity 和 session 的关联。

---

## 7. 设计约束（改代码时别破坏这些）

1. **归档失败不得改变 `CollectorSyncState`**。`archiveSessions()` 用独立的 `sessionArchiveError` 诊断字段，**不要**改成 `setSource()`——那会喂给 `deriveSyncState()`，让次要功能的失败拖垮主同步状态。
2. **`agents.list` 的失败必须静默**。名册拿不到就退化成从 session 推断（`inferAgents`），`observed` 来源的条目在 upsert 时不会覆盖 `roster` 来源的。
3. **agent 名册用独立定时器**（300s），不搭 session 的 8s 车。慢的名册调用不能拖慢会话同步。
4. **探测和名册在首次快照之后才跑**，不能延迟第一次权威快照。

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `src/activity/session-projector.ts` | **改这里**——字段别名表和投影逻辑 |
| `src/collector/field-inventory.ts` | 字段清单统计 |
| `src/collector/capability-probe.ts` | 不可发现方法的探测和分类 |
| `src/collector/runtime.ts` | `archiveSessions` / `syncAgents` / `probeCapabilities` |
| `src/http/server.ts` | `/api/v1/diagnostics/field-coverage` |
| `scripts/mock-gateway.ts` | 模拟 Gateway，可以照真机形状改了做回归 |

改完记得跑 `npm run typecheck && npm test`。
