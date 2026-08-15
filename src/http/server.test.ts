import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRuntime } from "../collector/runtime.js";
import type { ResolvedCollectorConfig } from "../config.js";
import type { AgentWrite, SessionWrite } from "../storage/repository.js";
import { createHttpServer } from "./server.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function runtimeFixture(retentionDays = 30): { runtime: CollectorRuntime; config: ResolvedCollectorConfig } {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-http-"));
  const config: ResolvedCollectorConfig = {
    gateway: { name: "test", url: "ws://127.0.0.1:18789", tokenEnv: "TEST_TOKEN", token: "secret" },
    server: { host: "127.0.0.1", port: 47_123 },
    storage: {
      path: path.join(directory, "collector.sqlite"),
      terminalRetentionDays: retentionDays,
      usageRetentionDays: 14,
      sessionRetentionDays: 90,
      transcriptRetentionDays: 180,
      transcriptMaxBytes: 64 * 1024 * 1024,
      transcriptSync: "enabled",
    },
    reconcile: { tasksMs: 15_000, sessionsMs: 8_000 },
    ui: { recentLimit: 200 },
    configPath: path.join(directory, "collector.config.json"),
  };
  const runtime = new CollectorRuntime(config);
  cleanups.push(async () => {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, config };
}

describe("settled group HTTP API", () => {
  it("defaults to seven days and exposes retention completeness", async () => {
    const { runtime, config } = runtimeFixture(1);
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());

    const response = await app.inject({ method: "GET", url: "/api/v1/settled-groups" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ range: "7d", complete: false, totalRuns: 0, totalSeries: 0 });
  });

  it("rejects invalid ranges and range endpoints", async () => {
    const { runtime, config } = runtimeFixture();
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());

    expect((await app.inject({ method: "GET", url: "/api/v1/settled-groups?range=1y" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/settled-groups?rangeEnd=not-a-time" })).statusCode).toBe(400);
  });
});

describe("sessions and agents HTTP API", () => {
  async function serverWith(sessions: SessionWrite[], agents: AgentWrite[] = []): Promise<FastifyInstance> {
    const { runtime, config } = runtimeFixture();
    if (agents.length > 0) runtime.repository.upsertAgents(agents);
    if (sessions.length > 0) runtime.repository.upsertSessions(sessions);
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());
    return app;
  }

  const session = (overrides: Partial<SessionWrite> & Pick<SessionWrite, "sessionKey">): SessionWrite => ({
    agentId: "builder",
    label: "Session",
    kindHint: "main",
    archived: false,
    hasActiveRun: false,
    lineage: {},
    lastActivityAt: 5_000,
    observedAt: 5_000,
    coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "not_observed" },
    ...overrides,
  });

  it("returns a page and a cursor that fetches the remainder", async () => {
    const app = await serverWith([
      session({ sessionKey: "a", lastActivityAt: 1_000 }),
      session({ sessionKey: "b", lastActivityAt: 2_000 }),
    ]);

    const first = await app.inject({ method: "GET", url: "/api/v1/sessions?limit=1" });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.items.map((row: { sessionKey: string }) => row.sessionKey)).toEqual(["b"]);

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/sessions?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(second.json().items.map((row: { sessionKey: string }) => row.sessionKey)).toEqual(["a"]);
  });

  it("rejects a cursor replayed against a different sort", async () => {
    const app = await serverWith([
      session({ sessionKey: "a", lastActivityAt: 1_000 }),
      session({ sessionKey: "b", lastActivityAt: 2_000 }),
    ]);

    const cursor = (await app.inject({ method: "GET", url: "/api/v1/sessions?limit=1" })).json().nextCursor;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/sessions?limit=1&sort=duration&cursor=${encodeURIComponent(cursor)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_cursor" });
  });

  it("names the phase that will collect a sort it cannot serve yet", async () => {
    const app = await serverWith([]);
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions?sort=cost" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "sort_not_yet_collected", sort: "cost" });
    expect(response.json().availableIn).toContain("S6");
  });

  it("rejects unknown sorts, states and out-of-range limits", async () => {
    const app = await serverWith([]);

    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?sort=nonsense" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?state=paused" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?limit=500" })).statusCode).toBe(400);
  });

  it("treats an unparseable time bound as an error rather than no filter", async () => {
    const app = await serverWith([session({ sessionKey: "a" })]);
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions?since=yesterday" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_time_range" });
  });

  it("serves a single session archive and 404s for an unknown key", async () => {
    const app = await serverWith([session({ sessionKey: "agent:builder:1", lineage: { spawnDepth: 2 } })]);

    const found = await app.inject({ method: "GET", url: "/api/v1/sessions/agent%3Abuilder%3A1" });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ sessionKey: "agent:builder:1", lineage: { spawnDepth: 2 } });

    expect((await app.inject({ method: "GET", url: "/api/v1/sessions/missing" })).statusCode).toBe(404);
  });

  it("serves a session activity timeline and 404s before the session is observed", async () => {
    const app = await serverWith([session({ sessionKey: "s-1" })]);

    const response = await app.inject({ method: "GET", url: "/api/v1/sessions/s-1/activities" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ activities: [] });

    expect((await app.inject({ method: "GET", url: "/api/v1/sessions/nope/activities" })).statusCode).toBe(404);
  });

  it("returns the roster with per-agent session counts", async () => {
    const app = await serverWith(
      [session({ sessionKey: "a", hasActiveRun: true }), session({ sessionKey: "b", archived: true })],
      [{ id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1_000 }],
    );

    const response = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(response.statusCode).toBe(200);
    expect(response.json().agents[0]).toMatchObject({
      id: "builder",
      sessionCount: 2,
      activeSessionCount: 1,
      archivedSessionCount: 1,
    });
  });

  it("serves agent detail with its sessions and 404s for an unknown agent", async () => {
    const app = await serverWith(
      [session({ sessionKey: "a" })],
      [{ id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1_000 }],
    );

    const response = await app.inject({ method: "GET", url: "/api/v1/agents/builder" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ agent: { id: "builder" } });
    expect(response.json().sessions.items).toHaveLength(1);

    expect((await app.inject({ method: "GET", url: "/api/v1/agents/ghost" })).statusCode).toBe(404);
  });
});

