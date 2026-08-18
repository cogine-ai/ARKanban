import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCollectorConfig } from "../config.js";
import type { CollectorRepository } from "../storage/repository.js";
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
      storage: {
        path: path.join(directory, "collector.sqlite"),
        terminalRetentionDays: 1,
        usageRetentionDays: 14,
        sessionRetentionDays: 90,
      },
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
      storage: {
        path: path.join(directory, "collector.sqlite"),
        terminalRetentionDays: 1,
        usageRetentionDays: 14,
        sessionRetentionDays: 90,
      },
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
    // A status of `done` is the Gateway asserting a clean finish. Recording it as
    // `unknown` would leave every healthy session unclassified, which reads the
    // same as a session nobody could judge.
    await vi.waitFor(() => expect(runtime.getSnapshot().items[0]).toMatchObject({ state: "terminal", outcome: "succeeded" }));
    expect(runtime.getSnapshot().items).toHaveLength(1);
    expect(runtime.getSnapshot().items.some((item) => item.agentId === "Unattributed")).toBe(false);

    // A later run of the same session that fails is classified from its status,
    // and is what flags the session for attention.
    clientSocket?.send(JSON.stringify({
      type: "event",
      event: "sessions.changed",
      seq: 3,
      payload: { runId: "run-feishu-two", sessionKey, agentId: "pm-awb", phase: "error", status: "failed", lastRunError: "boom", ts: 5_000 },
    }));
    await vi.waitFor(() => {
      const failed = runtime.getSnapshot().items.find((item) => item.outcome === "failed");
      expect(failed).toMatchObject({ state: "terminal", attention: "error" });
    });
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
      storage: {
        path: path.join(directory, "collector.sqlite"),
        terminalRetentionDays: 1,
        usageRetentionDays: 14,
        sessionRetentionDays: 90,
      },
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

  /**
   * Discovery is conservative by design, and the amendment's §4.3 is explicit that
   * a method missing from `features.methods` may still answer — which is why
   * `sessions.usage` is probed rather than assumed. `chat.history` was assumed:
   * on a build that does not list it, transcript sync reported `unavailable` every
   * round and archived nothing, with no probe and no retry to get out of it.
   */
  it("probes chat.history when discovery does not mention it", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock gateway did not bind TCP");
    const historyAsked: Array<Record<string, unknown>> = [];
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "probe-test", ts: Date.now() } }));
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as { id: string; method: string; params?: Record<string, unknown> };
        const respond = (payload: unknown) => socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
        const refuse = (message: string) =>
          socket.send(JSON.stringify({ type: "res", id: request.id, ok: false, error: { code: "METHOD_NOT_FOUND", message } }));
        // Advertises only the three required methods, exactly as a build that
        // keeps its discovery list short would.
        if (request.method === "connect") respond({ type: "hello-ok", protocol: 4, server: { version: "runtime-test", connId: "probe" }, features: { methods: ["tasks.list", "sessions.list", "sessions.subscribe"], events: ["task", "agent", "sessions.changed", "session.tool"] }, snapshot: {}, auth: { role: "operator", scopes: ["operator.read"] }, policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 } });
        else if (request.method === "sessions.subscribe") respond({ subscribed: true });
        else if (request.method === "tasks.list") respond({ tasks: [] });
        else if (request.method === "sessions.list") respond({ sessions: [{ key: "agent:builder:one", agentId: "builder", label: "Session", status: "running", hasActiveRun: true, startedAt: 1_000 }], hasMore: false, nextOffset: 1 });
        else if (request.method === "chat.history") {
          historyAsked.push(request.params ?? {});
          respond({ sessionKey: request.params?.sessionKey, sessionId: "gen-one", messages: [] });
        } else refuse(`unknown method ${request.method}`);
      });
    });

    const directory = mkdtempSync(path.join(tmpdir(), "collector-runtime-probe-"));
    const config: ResolvedCollectorConfig = {
      gateway: { name: "test", url: `ws://127.0.0.1:${address.port}`, tokenEnv: "TEST_GATEWAY_TOKEN", token: "test-token" },
      server: { host: "127.0.0.1", port: 47_126 },
      storage: {
        path: path.join(directory, "collector.sqlite"),
        terminalRetentionDays: 1,
        usageRetentionDays: 14,
        sessionRetentionDays: 90,
        transcriptRetentionDays: 180,
        transcriptMaxBytes: 64 * 1024 * 1024,
        transcriptSync: "enabled",
      },
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

    await vi.waitFor(() => expect(runtime.getCapabilities()["chat.history"]).toBe("live"), { timeout: 5_000 });
    // Probed against a session the collector had actually seen: asking about an
    // invented key would report on that key, not on the method.
    expect(historyAsked[0]).toMatchObject({ sessionKey: "agent:builder:one", limit: 1 });
  });

  /**
   * A deletion is the one change a client cannot infer. Retention runs on its own
   * six-hour timer, and on an idle collector nothing else emits a frame — so rows
   * this pass removed stayed on an open page, listed and linkable and gone, until
   * someone reloaded by hand.
   */
  it("tells clients to refetch what retention deleted", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "collector-runtime-prune-"));
    const config: ResolvedCollectorConfig = {
      gateway: { name: "test", url: "ws://127.0.0.1:1", tokenEnv: "TEST_GATEWAY_TOKEN", token: "test-token" },
      server: { host: "127.0.0.1", port: 47_127 },
      storage: {
        path: path.join(directory, "collector.sqlite"),
        terminalRetentionDays: 1,
        usageRetentionDays: 14,
        sessionRetentionDays: 90,
        transcriptRetentionDays: 180,
        transcriptMaxBytes: 64 * 1024 * 1024,
        transcriptSync: "enabled",
      },
      reconcile: { tasksMs: 60_000, sessionsMs: 60_000 },
      ui: { recentLimit: 200 },
      configPath: path.join(directory, "config.json"),
    };
    // Never started: the prune pass is what is under test, and a gateway would
    // only add frames of its own.
    const runtime = new CollectorRuntime(config);
    cleanups.push(async () => {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    const day = 24 * 60 * 60 * 1_000;
    const longAgo = Date.now() - 200 * day;
    const repository = (runtime as unknown as { repository: CollectorRepository }).repository;
    repository.upsertSessions([
      {
        sessionKey: "agent:builder:ancient",
        agentId: "builder",
        label: "Ancient session",
        kindHint: "main",
        archived: true,
        hasActiveRun: false,
        lineage: {},
        lastActivityAt: longAgo,
        observedAt: longAgo,
        coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "live" },
      },
    ]);
    repository.transcripts.append([
      {
        sessionKey: "agent:builder:ancient",
        seq: 0,
        role: "user",
        content: "long forgotten",
        createdAt: longAgo,
        observedAt: longAgo,
      },
    ]);

    const frames: Array<{ topics?: string[]; reasons: string[] }> = [];
    const unsubscribe = runtime.subscribeChanges((change) => frames.push(change));
    (runtime as unknown as { prune: () => void }).prune();
    unsubscribe();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.reasons).toEqual(["retention_prune"]);
    expect([...(frames[0]?.topics ?? [])].sort()).toEqual(["messages", "sessions"]);
    expect(repository.transcripts.listMessages("agent:builder:ancient")).toEqual([]);
  });

  it("stays quiet when a prune pass deleted nothing", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "collector-runtime-prune-quiet-"));
    const config: ResolvedCollectorConfig = {
      gateway: { name: "test", url: "ws://127.0.0.1:1", tokenEnv: "TEST_GATEWAY_TOKEN", token: "test-token" },
      server: { host: "127.0.0.1", port: 47_128 },
      storage: {
        path: path.join(directory, "collector.sqlite"),
        terminalRetentionDays: 1,
        usageRetentionDays: 14,
        sessionRetentionDays: 90,
        transcriptRetentionDays: 180,
        transcriptMaxBytes: 64 * 1024 * 1024,
        transcriptSync: "enabled",
      },
      reconcile: { tasksMs: 60_000, sessionsMs: 60_000 },
      ui: { recentLimit: 200 },
      configPath: path.join(directory, "config.json"),
    };
    const runtime = new CollectorRuntime(config);
    cleanups.push(async () => {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    const frames: unknown[] = [];
    const unsubscribe = runtime.subscribeChanges((change) => frames.push(change));
    (runtime as unknown as { prune: () => void }).prune();
    unsubscribe();

    expect(frames).toEqual([]);
  });
});
