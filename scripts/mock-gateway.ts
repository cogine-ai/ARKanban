import { WebSocketServer, type WebSocket } from "ws";

const port = Number(process.env.MOCK_GATEWAY_PORT ?? 18_790);
const expectedToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "collector-dev-token";
const agents = ["researcher", "writer", "ops", "analyst", "planner", "builder", "qa", "deployer", "reviewer", "scheduler", "publisher", "monitor", "crawler", "triage", "orchestrator"];
// The Gateway roster mixes operator-facing agents with internal ones. These
// carry no sessions, so they only ever surface through agents.list.
const systemAgents = ["memory-keeper", "gateway-supervisor"];
const titles = ["Competitive scan", "Source review", "Publish release", "Deploy monitor", "Dependency map", "Regression check", "Audit backfill", "Draft narrative", "Policy check", "Index refresh", "Summarize session", "Health probe", "Tool analysis", "Schedule report", "Approval request", "Plan rollout", "Fetch sources", "Compare builds", "Validate output", "Write brief"];
const now = Date.now();

const cronJobs = [
  { id: "demo-cron-main", name: "Memory Dreaming Promotion", enabled: true, schedule: { kind: "cron", expr: "0 * * * *", tz: "Asia/Singapore" }, state: { nextRunAtMs: now + 5 * 60_000 } },
  { id: "demo-cron-scheduler-1", name: "Morning source refresh", enabled: true, agentId: "scheduler", schedule: { kind: "cron", expr: "*/15 * * * *", tz: "Asia/Singapore" }, state: { nextRunAtMs: now + 12 * 60_000 } },
  { id: "demo-cron-scheduler-2", name: "Publish queue review", enabled: true, agentId: "scheduler", schedule: { kind: "cron", expr: "*/20 * * * *", tz: "Asia/Singapore" }, state: { nextRunAtMs: now + 20 * 60_000 } },
  { id: "demo-cron-scheduler-3", name: "Index freshness check", enabled: true, agentId: "scheduler", schedule: { kind: "cron", expr: "*/30 * * * *", tz: "Asia/Singapore" }, state: { nextRunAtMs: now + 30 * 60_000 } },
  { id: "demo-cron-scheduler-4", name: "Delivery health probe", enabled: true, agentId: "scheduler", schedule: { kind: "cron", expr: "45 * * * *", tz: "Asia/Singapore" }, state: { nextRunAtMs: now + 45 * 60_000 } },
  { id: "demo-cron-outside", name: "Later maintenance", enabled: true, agentId: "ops", schedule: { kind: "cron", expr: "0 */2 * * *", tz: "Asia/Singapore" }, state: { nextRunAtMs: now + 2 * 60 * 60_000 } },
  { id: "demo-cron-disabled", name: "Disabled schedule", enabled: false, agentId: "ops", schedule: { kind: "cron", tz: "Asia/Singapore" }, state: { nextRunAtMs: now + 10 * 60_000 } },
];

const tasks = Array.from({ length: 170 }, (_, index) => {
  const status = index < 20 ? "queued" : index < 140 ? "running" : index < 164 ? "completed" : "failed";
  const createdAt = now - (170 - index) * 37_000;
  return {
    id: `demo-task-${index + 1}`,
    taskId: `demo-task-${index + 1}`,
    kind: index % 3 === 0 ? "subagent" : "agent",
    runtime: "openclaw",
    status,
    title: `${titles[index % titles.length]} ${String(index + 1).padStart(2, "0")}`,
    agentId: agents[index % agents.length],
    sessionKey: `agent:${agents[index % agents.length]}:demo:${index % 20}`,
    ...(index >= 20 && index < 60 ? { runId: `demo-live-run-${index - 19}` } : index >= 60 && index < 140 ? { runId: `demo-task-run-${index + 1}` } : {}),
    createdAt,
    updatedAt: status === "running" ? now - (index % 20) * 1_300 : createdAt + 20_000,
    ...(status !== "queued" ? { startedAt: createdAt + 2_000 } : {}),
    ...(status === "completed" || status === "failed" ? { endedAt: createdAt + 20_000 } : {}),
    ...(status === "running" ? { lastToolName: ["read", "exec", "web_search", "edit"][index % 4], progressSummary: `Observed step ${index % 7 + 1}` } : {}),
    ...(status === "completed" ? { terminalOutcome: "succeeded" } : {}),
  };
});

