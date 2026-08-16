import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "../storage/repository.js";
import { COST_SYNC_MS, UsageSynchronizer, type UsageRequest } from "./usage-sync.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = 1_800_000_000_000;

function repository(): CollectorRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-usage-sync-"));
  const repo = new CollectorRepository(path.join(directory, "collector.db"));
  cleanups.push(() => {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return repo;
}

function seed(repo: CollectorRepository, count: number, options: { hasActiveRun?: boolean } = {}): void {
  repo.upsertSessions(
    Array.from({ length: count }, (_, index) => ({
      sessionKey: `agent:builder:${index}`,
      agentId: "builder",
      label: `session ${index}`,
      kindHint: "main" as const,
      archived: false,
      hasActiveRun: options.hasActiveRun ?? true,
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
}

function synchronizer(
  repo: CollectorRepository,
  request: UsageRequest,
): UsageSynchronizer {
  return new UsageSynchronizer({ store: repo.usage, request });
}

/** A Gateway that answers usage reads and records what was asked. */
function recordingGateway(overrides: { usage?: UsageRequest; cost?: UsageRequest } = {}): {
  request: UsageRequest;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request: UsageRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === "usage.cost") {
      return overrides.cost ? overrides.cost(method, params) : { agents: [{ agentId: "builder", costMicroUsd: 7_000 }] };
    }
    if (overrides.usage) return overrides.usage(method, params);
    return { inputTokens: 100, outputTokens: 20, costUsd: 0.001, models: ["sonnet"] };
  };
  return { request, calls };
}

const LIVE = { connected: true, usageState: "live" as const, costState: "live" as const };

describe("UsageSynchronizer gating", () => {
  it("does nothing while the Gateway is disconnected", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const outcome = await synchronizer(repo, gateway.request).runOnce({ ...LIVE, now: NOW, connected: false });
    expect(outcome.skipped).toBe("not_connected");
    expect(gateway.calls).toEqual([]);
  });

  it("reports unavailable without calling a method the Gateway does not have", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const outcome = await synchronizer(repo, gateway.request).runOnce({
      ...LIVE,
      now: NOW,
      usageState: "unavailable",
    });
    expect(outcome).toMatchObject({ skipped: "unavailable", coverage: "unavailable" });
    expect(gateway.calls).toEqual([]);
  });

  it("reports unauthorized separately from unavailable", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const outcome = await synchronizer(repo, gateway.request).runOnce({
      ...LIVE,
      now: NOW,
      usageState: "unauthorized",
    });
    expect(outcome.coverage).toBe("unauthorized");
  });
});

describe("UsageSynchronizer rounds", () => {
  it("stores a reading per candidate session", async () => {
    const repo = repository();
    seed(repo, 3);
    const gateway = recordingGateway();
    const outcome = await synchronizer(repo, gateway.request).runOnce({ ...LIVE, now: NOW });

    expect(outcome).toMatchObject({ requests: 3, recorded: 3, coverage: "live" });
    expect(repo.usage.latest("agent:builder:0")).toMatchObject({ inputTokens: 100, costMicroUsd: 1_000 });
  });

  it("caps the round at 100 sessions and marks the rest as a snapshot", async () => {
    const repo = repository();
    seed(repo, 140);
    const gateway = recordingGateway();
    const outcome = await synchronizer(repo, gateway.request).runOnce({ ...LIVE, now: NOW });

    expect(outcome.requests).toBe(100);
    expect(outcome.coverage).toBe("snapshot");
  });

  it("keeps the rest of the round when one session fails", async () => {
    const repo = repository();
    seed(repo, 3);
    const gateway = recordingGateway({
      usage: async (_method, params) => {
        if (params.key === "agent:builder:1") throw new Error("boom");
        return { inputTokens: 10, outputTokens: 1 };
      },
    });
    const outcome = await synchronizer(repo, gateway.request).runOnce({ ...LIVE, now: NOW });

    expect(outcome).toMatchObject({ requests: 3, recorded: 2, coverage: "live", errorCode: "error" });
  });

  /**
   * What the calibration machine returns for every session: the call succeeds and
   * every count is zero. Nothing failed, so `error` would be wrong, and a stored
   * zero would price a running session at $0.00.
   */
  it("reports a round the Gateway answered with no usage as unreported", async () => {
    const repo = repository();
    seed(repo, 2);
    const gateway = recordingGateway({
      usage: async (_method, params) => ({
        sessions: [{ key: params.key, usage: { input: 0, output: 0, totalCost: 0, missingCostEntries: 0 } }],
        cacheStatus: { status: "fresh", staleFiles: 0 },
      }),
    });
    const sync = synchronizer(repo, gateway.request);
    const outcome = await sync.runOnce({ ...LIVE, now: NOW });

    expect(outcome).toMatchObject({ requests: 2, recorded: 0, coverage: "unreported" });
    expect(outcome.errorCode).toBeUndefined();
    expect(sync.unreportedSessions().sort()).toEqual(["agent:builder:0", "agent:builder:1"]);
  });

  /** A cache that is still building has not established that usage is absent. */
  it("does not call a session unreported while the usage cache is refreshing", async () => {
    const repo = repository();
    seed(repo, 2);
    const gateway = recordingGateway({
      usage: async (_method, params) => ({
        sessions: [{ key: params.key, usage: { input: 0, output: 0, totalCost: 0 } }],
        cacheStatus: { status: "refreshing", cachedFiles: 0, pendingFiles: 1, staleFiles: 1 },
      }),
    });
    const sync = synchronizer(repo, gateway.request);
    const outcome = await sync.runOnce({ ...LIVE, now: NOW });

    expect(outcome).toMatchObject({ recorded: 0, coverage: "not_observed" });
    expect(sync.unreportedSessions()).toEqual([]);
  });

  it("stops calling a session unreported once it reports usage", async () => {
    const repo = repository();
    seed(repo, 1);
    let counts = { input: 0, output: 0, totalCost: 0 };
    const gateway = recordingGateway({
      usage: async (_method, params) => ({ sessions: [{ key: params.key, usage: { ...counts } }] }),
    });
    const sync = synchronizer(repo, gateway.request);

    await sync.runOnce({ ...LIVE, now: NOW });
    expect(sync.unreportedSessions()).toEqual(["agent:builder:0"]);

    counts = { input: 40, output: 5, totalCost: 0.5 };
    const second = await sync.runOnce({ ...LIVE, now: NOW + 60_000 });
    expect(second).toMatchObject({ recorded: 1, coverage: "live" });
    expect(sync.unreportedSessions()).toEqual([]);
  });

  it("falls back to error coverage only when the whole round failed", async () => {
    const repo = repository();
    seed(repo, 2);
    const gateway = recordingGateway({
      usage: async () => {
        throw new Error("gateway timed out");
      },
    });
    const outcome = await synchronizer(repo, gateway.request).runOnce({ ...LIVE, now: NOW });

    expect(outcome).toMatchObject({ coverage: "error", errorCode: "timeout", recorded: 0 });
  });

  it("skips the round when nothing is worth re-reading", async () => {
    const repo = repository();
    const gateway = recordingGateway();
    const outcome = await synchronizer(repo, gateway.request).runOnce({ ...LIVE, now: NOW });
    expect(outcome.skipped).toBe("no_candidates");
  });
});

