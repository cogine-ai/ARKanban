import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "../storage/repository.js";
import {
  COST_SYNC_MS,
  localDateLabel,
  localUtcOffset,
  utcOffsetLabel,
  UsageSynchronizer,
  type UsageRequest,
} from "./usage-sync.js";

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

/**
 * The reply 2026.7.1-2 gives an agent-scoped range.
 *
 * The per-agent amount lives in `aggregates.byAgent[].totals`, in dollars, next
 * to the count of entries the Gateway could not price — and the span it resolved
 * comes back with it.
 */
function rangedCostReply(params: Record<string, unknown>): Record<string, unknown> {
  const day = typeof params.startDate === "string" ? params.startDate : undefined;
  return {
    updatedAt: NOW,
    startDate: day ?? "2026-08-12",
    endDate: day ?? "2026-08-18",
    sessions: [],
    totals: { totalCost: day ? 0.007 : 0.03, missingCostEntries: 0 },
    aggregates: {
      byAgent: [{ agentId: "builder", totals: { totalCost: day ? 0.007 : 0.03, totalTokens: 400, missingCostEntries: 0 } }],
    },
    cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
  };
}

/** A Gateway that answers usage reads and records what was asked. */
function recordingGateway(overrides: { usage?: UsageRequest; cost?: UsageRequest } = {}): {
  request: UsageRequest;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  costCalls: () => Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const isCostRead = (method: string, params: Record<string, unknown>): boolean =>
    method === "sessions.usage" && params.agentScope === "all";
  const request: UsageRequest = async (method, params) => {
    calls.push({ method, params });
    // Cost and tokens are the same method asked two ways: a range across every
    // agent, or one session by key.
    if (isCostRead(method, params)) {
      return overrides.cost ? overrides.cost(method, params) : rangedCostReply(params);
    }
    if (overrides.usage) return overrides.usage(method, params);
    return { inputTokens: 100, outputTokens: 20, costUsd: 0.001, models: ["sonnet"] };
  };
  return { request, calls, costCalls: () => calls.filter((call) => isCostRead(call.method, call.params)) };
}