const models = ["claude-opus-4", "claude-sonnet-4", "gpt-5"];
const categories = ["research", "delivery", "ops"];
const sessionKinds = ["direct", "fork", "subagent"];

// The first 40 rows stay live so Live Flow keeps its previous fixture. The tail
// is idle and archived, which only the session archive should retain — that
// asymmetry is what exercises the ordering of archive-before-filter.
const sessions = Array.from({ length: 64 }, (_, index) => {
  const agentId = agents[(index * 7) % agents.length]!;
  const live = index < 40;
  const kind = sessionKinds[index % sessionKinds.length]!;
  const archived = index >= 52;
  return {
    key: `agent:${agentId}:demo-${live ? "live" : "idle"}-${index + 1}`,
    sessionId: `demo-session-${index + 1}`,
    kind,
    label: titles[(index + 5) % titles.length]!,
    agentId,
    agentRuntime: "openclaw",
    model: models[index % models.length]!,
    category: categories[index % categories.length]!,
    placement: index % 5 === 0 ? "workspace" : "inline",
    archived,
    updatedAt: now - index * 1_200,
    status: live ? "running" : "idle",
    hasActiveRun: live,
    activeRunIds: live ? [`demo-live-run-${index + 1}`] : [],
    startedAt: now - (index + 1) * 11_000,
    createdAt: now - (index + 1) * 11_000,
    ...(kind === "fork" ? { forkSource: `agent:${agentId}:demo-live-${Math.max(1, index - 1)}` } : {}),
    ...(kind === "subagent"
      ? {
          parentSessionKey: `agent:${agentId}:demo-live-${Math.max(1, index - 2)}`,
          spawnedBy: `agent:${agentId}:demo-live-${Math.max(1, index - 2)}`,
          spawnDepth: 1,
          subagentRole: "researcher",
        }
      : {}),
    worktree: { branch: `feature/demo-${index % 7}`, repoRoot: "/home/demo/repo" },
  };
});

// Transcript bodies deliberately mix scripts, languages and an injection payload:
// the archive stores untrusted input, and the reader must render all of it as
// text. The CJK lines are what exercise the trigram index and its LIKE fallback.
const transcriptTurns = [
  { role: "user", content: "登录接口最近的失败率有点高，帮我看一下是不是超时导致的。" },
  { role: "assistant", content: "我先拉取最近 24 小时的 登录接口 调用日志，再按错误码分组。" },
  { role: "tool", toolName: "query_logs", content: '{"window":"24h","group_by":"error_code","rows":1842}' },
  { role: "assistant", content: "超时占 63%，其余是凭证错误。建议把上游超时从 2s 调到 5s。" },
  { role: "user", content: "Can you also check whether the retry budget is being exhausted?" },
  { role: "assistant", content: "Retry budget peaks at 78% during the 09:00 burst; it is not exhausted." },
  { role: "user", content: "<script>alert('xss')</script> **bold** [link](javascript:void 0)" },
  { role: "assistant", content: "Recorded verbatim. The payload above is stored as text and never executed." },
];

/**
 * Deterministic token counts per session.
 *
 * Every third session is left unpriced so the cost view is exercised on the
 * case that matters: a total that is a floor rather than a measurement.
 */