describe("UsageSynchronizer cost", () => {
  it("prices each window once and holds the result", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const sync = synchronizer(repo, gateway.request);
    const outcome = await sync.runOnce({ ...LIVE, now: NOW });

    expect(outcome.costRefreshed).toBe(true);
    expect(gateway.calls.filter((call) => call.method === "usage.cost")).toHaveLength(2);
    expect(sync.costFor("24h", "builder")).toBe(7_000);
    expect(sync.getCostCoverage()).toBe("live");
  });

  it("re-prices on its own slower cadence, not every usage round", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const sync = synchronizer(repo, gateway.request);

    await sync.runOnce({ ...LIVE, now: NOW });
    await sync.runOnce({ ...LIVE, now: NOW + 60_000 });
    expect(gateway.calls.filter((call) => call.method === "usage.cost")).toHaveLength(2);

    await sync.runOnce({ ...LIVE, now: NOW + COST_SYNC_MS });
    expect(gateway.calls.filter((call) => call.method === "usage.cost")).toHaveLength(4);
  });

  it("keeps collecting tokens when pricing is unavailable", async () => {
    const repo = repository();
    seed(repo, 2);
    const gateway = recordingGateway();
    const sync = synchronizer(repo, gateway.request);
    const outcome = await sync.runOnce({ ...LIVE, now: NOW, costState: "unavailable" });

    expect(outcome).toMatchObject({ recorded: 2, coverage: "live", costRefreshed: false });
    expect(sync.getCostCoverage()).toBe("unavailable");
    expect(gateway.calls.some((call) => call.method === "usage.cost")).toBe(false);
  });

  it("keeps the previous price rather than blanking it when a refresh fails", async () => {
    const repo = repository();
    seed(repo, 1);
    let failing = false;
    const gateway = recordingGateway({
      cost: async () => {
        if (failing) throw new Error("boom");
        return { agents: [{ agentId: "builder", costMicroUsd: 7_000 }] };
      },
    });
    const sync = synchronizer(repo, gateway.request);
    await sync.runOnce({ ...LIVE, now: NOW });

    failing = true;
    await sync.runOnce({ ...LIVE, now: NOW + COST_SYNC_MS });

    expect(sync.costFor("24h", "builder")).toBe(7_000);
    expect(sync.getCostCoverage()).toBe("error");
  });

  it("forgets prices when the connection generation changes", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const sync = synchronizer(repo, gateway.request);
    await sync.runOnce({ ...LIVE, now: NOW });

    sync.resetCost();
    expect(sync.costFor("24h", "builder")).toBeUndefined();
    expect(sync.getCostCoverage()).toBe("not_observed");
  });
});
