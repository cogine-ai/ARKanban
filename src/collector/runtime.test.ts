import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCollectorConfig } from "../config.js";
import { CollectorRuntime } from "./runtime.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("CollectorRuntime", () => {
  it("reconciles task and session snapshots, then applies a low-latency lifecycle event", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock gateway did not bind TCP");
    let clientSocket: WebSocket | undefined;
    server.on("connection", (socket) => {
      clientSocket = socket;
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "runtime-test", ts: Date.now() } }));
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as { id: string; method: string };
        const respond = (payload: unknown) => socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
        if (request.method === "connect") respond({ type: "hello-ok", protocol: 4, server: { version: "runtime-test", connId: "one" }, features: { methods: ["tasks.list", "sessions.list", "sessions.subscribe"], events: ["task", "agent", "sessions.changed", "session.tool"] }, snapshot: {}, auth: { role: "operator", scopes: ["operator.read"] }, policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 } });
        else if (request.method === "sessions.subscribe") respond({ subscribed: true });
        else if (request.method === "tasks.list") respond({ tasks: [{ id: "task-one", taskId: "task-one", status: "running", title: "Build collector", agentId: "builder", runId: "run-one", sessionKey: "agent:builder:one", createdAt: 1_000, updatedAt: 2_000 }] });
        else if (request.method === "sessions.list") respond({ sessions: [{ key: "agent:builder:one", agentId: "builder", label: "Build collector run", status: "running", hasActiveRun: true, activeRunIds: ["run-one"], startedAt: 1_100 }], hasMore: false, nextOffset: 1 });
      });
    });

    const directory = mkdtempSync(path.join(tmpdir(), "collector-runtime-"));
    const config: ResolvedCollectorConfig = {
      gateway: { name: "test", url: `ws://127.0.0.1:${address.port}`, tokenEnv: "TEST_GATEWAY_TOKEN", token: "test-token" },
      server: { host: "127.0.0.1", port: 47_123 },
      storage: { path: path.join(directory, "collector.sqlite"), terminalRetentionDays: 1 },
      reconcile: { tasksMs: 60_000, sessionsMs: 60_000 },
      ui: { recentLimit: 200 },
      configPath: path.join(directory, "config.json"),
    };
    const runtime = new CollectorRuntime(config);
    cleanups.push(async () => {
      await runtime.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    });
    runtime.start();

    await vi.waitFor(() => expect(runtime.getStatus().syncState).toBe("live"), { timeout: 5_000 });
    const initial = runtime.getSnapshot();
    expect(initial.items.map((item) => item.kind).sort()).toEqual(["attempt", "task"]);
    expect(initial.relations).toContainEqual(expect.objectContaining({ type: "run_correlation" }));

    clientSocket?.send(JSON.stringify({ type: "event", event: "agent", seq: 1, payload: { runId: "run-one", sessionKey: "agent:builder:one", agentId: "builder", seq: 1, stream: "lifecycle", ts: 3_000, data: { phase: "end", endedAt: 3_000 } } }));
    await vi.waitFor(() => expect(runtime.getSnapshot().items.find((item) => item.kind === "attempt")).toMatchObject({ state: "terminal", outcome: "unknown" }));
  });

  it("upgrades a snapshot placeholder when the run event arrives without creating an Unattributed duplicate", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock gateway did not bind TCP");
    let clientSocket: WebSocket | undefined;
    const sessionKey = "agent:pm-awb:feishu:group:group-one";
    const runRef = "run-feishu-one";
    server.on("connection", (socket) => {
      clientSocket = socket;
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "placeholder-test", ts: Date.now() } }));
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as { id: string; method: string };
        const respond = (payload: unknown) => socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
        if (request.method === "connect") respond({ type: "hello-ok", protocol: 4, server: { version: "runtime-test", connId: "placeholder" }, features: { methods: ["tasks.list", "sessions.list", "sessions.subscribe"], events: ["task", "agent", "sessions.changed", "session.tool"] }, snapshot: {}, auth: { role: "operator", scopes: ["operator.read"] }, policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 } });
        else if (request.method === "sessions.subscribe") respond({ subscribed: true });
        else if (request.method === "tasks.list") respond({ tasks: [] });
        else if (request.method === "sessions.list") respond({ sessions: [{ key: sessionKey, label: "Feishu session", status: "running", hasActiveRun: true }], hasMore: false, nextOffset: 1 });
      });
    });

    const directory = mkdtempSync(path.join(tmpdir(), "collector-runtime-placeholder-"));
    const config: ResolvedCollectorConfig = {
      gateway: { name: "test", url: `ws://127.0.0.1:${address.port}`, tokenEnv: "TEST_GATEWAY_TOKEN", token: "test-token" },
      server: { host: "127.0.0.1", port: 47_124 },
      storage: { path: path.join(directory, "collector.sqlite"), terminalRetentionDays: 1 },
      reconcile: { tasksMs: 60_000, sessionsMs: 60_000 },
      ui: { recentLimit: 200 },
      configPath: path.join(directory, "config.json"),
    };
    const runtime = new CollectorRuntime(config);
    cleanups.push(async () => {
      await runtime.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    });
    runtime.start();

    await vi.waitFor(() => expect(runtime.getStatus().syncState).toBe("live"), { timeout: 5_000 });
    expect(runtime.getSnapshot().items).toEqual([
      expect.objectContaining({ kind: "attempt", agentId: "pm-awb", state: "active" }),
    ]);
    expect(runtime.repository.findOpenAttemptsBySessionKey(sessionKey)).toHaveLength(1);

    clientSocket?.send(JSON.stringify({
      type: "event",
      event: "sessions.changed",
      seq: 1,
      payload: { runId: runRef, sessionKey, agentId: "pm-awb", phase: "start", status: "running", ts: 3_000 },
    }));
    await vi.waitFor(() => expect(runtime.repository.findOpenAttempt({ runRef })?.runRef).toBe(runRef));
    expect(runtime.getSnapshot().items).toHaveLength(1);
    expect(runtime.getSnapshot().items[0]).toMatchObject({ agentId: "pm-awb", state: "active", phase: "starting" });

    clientSocket?.send(JSON.stringify({
      type: "event",
      event: "sessions.changed",
      seq: 2,
      payload: { runId: runRef, sessionKey, agentId: "pm-awb", phase: "end", status: "done", ts: 4_000 },
    }));
    await vi.waitFor(() => expect(runtime.getSnapshot().items[0]).toMatchObject({ state: "terminal" }));
    expect(runtime.getSnapshot().items).toHaveLength(1);
    expect(runtime.getSnapshot().items.some((item) => item.agentId === "Unattributed")).toBe(false);
  });

  it("publishes the next-hour cron forecast separately from operational activity", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock gateway did not bind TCP");
    const nextRunAt = Date.now() + 30 * 60_000;
    let cronListLimit: number | undefined;
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "schedule-test", ts: Date.now() } }));
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as { id: string; method: string; params?: Record<string, unknown> };
        const respond = (payload: unknown) => socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
        if (request.method === "connect") respond({ type: "hello-ok", protocol: 4, server: { version: "runtime-test", connId: "schedule" }, features: { methods: ["tasks.list", "sessions.list", "sessions.subscribe", "cron.status", "cron.list", "agents.list"], events: ["task", "agent", "sessions.changed", "session.tool"] }, snapshot: {}, auth: { role: "operator", scopes: ["operator.read"] }, policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 } });
        else if (request.method === "sessions.subscribe") respond({ subscribed: true });
        else if (request.method === "tasks.list") respond({ tasks: [] });
        else if (request.method === "sessions.list") respond({ sessions: [], hasMore: false, nextOffset: 0 });
        else if (request.method === "agents.list") respond({ defaultId: "main", agents: [{ id: "main" }] });
        else if (request.method === "cron.status") respond({ enabled: true, jobs: 1, nextWakeAtMs: nextRunAt });
        else if (request.method === "cron.list") {
          cronListLimit = typeof request.params?.limit === "number" ? request.params.limit : undefined;
          respond({ jobs: [{ id: "memory", name: "Memory Dreaming Promotion", enabled: true, schedule: { kind: "cron", tz: "Asia/Singapore" }, state: { nextRunAtMs: nextRunAt } }], total: 1, offset: 0, limit: 1, hasMore: false, nextOffset: null });
        }
      });
    });

    const directory = mkdtempSync(path.join(tmpdir(), "collector-runtime-schedule-"));
    const config: ResolvedCollectorConfig = {
      gateway: { name: "test", url: `ws://127.0.0.1:${address.port}`, tokenEnv: "TEST_GATEWAY_TOKEN", token: "test-token" },
      server: { host: "127.0.0.1", port: 47_125 },
      storage: { path: path.join(directory, "collector.sqlite"), terminalRetentionDays: 1 },
      reconcile: { tasksMs: 60_000, sessionsMs: 60_000 },
      ui: { recentLimit: 200 },
      configPath: path.join(directory, "config.json"),
    };
    const runtime = new CollectorRuntime(config);
    const changeReasons: string[] = [];
    const unsubscribeChanges = runtime.subscribeChanges((change) => changeReasons.push(...change.reasons));
    cleanups.push(async () => {
      unsubscribeChanges();
      await runtime.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    });
    runtime.start();

    await vi.waitFor(() => expect(runtime.getSnapshot().schedule.state).toBe("live"), { timeout: 5_000 });
    expect(runtime.getSnapshot()).toMatchObject({
      summary: { incoming: 0 },
      items: [],
      schedule: {
        revision: 1,
        state: "live",
        schedulerEnabled: true,
        windowMinutes: 60,
        dueGraceMinutes: 3,
        items: [{ id: "cron:memory", jobId: "memory", agentId: "main", nextRunAt }],
      },
    });
    expect(cronListLimit).toBe(200);
    expect(changeReasons).toContain("schedule_gateway_connected");
  });
});