function mockUsage(sessionKey: string, model: string, observedAt: number): Record<string, unknown> {
  let hash = 0;
  for (const character of sessionKey) hash = (hash * 37 + character.charCodeAt(0)) % 9_973;
  const inputTokens = 1_200 + hash * 3;
  const outputTokens = 300 + (hash % 700);
  const unpriced = hash % 3 === 0;
  return {
    sessionKey,
    inputTokens,
    outputTokens,
    cacheReadTokens: hash % 500,
    cacheWriteTokens: hash % 90,
    peakContextTokens: 8_000 + (hash % 24_000),
    ...(unpriced ? {} : { costUsd: Number(((inputTokens * 3 + outputTokens * 15) / 1_000_000).toFixed(6)) }),
    models: [model],
    ...(unpriced ? { unpricedModels: [model] } : {}),
    observedAt,
  };
}

function transcriptLength(sessionKey: string): number {
  // Deterministic per session so repeated pulls are stable and pagination is
  // reproducible across restarts.
  let hash = 0;
  for (const character of sessionKey) hash = (hash * 31 + character.charCodeAt(0)) % 997;
  return 4 + (hash % (transcriptTurns.length * 2));
}

function mockMessage(sessionKey: string, sessionId: string | undefined, index: number): Record<string, unknown> {
  const turn = transcriptTurns[index % transcriptTurns.length]!;
  return {
    id: `${sessionKey}#${index}`,
    seq: index,
    role: turn.role,
    ...(turn.toolName ? { toolName: turn.toolName } : {}),
    ...(sessionId ? { sessionId } : {}),
    content: turn.content,
    createdAt: now - (200 - index) * 30_000,
  };
}

const server = new WebSocketServer({ host: "127.0.0.1", port });
let frameSequence = 1;

function send(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}