describe("transcript HTTP API", () => {
  async function serverWithTranscript(): Promise<FastifyInstance> {
    const { runtime, config } = runtimeFixture();
    runtime.repository.upsertSessions([
      {
        sessionKey: "agent:builder:1",
        agentId: "builder",
        label: "Login latency",
        kindHint: "main",
        archived: false,
        hasActiveRun: false,
        lineage: {},
        lastActivityAt: 5_000,
        observedAt: 5_000,
        coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "live" },
      },
    ]);
    runtime.repository.transcripts.append([
      {
        sessionKey: "agent:builder:1",
        seq: 0,
        role: "user",
        content: "登录接口最近的失败率有点高",
        createdAt: 1_000,
        observedAt: 1_000,
      },
      {
        sessionKey: "agent:builder:1",
        seq: 1,
        role: "assistant",
        content: "Checking the login endpoint timeouts now",
        createdAt: 2_000,
        observedAt: 2_000,
      },
    ]);
    runtime.repository.transcripts.recordSync({
      sessionKey: "agent:builder:1",
      complete: true,
      syncedAt: 9_000,
    });
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());
    return app;
  }

  it("serves archived messages together with the sync watermark", async () => {
    const app = await serverWithTranscript();
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions/agent%3Abuilder%3A1/messages" });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toHaveLength(2);
    // Without the watermark a stale local copy would read as live content.
    expect(response.json().sync).toMatchObject({ syncedCount: 2, complete: true, syncedAt: 9_000 });
  });

  it("still reports the watermark when a sequence bound excludes every message", async () => {
    const app = await serverWithTranscript();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/agent%3Abuilder%3A1/messages?afterSeq=1",
    });

    expect(response.json().messages).toHaveLength(0);
    expect(response.json().sync).toMatchObject({ sessionKey: "agent:builder:1" });
  });

  it("404s for a session the archive has never seen", async () => {
    const app = await serverWithTranscript();
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions/ghost/messages" })).statusCode).toBe(404);
  });

  it("rejects a malformed sequence bound rather than ignoring it", async () => {
    const app = await serverWithTranscript();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/agent%3Abuilder%3A1/messages?afterSeq=start",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_after_seq" });
  });

  it("matches a Chinese phrase through the trigram index", async () => {
    const app = await serverWithTranscript();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/search/messages?q=${encodeURIComponent("登录接口")}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe("fts");
    expect(response.json().hits).toHaveLength(1);
    expect(response.json().hits[0]).toMatchObject({ agentId: "builder", sessionLabel: "Login latency" });
  });

  it("falls back to a scan for a short query once a filter has narrowed it", async () => {
    const app = await serverWithTranscript();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/search/messages?q=${encodeURIComponent("登录")}&agentId=builder`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe("fallback");
    expect(response.json().hits).toHaveLength(1);
  });

  it("refuses a short query with nothing to narrow it instead of scanning everything", async () => {
    const app = await serverWithTranscript();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/search/messages?q=${encodeURIComponent("登录")}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "query_too_short", minLength: 3 });
  });

  it("rejects an empty query and an unparseable time bound", async () => {
    const app = await serverWithTranscript();

    expect((await app.inject({ method: "GET", url: "/api/v1/search/messages?q=%20" })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/search/messages?q=login&from=yesterday" })).statusCode,
    ).toBe(400);
  });

  it("reports archive settings without exposing any message text", async () => {
    const app = await serverWithTranscript();
    const response = await app.inject({ method: "GET", url: "/api/v1/transcripts/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, retentionDays: 180 });
    expect(response.body).not.toContain("登录接口");
  });
});