const LIVE = { connected: true, usageState: "live" as const };

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
    expect(gateway.costCalls()).toHaveLength(2);
    expect(sync.costFor("24h", "builder")).toEqual({ costMicroUsd: 7_000, hasCost: true });
    expect(sync.costFor("7d", "builder")).toEqual({ costMicroUsd: 30_000, hasCost: true });
    expect(sync.getCostCoverage("24h")).toBe("live");
    expect(sync.getCostCoverage("7d")).toBe("live");
  });

  /**
   * The Gateway prices calendar days. `range` has no value below `7d`, so the
   * short window has to name a single date, and the offset has to be sent with it
   * — left out, the schema buckets by UTC midnight and the figure under "today"
   * would be someone else's day.
   */
  it("asks for a named day and a preset week, not a rolling window", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const sync = synchronizer(repo, gateway.request);
    await sync.runOnce({ ...LIVE, now: NOW });

    const [short, week] = gateway.costCalls().map((call) => call.params);
    expect(short).toMatchObject({
      agentScope: "all",
      groupBy: "family",
      limit: 1,
      mode: "specific",
      utcOffset: localUtcOffset(NOW),
      startDate: localDateLabel(NOW),
      endDate: localDateLabel(NOW),
    });
    expect(short).not.toHaveProperty("range");
    expect(week).toMatchObject({ agentScope: "all", range: "7d", limit: 1 });
    expect(week).not.toHaveProperty("startDate");
    // The span comes from the reply, not from what was asked: it is what the card
    // labels the window with.
    expect(sync.costSpan("24h")).toEqual({ from: localDateLabel(NOW), to: localDateLabel(NOW) });
    expect(sync.costSpan("7d")).toEqual({ from: "2026-08-12", to: "2026-08-18" });
  });

  /**
   * The pattern is the Gateway's own: `^UTC[+-]\d{1,2}(?::[0-5]\d)?$`, and a
   * string that misses it is not rejected — the day range silently becomes a UTC
   * one. A host in a zone nobody developed from would then be priced on the wrong
   * day and say nothing about it, so the format is checked from zones rather than
   * from wherever this suite happens to run.
   */
  it("writes an offset the Gateway accepts from any zone, including UTC itself", () => {
    const accepted = /^UTC[+-]\d{1,2}(?::[0-5]\d)?$/;
    const zones: Array<[number, string]> = [
      [0, "UTC+0"],
      [480, "UTC+8"],
      [-300, "UTC-5"],
      [330, "UTC+5:30"],
      [-210, "UTC-3:30"],
      [-570, "UTC-9:30"],
      [840, "UTC+14"],
      [-720, "UTC-12"],
    ];

    for (const [minutes, expected] of zones) {
      expect(utcOffsetLabel(minutes)).toBe(expected);
      expect(utcOffsetLabel(minutes)).toMatch(accepted);
    }
  });

  /** One entry the Gateway could not price makes the whole range a floor. */
  it("reports a range with unpriced entries as a floor", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway({
      cost: async () => ({
        aggregates: { byAgent: [{ agentId: "builder", totals: { totalCost: 0.5, missingCostEntries: 2 } }] },
      }),
    });
    const sync = synchronizer(repo, gateway.request);
    await sync.runOnce({ ...LIVE, now: NOW });

    expect(sync.costFor("24h", "builder")).toEqual({ costMicroUsd: 500_000, hasCost: false });
  });

  it("re-prices on its own slower cadence, not every usage round", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const sync = synchronizer(repo, gateway.request);

    await sync.runOnce({ ...LIVE, now: NOW });
    await sync.runOnce({ ...LIVE, now: NOW + 60_000 });
    expect(gateway.costCalls()).toHaveLength(2);

    await sync.runOnce({ ...LIVE, now: NOW + COST_SYNC_MS });
    expect(gateway.costCalls()).toHaveLength(4);
  });

  /**
   * Cost now rides on the method the token reads use, so a Gateway that does not
   * have it has no pricing either — and the cost view has to say that rather than
   * go on reporting "not collected yet" about an answer that is never coming.
   */
  it("reports pricing as unavailable when the method itself is", async () => {
    const repo = repository();
    seed(repo, 2);
    const gateway = recordingGateway();
    const sync = synchronizer(repo, gateway.request);
    const outcome = await sync.runOnce({ ...LIVE, now: NOW, usageState: "unavailable" });

    expect(outcome).toMatchObject({ coverage: "unavailable", costRefreshed: false });
    expect(sync.getCostCoverage("24h")).toBe("unavailable");
    expect(sync.getCostCoverage("7d")).toBe("unavailable");
    expect(gateway.calls).toEqual([]);
  });

  it("keeps the previous price rather than blanking it when a refresh fails", async () => {
    const repo = repository();
    seed(repo, 1);
    let failing = false;
    const gateway = recordingGateway({
      cost: async (_method, params) => {
        if (failing) throw new Error("boom");
        return rangedCostReply(params);
      },
    });
    const sync = synchronizer(repo, gateway.request);
    await sync.runOnce({ ...LIVE, now: NOW });

    failing = true;
    const outcome = await sync.runOnce({ ...LIVE, now: NOW + COST_SYNC_MS });

    expect(sync.costFor("24h", "builder")).toEqual({ costMicroUsd: 7_000, hasCost: true });
    expect(sync.getCostCoverage("24h")).toBe("error");
    // Pricing sits in a try boundary of its own: the tokens for this round were
    // still read and stored.
    expect(outcome).toMatchObject({ recorded: 1, coverage: "live" });
  });

  /**
   * The windows are separate requests that fail separately. Building a fresh pair
   * and swapping both in meant the failed window arrived as an empty map — its
   * prices silently gone — while the round reported `live` on the strength of the
   * window that did answer, which is a figure presented as priced when nothing
   * priced it.
   */
  it("degrades only the window whose request failed", async () => {
    const repo = repository();
    seed(repo, 1);
    let failShortWindow = false;
    const gateway = recordingGateway({
      cost: async (_method, params) => {
        // The short window names a day; the week asks for a preset range. That is
        // how the two are told apart without depending on call order.
        if (failShortWindow && params.startDate !== undefined) throw new Error("boom");
        return rangedCostReply(params);
      },
    });
    const sync = synchronizer(repo, gateway.request);
    await sync.runOnce({ ...LIVE, now: NOW });
    expect(sync.costFor("7d", "builder")).toEqual({ costMicroUsd: 30_000, hasCost: true });

    failShortWindow = true;
    await sync.runOnce({ ...LIVE, now: NOW + COST_SYNC_MS });

    expect(sync.getCostCoverage("24h")).toBe("error");
    expect(sync.getCostCoverage("7d")).toBe("live");
    // The window that failed keeps the price it last knew rather than blanking it.
    expect(sync.costFor("24h", "builder")).toEqual({ costMicroUsd: 7_000, hasCost: true });
    expect(sync.costFor("7d", "builder")).toEqual({ costMicroUsd: 30_000, hasCost: true });
  });

  it("forgets prices when the connection generation changes", async () => {
    const repo = repository();
    seed(repo, 1);
    const gateway = recordingGateway();
    const sync = synchronizer(repo, gateway.request);
    await sync.runOnce({ ...LIVE, now: NOW });

    sync.resetCost();
    expect(sync.costFor("24h", "builder")).toBeUndefined();
    expect(sync.getCostCoverage("24h")).toBe("not_observed");
    expect(sync.getCostCoverage("7d")).toBe("not_observed");
  });
});