server.on("connection", (socket) => {
  send(socket, { type: "event", event: "connect.challenge", payload: { nonce: "collector-demo-nonce", ts: Date.now() } });
  socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string; params?: Record<string, unknown> };
    if (request.type !== "req" || !request.id || !request.method) return;
    if (request.method === "connect") {
      const auth = request.params?.auth as { token?: string } | undefined;
      if (auth?.token !== expectedToken) {
        send(socket, { type: "res", id: request.id, ok: false, error: { code: "unauthorized", message: "invalid token" } });
        return;
      }
      send(socket, {
        type: "res",
        id: request.id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "2026.8.1-demo", connId: `demo-${Date.now()}` },
          features: { methods: ["tasks.list", "sessions.list", "sessions.subscribe", "cron.status", "cron.list", "agents.list", "chat.history"], events: ["task", "agent", "sessions.changed", "session.tool"] },
          snapshot: {},
          auth: { role: "operator", scopes: ["operator.read"] },
          policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
        },
      });
    } else if (request.method === "sessions.subscribe") {
      send(socket, { type: "res", id: request.id, ok: true, payload: { subscribed: true } });
    } else if (request.method === "tasks.list") {
      const cursor = Number(request.params?.cursor ?? 0);
      const limit = Number(request.params?.limit ?? 500);
      const page = tasks.slice(cursor, cursor + limit);
      send(socket, { type: "res", id: request.id, ok: true, payload: { tasks: page, ...(cursor + page.length < tasks.length ? { nextCursor: String(cursor + page.length) } : {}) } });
    } else if (request.method === "sessions.list") {
      const offset = Number(request.params?.offset ?? 0);
      const limit = Number(request.params?.limit ?? 500);
      const page = sessions.slice(offset, offset + limit);
      send(socket, { type: "res", id: request.id, ok: true, payload: { sessions: page, count: sessions.length, offset, limit, hasMore: offset + page.length < sessions.length, nextOffset: offset + page.length } });
      setTimeout(() => {
        sessions.slice(0, 30).forEach((session) => {
          if (socket.readyState !== socket.OPEN) return;
          send(socket, {
            type: "event",
            event: "exec.approval.requested",
            seq: frameSequence,
            payload: { runId: session.activeRunIds[0], sessionKey: session.key, agentId: session.agentId, ts: Date.now() },
          });
          frameSequence += 1;
        });
      }, 120);
    } else if (request.method === "chat.history") {
      const params = request.params as { sessionKey?: string; cursor?: string; limit?: number } | undefined;
      const sessionKey = String(params?.sessionKey ?? "");
      const session = sessions.find((entry) => entry.key === sessionKey);
      const offset = Number(params?.cursor ?? 0);
      const limit = Math.min(Number(params?.limit ?? 200), 200);
      const total = session ? transcriptLength(sessionKey) : 0;
      const page = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) =>
        mockMessage(sessionKey, session?.sessionId, offset + index),
      );
      const nextOffset = offset + page.length;
      send(socket, {
        type: "res",
        id: request.id,
        ok: true,
        payload: {
          messages: page,
          hasMore: nextOffset < total,
          ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
        },
      });
    } else if (request.method === "sessions.usage") {
      const params = request.params as { sessionKey?: string; limit?: number } | undefined;
      const observedAt = Date.now();
      if (params?.sessionKey) {
        const session = sessions.find((entry) => entry.key === params.sessionKey);
        if (!session) {
          send(socket, { type: "res", id: request.id, ok: false, error: { code: "NOT_FOUND", message: "unknown session" } });
        } else {
          send(socket, { type: "res", id: request.id, ok: true, payload: mockUsage(session.key, session.model, observedAt) });
        }
      } else {
        // The capability probe calls this with only a limit, so the batch shape
        // has to answer too.
        const limit = Math.min(Number(params?.limit ?? 50), 100);
        send(socket, {
          type: "res",
          id: request.id,
          ok: true,
          payload: { sessions: sessions.slice(0, limit).map((entry) => mockUsage(entry.key, entry.model, observedAt)) },
        });
      }
    } else if (request.method === "usage.cost") {
      const params = request.params as { from?: number; to?: number } | undefined;
      const from = Number(params?.from ?? 0);
      const to = Number(params?.to ?? Date.now());
      const byAgent = new Map<string, number>();
      for (const session of sessions) {
        if (session.updatedAt < from || session.updatedAt > to) continue;
        const usage = mockUsage(session.key, session.model, to);
        const costUsd = usage.costUsd;
        if (typeof costUsd !== "number") continue;
        byAgent.set(session.agentId, (byAgent.get(session.agentId) ?? 0) + Math.round(costUsd * 1_000_000));
      }
      send(socket, {
        type: "res",
        id: request.id,
        ok: true,
        payload: {
          from,
          to,
          agents: [...byAgent].map(([agentId, costMicroUsd]) => ({ agentId, costMicroUsd })),
        },
      });
    } else if (request.method === "agents.list") {
      send(socket, {
        type: "res",
        id: request.id,
        ok: true,
        payload: {
          defaultId: "main",
          agents: [
            ...agents.map((id, index) => ({
              id,
              displayName: `${id[0]!.toUpperCase()}${id.slice(1)}`,
              kind: "agent",
              runtime: "openclaw",
              model: models[index % models.length]!,
            })),
            ...systemAgents.map((id) => ({
              id,
              displayName: id.split("-").map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" "),
              kind: "system",
              runtime: "openclaw",
            })),
          ],
        },
      });
    } else if (request.method === "cron.status") {
      send(socket, { type: "res", id: request.id, ok: true, payload: { enabled: true, jobs: cronJobs.length, nextWakeAtMs: cronJobs[0]?.state.nextRunAtMs } });
    } else if (request.method === "cron.list") {
      const offset = Number(request.params?.offset ?? 0);
      const limit = Number(request.params?.limit ?? 500);
      const page = cronJobs.slice(offset, offset + limit);
      send(socket, { type: "res", id: request.id, ok: true, payload: { jobs: page, total: cronJobs.length, offset, limit, hasMore: offset + page.length < cronJobs.length, nextOffset: offset + page.length < cronJobs.length ? offset + page.length : null } });
    } else {
      send(socket, { type: "res", id: request.id, ok: false, error: { code: "method_not_found", message: request.method } });
    }
  });
});

const liveSessions = sessions.filter((session) => session.hasActiveRun);

function broadcast(event: string, payload: unknown): void {
  for (const socket of server.clients) {
    if (socket.readyState === socket.OPEN) send(socket, { type: "event", event, payload, seq: frameSequence });
  }
  frameSequence += 1;
}

