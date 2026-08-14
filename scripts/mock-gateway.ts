import { WebSocketServer, type WebSocket } from "ws";

const port = Number(process.env.MOCK_GATEWAY_PORT ?? 18_790);
const expectedToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "collector-dev-token";
const agents = ["researcher", "writer", "ops", "analyst", "planner", "builder", "qa", "deployer", "reviewer", "scheduler", "publisher", "monitor", "crawler", "triage", "orchestrator"];
const titles = ["Competitive scan", "Source review", "Publish release", "Deploy monitor", "Dependency map", "Regression check", "Audit backfill", "Draft narrative", "Policy check", "Index refresh", "Summarize session", "Health probe", "Tool analysis", "Schedule report", "Approval request", "Plan rollout", "Fetch sources", "Compare builds", "Validate output", "Write brief"];
const now = Date.now();

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

const sessions = Array.from({ length: 40 }, (_, index) => {
  const agentId = agents[(index * 7) % agents.length]!;
  return {
    key: `agent:${agentId}:demo-live-${index + 1}`,
    sessionId: `demo-session-${index + 1}`,
    kind: "direct",
    label: titles[(index + 5) % titles.length]!,
    agentId,
    updatedAt: now - index * 1_200,
    status: "running",
    hasActiveRun: true,
    activeRunIds: [`demo-live-run-${index + 1}`],
    startedAt: now - (index + 1) * 11_000,
  };
});

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
          features: { methods: ["tasks.list", "sessions.list", "sessions.subscribe"], events: ["task", "agent", "sessions.changed", "session.tool"] },
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
    } else {
      send(socket, { type: "res", id: request.id, ok: false, error: { code: "method_not_found", message: request.method } });
    }
  });
});

const eventTimer = setInterval(() => {
  const index = Math.floor(Date.now() / 1_800) % sessions.length;
  const session = sessions[index]!;
  const payload = {
    runId: session.activeRunIds[0],
    sessionKey: session.key,
    agentId: session.agentId,
    seq: frameSequence,
    stream: "tool",
    ts: Date.now(),
    data: { phase: "start", name: ["read", "exec", "edit", "web_search"][index % 4], toolCallId: `demo-tool-${frameSequence}` },
  };
  for (const socket of server.clients) {
    if (socket.readyState === socket.OPEN) send(socket, { type: "event", event: "session.tool", payload, seq: frameSequence });
  }
  frameSequence += 1;
}, 1_800);

process.stdout.write(`Mock OpenClaw Gateway listening on ws://127.0.0.1:${port} with 170 tasks and 40 active sessions\n`);

function stop(): void {
  clearInterval(eventTimer);
  for (const socket of server.clients) socket.close(1001, "mock stopping");
  server.close(() => process.exit(0));
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
