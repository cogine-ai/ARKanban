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
});