/**
 * Tool calls are opened and then settled, and some runs end.
 *
 * Emitting only `start` would leave every session unscored: derived signals need
 * a settled call or a classified ending before they will grade anything, so a
 * mock that never finishes anything cannot exercise the grades at all.
 */
let tick = 0;

const eventTimer = setInterval(() => {
  const session = liveSessions[tick % liveSessions.length]!;
  // Between an end and its restart there is no run to attribute tool calls to.
  if (!session.hasActiveRun) {
    tick += 1;
    return;
  }
  const toolName = ["read", "exec", "edit", "web_search"][tick % 4]!;
  const base = {
    runId: session.activeRunIds[0],
    sessionKey: session.key,
    agentId: session.agentId,
    stream: "tool",
    ts: Date.now(),
  };
  const toolCallId = `demo-tool-${frameSequence}`;

  broadcast("session.tool", { ...base, seq: frameSequence, data: { phase: "start", name: toolName, toolCallId } });

  // Every fifth call fails, and every fifteenth fails twice in a row, so both a
  // one-off failure and a retry loop appear in the archive.
  const fails = tick % 5 === 0;
  // The run ends every third tick, alternating between a clean stop and a
  // failure, which is what gives the archive classified terminal outcomes.
  const endsRun = tick % 3 === 2;
  const failingRun = tick % 6 === 2;

  setTimeout(() => {
    broadcast("session.tool", {
      ...base,
      ts: Date.now(),
      seq: frameSequence,
      data: fails
        ? { phase: "error", name: toolName, toolCallId, error: "mock tool failure" }
        : { phase: "end", name: toolName, toolCallId },
    });
    if (tick % 15 === 0) {
      broadcast("session.tool", {
        ...base,
        ts: Date.now(),
        seq: frameSequence,
        data: { phase: "error", name: toolName, toolCallId: `${toolCallId}-retry`, error: "mock retry failure" },
      });
    }
    // Ordered after the tool settles, the way a real run ends: its last tool
    // call resolves and then the run stops. Ending first would leave a tool
    // event arriving for a run that had already finished.
    if (endsRun) endRun(session, failingRun);
  }, 700);

  tick += 1;
}, 1_800);

/**
 * Stops a run and restarts the session under a fresh run id.
 *
 * The session must also stop advertising the run: `sessions.list` is
 * authoritative on the collector side, so a mock that kept listing an ended run
 * as active would have the next reconcile flip the activity back to running and
 * no terminal outcome would ever survive.
 */
function endRun(session: (typeof liveSessions)[number], failing: boolean): void {
  const endedRunId = session.activeRunIds[0];
  session.hasActiveRun = false;
  session.activeRunIds = [];
  session.status = "idle";
  broadcast("sessions.changed", {
    sessionKey: session.key,
    agentId: session.agentId,
    runId: endedRunId,
    phase: failing ? "error" : "end",
    status: failing ? "failed" : "done",
    hasActiveRun: false,
    ts: Date.now(),
    ...(failing ? { lastRunError: "mock run failure" } : {}),
  });

  // Restarted under a fresh run id, so the board keeps moving and the archive
  // accumulates generations instead of draining to nothing.
  setTimeout(() => {
    session.hasActiveRun = true;
    session.activeRunIds = [`demo-live-run-${session.key}-${Date.now()}`];
    session.status = "running";
    broadcast("sessions.changed", {
      sessionKey: session.key,
      agentId: session.agentId,
      runId: session.activeRunIds[0],
      phase: "start",
      status: "running",
      hasActiveRun: true,
      ts: Date.now(),
    });
  }, 9_000);
}

process.stdout.write(`Mock OpenClaw Gateway listening on ws://127.0.0.1:${port} with 170 tasks and 40 active sessions\n`);

function stop(): void {
  clearInterval(eventTimer);
  for (const socket of server.clients) socket.close(1001, "mock stopping");
  server.close(() => process.exit(0));
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
