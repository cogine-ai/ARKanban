import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { attemptPatch } from "../activity/projector.js";
import { SIGNAL_ALGORITHM_VERSION } from "../activity/session-signals.js";
import { CollectorRuntime } from "../collector/runtime.js";
import type { AgentOverview, AgentRollupWindow } from "../contracts.js";
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

  /**
   * `ws://user:pass@host` is a legal endpoint, and this response is read by a
   * browser page. The CLI has always redacted it; these routes had not.
   */
  it("does not serve the Gateway credentials to the page", async () => {
    const { runtime, config } = runtimeFixture();
    config.gateway.url = "ws://operator:hunter2@127.0.0.1:18789/rpc?token=abc";
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());

    for (const url of ["/api/v1/meta", "/api/v1/diagnostics/field-coverage"]) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body).not.toContain("hunter2");
      expect(body).not.toContain("operator:");
      expect(body).not.toContain("token=abc");
      expect(body).toContain("ws://127.0.0.1:18789/rpc");
    }
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

  it("rejects unknown sorts, states, grades and out-of-range limits", async () => {
    const app = await serverWith([]);

    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?sort=nonsense" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?state=paused" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?grade=S" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?limit=500" })).statusCode).toBe(400);
  });

  it("treats an unparseable time bound as an error rather than no filter", async () => {
    const app = await serverWith([session({ sessionKey: "a" })]);
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions?since=yesterday" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_time_range" });
  });

  /**
   * `Number("")` is zero, so an empty bound used to read as the epoch and an
   * empty limit as a limit of nothing.
   */
  it("does not read an empty numeric parameter as zero", async () => {
    const app = await serverWith([session({ sessionKey: "a" })]);

    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?since=" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions?limit=" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/settled-groups?rangeEnd=" })).statusCode).toBe(400);
  });

  /**
   * A filter cleared in the URL arrives as an empty string. Asking the database
   * for the sessions of an agent named "" answers nothing, which reads as an
   * agent that has done nothing rather than as no filter at all.
   */
  it("treats a blank agent filter as no filter", async () => {
    const app = await serverWith([session({ sessionKey: "a", agentId: "builder" })]);

    const response = await app.inject({ method: "GET", url: "/api/v1/sessions?agentId=" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
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

describe("usage HTTP API", () => {
  const NOW = 1_800_000_000_000;

  async function serverWithUsage(): Promise<{ app: FastifyInstance; runtime: CollectorRuntime }> {
    const { runtime, config } = runtimeFixture();
    runtime.repository.upsertAgents([
      { id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: NOW },
      { id: "quiet", displayName: "Quiet", kind: "agent", origin: "roster", observedAt: NOW },
    ]);
    runtime.repository.upsertSessions(
      [
        { sessionKey: "agent:builder:cheap", agentId: "builder" },
        { sessionKey: "agent:builder:pricey", agentId: "builder" },
        { sessionKey: "agent:quiet:1", agentId: "quiet" },
      ].map((entry) => ({
        ...entry,
        label: entry.sessionKey,
        kindHint: "main" as const,
        archived: false,
        hasActiveRun: false,
        lineage: {},
        lastActivityAt: NOW,
        observedAt: NOW,
        coverage: {
          index: "live" as const,
          detail: "not_observed" as const,
          usage: "not_observed" as const,
          messages: "not_observed" as const,
        },
      })),
    );
    runtime.repository.usage.record([
      {
        sessionKey: "agent:builder:cheap",
        observedAt: NOW,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 1_000,
        hasCost: true,
        models: ["sonnet"],
        unpricedModels: [],
      },
      {
        sessionKey: "agent:builder:pricey",
        observedAt: NOW,
        inputTokens: 900,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 90_000,
        hasCost: true,
        models: ["opus"],
        unpricedModels: [],
      },
    ]);
    runtime.repository.setUsageCoverage("live");
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());
    return { app, runtime };
  }

  it("sorts sessions by the most recent cost reading", async () => {
    const { app } = await serverWithUsage();
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions?sort=cost" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((row: { sessionKey: string }) => row.sessionKey)).toEqual([
      "agent:builder:pricey",
      "agent:builder:cheap",
      "agent:quiet:1",
    ]);
  });

  it("pages a cost sort without repeating the boundary row", async () => {
    const { app } = await serverWithUsage();
    const first = await app.inject({ method: "GET", url: "/api/v1/sessions?sort=cost&limit=1" });
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/sessions?sort=cost&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    });

    expect(first.json().items[0].sessionKey).toBe("agent:builder:pricey");
    expect(second.json().items[0].sessionKey).toBe("agent:builder:cheap");
  });

  it("distinguishes a measured session from one that was never priced", async () => {
    const { app } = await serverWithUsage();
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions?sort=cost" });
    const rows = response.json().items as Array<{ sessionKey: string; coverage: { usage: string } }>;

    expect(rows.find((row) => row.sessionKey === "agent:builder:cheap")?.coverage.usage).toBe("live");
    expect(rows.find((row) => row.sessionKey === "agent:quiet:1")?.coverage.usage).toBe("not_observed");
  });

  it("attaches the latest reading to the session detail", async () => {
    const { app } = await serverWithUsage();
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions/agent%3Abuilder%3Apricey" });

    expect(response.json().usage).toMatchObject({ inputTokens: 900, costMicroUsd: 90_000, hasCost: true });
  });

  it("gives each agent card its own windows and coverage", async () => {
    const { app } = await serverWithUsage();
    const response = await app.inject({ method: "GET", url: "/api/v1/agents" });
    const agents = response.json().agents as Array<{
      id: string;
      cost: { coverage: string; windows: Record<string, { costMicroUsd?: number; sessionCount: number }> };
    }>;

    expect(agents.find((agent) => agent.id === "builder")?.cost).toMatchObject({ coverage: "live" });
    expect(agents.find((agent) => agent.id === "builder")?.cost.windows["24h"]).toMatchObject({
      costMicroUsd: 91_000,
      sessionCount: 2,
    });
    // A quiet agent reports zero sessions rather than being dropped, so the card
    // can say "nothing spent" instead of going blank.
    expect(agents.find((agent) => agent.id === "quiet")?.cost.windows["24h"].sessionCount).toBe(0);
  });

  /**
   * The unpriced model names only ever come from the per-session reads, because a
   * ranged reply counts what it could not price without naming it. Keeping the
   * names while the range decides completeness is the most either source can say.
   */
  it("takes the ranged reply's own verdict on whether the amount is a floor", async () => {
    const { app, runtime } = await serverWithUsage();
    runtime.repository.usage.record([
      {
        sessionKey: "agent:builder:cheap",
        observedAt: NOW + 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        hasCost: false,
        models: ["local-llm"],
        unpricedModels: ["local-llm"],
      },
    ]);
    Object.defineProperty(runtime, "getAgentCost", { value: () => ({ costMicroUsd: 50_000, hasCost: false }) });

    const response = await app.inject({ method: "GET", url: "/api/v1/agents" });
    const builder = (response.json().agents as AgentOverview[]).find((agent) => agent.id === "builder");

    expect(builder?.cost.source).toEqual({ "24h": "gateway", "7d": "gateway" });
    expect(builder?.cost.windows["24h"]).toMatchObject({
      costMicroUsd: 50_000,
      hasCost: false,
      unpricedModels: ["local-llm"],
    });
  });

  /**
   * A stored reading being a floor says nothing about the span on screen: the two
   * cover different spans, and the amount shown is the ranged one. Carrying the
   * per-session verdict over marked a fully priced range as incomplete.
   */
  it("calls a fully priced range complete even when a stored reading was a floor", async () => {
    const { app, runtime } = await serverWithUsage();
    runtime.repository.usage.record([
      {
        sessionKey: "agent:builder:cheap",
        observedAt: NOW + 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        hasCost: false,
        models: ["local-llm"],
        unpricedModels: ["local-llm"],
      },
    ]);
    Object.defineProperty(runtime, "getAgentCost", { value: () => ({ costMicroUsd: 50_000, hasCost: true }) });

    const response = await app.inject({ method: "GET", url: "/api/v1/agents" });
    const builder = (response.json().agents as AgentOverview[]).find((agent) => agent.id === "builder");

    expect(builder?.cost.windows["24h"]).toMatchObject({ costMicroUsd: 50_000, hasCost: true });
  });

  /**
   * The two windows are separate requests. A single label for the pair put the
   * Gateway's name on a window it never answered for, whenever the other window
   * did — and the span is published per window for the same reason.
   */
  it("names the pricing source per window when only one was priced", async () => {
    const { app, runtime } = await serverWithUsage();
    Object.defineProperty(runtime, "getAgentCost", {
      value: (window: AgentRollupWindow) => (window === "7d" ? { costMicroUsd: 50_000, hasCost: true } : undefined),
    });
    Object.defineProperty(runtime, "getAgentCostSpan", {
      value: (window: AgentRollupWindow) => (window === "7d" ? { from: "2026-08-12", to: "2026-08-18" } : undefined),
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/agents" });
    const builder = (response.json().agents as AgentOverview[]).find((agent) => agent.id === "builder");

    expect(builder?.cost.source).toEqual({ "24h": "snapshots", "7d": "gateway" });
    expect(builder?.cost.windows["7d"]).toMatchObject({ costMicroUsd: 50_000 });
    // The card labels a Gateway-priced window from this, because the Gateway
    // prices calendar days and the window key does not say so.
    expect(builder?.cost.priced).toEqual({ "7d": { from: "2026-08-12", to: "2026-08-18" } });
  });

  it("summarises a range by agent and model", async () => {
    const { app } = await serverWithUsage();
    const response = await app.inject({ method: "GET", url: `/api/v1/usage/summary?from=${NOW - 1_000}&to=${NOW}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ coverage: "live", totals: { costMicroUsd: 91_000, sessionCount: 2 } });
    expect(response.json().byAgent).toEqual([{ agentId: "builder", totals: expect.objectContaining({ costMicroUsd: 91_000 }) }]);
    expect(response.json().byModel.map((entry: { model: string }) => entry.model).sort()).toEqual(["opus", "sonnet"]);
  });

  it("defaults the summary to the last day and rejects a reversed range", async () => {
    const { app } = await serverWithUsage();

    const defaulted = await app.inject({ method: "GET", url: "/api/v1/usage/summary" });
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.json().to - defaulted.json().from).toBe(24 * 60 * 60 * 1_000);

    const reversed = await app.inject({ method: "GET", url: `/api/v1/usage/summary?from=${NOW}&to=${NOW - 1}` });
    expect(reversed.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/usage/summary?from=yesterday" })).statusCode).toBe(400);
  });
});

describe("session signals HTTP API", () => {
  const NOW = 1_800_000_000_000;

  async function serverWithSignals(): Promise<{ app: FastifyInstance; runtime: CollectorRuntime }> {
    const { runtime, config } = runtimeFixture();
    runtime.repository.upsertSessions(
      ["failing", "clean", "unjudged"].map((name) => ({
        sessionKey: `agent:builder:${name}`,
        agentId: "builder",
        label: name,
        kindHint: "main" as const,
        archived: false,
        hasActiveRun: name === "unjudged",
        lineage: {},
        lastActivityAt: NOW,
        observedAt: NOW,
        coverage: {
          index: "live" as const,
          detail: "not_observed" as const,
          usage: "not_observed" as const,
          messages: "not_observed" as const,
        },
      })),
    );
    const run = (name: string, outcome: "succeeded" | "failed") =>
      attemptPatch({
        id: `attempt:${name}`,
        sourceKey: `attempt:${name}`,
        origin: "session_segment",
        agentId: "builder",
        title: name,
        now: NOW - 1_000,
        sessionKey: `agent:builder:${name}`,
        state: "terminal",
        outcome,
        endedAt: NOW - 1_000,
        source: "events",
        eventKind: "agent:lifecycle:end",
        status: "end",
      });
    runtime.repository.upsertMany([run("failing", "failed"), run("clean", "succeeded")], ["test"]);
    runtime.repository.signals.recomputeStale(NOW);
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());
    return { app, runtime };
  }

  it("sorts worst first and leaves unscored sessions at the bottom", async () => {
    const { app } = await serverWithSignals();
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions?sort=grade" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((row: { sessionKey: string }) => row.sessionKey)).toEqual([
      "agent:builder:failing",
      "agent:builder:clean",
      "agent:builder:unjudged",
    ]);
  });

  it("pages a grade sort without repeating the boundary row", async () => {
    const { app } = await serverWithSignals();
    const first = await app.inject({ method: "GET", url: "/api/v1/sessions?sort=grade&limit=1" });
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/sessions?sort=grade&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    });

    expect(first.json().items[0].sessionKey).toBe("agent:builder:failing");
    expect(second.json().items[0].sessionKey).toBe("agent:builder:clean");
  });

  it("carries a compact grade on every list row", async () => {
    const { app } = await serverWithSignals();
    const rows = (await app.inject({ method: "GET", url: "/api/v1/sessions" })).json().items as Array<{
      sessionKey: string;
      signals?: { grade: string; outcome: string; score?: number };
    }>;

    expect(rows.find((row) => row.sessionKey === "agent:builder:failing")?.signals).toMatchObject({
      grade: "D",
      outcome: "errored",
      score: 55,
    });
    expect(rows.find((row) => row.sessionKey === "agent:builder:clean")?.signals).toMatchObject({ grade: "A" });
    expect(rows.find((row) => row.sessionKey === "agent:builder:unjudged")?.signals).toMatchObject({
      grade: "unscored",
    });
  });

  it("filters by grade, counting a never-scored session as unscored", async () => {
    const { app } = await serverWithSignals();

    const errored = await app.inject({ method: "GET", url: "/api/v1/sessions?grade=D" });
    expect(errored.json().items.map((row: { sessionKey: string }) => row.sessionKey)).toEqual(["agent:builder:failing"]);

    const unscored = await app.inject({ method: "GET", url: "/api/v1/sessions?grade=unscored" });
    expect(unscored.json().items.map((row: { sessionKey: string }) => row.sessionKey)).toEqual(["agent:builder:unjudged"]);
  });

  it("attaches the full signal row, penalties included, to the detail", async () => {
    const { app } = await serverWithSignals();
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions/agent%3Abuilder%3Afailing" });

    expect(response.json().signals).toMatchObject({
      grade: "D",
      outcome: "errored",
      confidence: "medium",
      algorithmVersion: SIGNAL_ALGORITHM_VERSION,
      penalties: [{ code: "errored_outcome", points: 45 }],
    });
  });

  it("scores a session on first read rather than waiting for the background pass", async () => {
    const { app, runtime } = await serverWithSignals();
    runtime.repository.upsertSessions([
      {
        sessionKey: "agent:builder:fresh",
        agentId: "builder",
        label: "fresh",
        kindHint: "main",
        archived: false,
        hasActiveRun: false,
        lineage: {},
        lastActivityAt: NOW,
        observedAt: NOW,
        coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "not_observed" },
      },
    ]);

    const response = await app.inject({ method: "GET", url: "/api/v1/sessions/agent%3Abuilder%3Afresh" });

    expect(response.json().signals).toMatchObject({ grade: "unscored", algorithmVersion: SIGNAL_ALGORITHM_VERSION });
  });
});

/**
 * Binding to loopback only keeps other machines out. These cover the browser
 * sitting on the same machine, which is the one client that can be talked into
 * calling this API on someone else's behalf — and the API answers with full
 * conversation text.
 */
describe("browser-facing guards", () => {
  async function server(): Promise<FastifyInstance> {
    const { runtime, config } = runtimeFixture();
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());
    return app;
  }

  it("refuses a request arriving under a host that is not loopback", async () => {
    const app = await server();
    // DNS rebinding: the browser connected to 127.0.0.1 while believing it is
    // talking to the attacker's site, so it attaches that site's Host.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/snapshot",
      headers: { host: "attacker.example:47123" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "forbidden_host" });
  });

  it("accepts every loopback spelling, port included or not", async () => {
    const app = await server();
    for (const host of ["localhost", "localhost:47123", "127.0.0.1:47123", "[::1]:47123"]) {
      const response = await app.inject({ method: "GET", url: "/healthz", headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
  });

  it("refuses a foreign Origin and a cross-site fetch", async () => {
    const app = await server();
    const foreign = await app.inject({
      method: "GET",
      url: "/api/v1/snapshot",
      headers: { origin: "https://attacker.example" },
    });
    const crossSite = await app.inject({
      method: "GET",
      url: "/api/v1/snapshot",
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(foreign.json()).toMatchObject({ error: "forbidden_origin" });
    expect(crossSite.json()).toMatchObject({ error: "forbidden_cross_site" });
  });

  it("sends a policy that permits nothing off-origin, and no referrer", async () => {
    const app = await server();
    const response = await app.inject({ method: "GET", url: "/api/v1/snapshot" });

    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("answers 400 for a repeated parameter instead of failing inside SQLite", async () => {
    const app = await server();
    const response = await app.inject({ method: "GET", url: "/api/v1/sessions?agentId=a&agentId=b" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "repeated_query_parameter", parameter: "agentId" });
  });
});

describe("event stream lifecycle", () => {
  /**
   * `inject` cannot hold a hijacked stream open, so these listen for real.
   *
   * Both cases are about a socket Fastify has stopped tracking. Neither is
   * visible from a unit test that only ever asks for a response body.
   */
  async function listening(): Promise<{ app: FastifyInstance; origin: string }> {
    const { runtime, config } = runtimeFixture();
    const app = await createHttpServer(runtime, config);
    // Port 0: the suite may run in parallel with a real collector.
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    cleanups.push(() => app.close());
    return { app, origin: `http://127.0.0.1:${port}` };
  }

  it("closes while an event stream is still connected", async () => {
    const { app, origin } = await listening();
    const abort = new AbortController();
    const stream = await fetch(`${origin}/api/v1/events`, { signal: abort.signal });
    await stream.body!.getReader().read();

    // Fastify's own onClose hook awaits the HTTP server, and the server awaits
    // this socket, so ending the streams any later than preClose never happens.
    await Promise.race([
      app.close(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close deadlocked")), 5_000)),
    ]);

    abort.abort();
  }, 10_000);

  it("answers HEAD on the event stream instead of hanging", async () => {
    const { origin } = await listening();

    const response = await Promise.race([
      fetch(`${origin}/api/v1/events`, { method: "HEAD" }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("HEAD hung")), 5_000)),
    ]);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  }, 10_000);
});
