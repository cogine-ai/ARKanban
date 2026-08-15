import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "./repository.js";
import { DAY_MS, type UsageWrite } from "./usage-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = 1_800_000_000_000;

function repository(): CollectorRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-usage-"));
  const repo = new CollectorRepository(path.join(directory, "collector.db"));
  cleanups.push(() => {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return repo;
}

function session(
  repo: CollectorRepository,
  sessionKey: string,
  agentId: string,
  overrides: { hasActiveRun?: boolean; archived?: boolean; lastActivityAt?: number } = {},
): void {
  repo.upsertSessions([
    {
      sessionKey,
      agentId,
      label: sessionKey,
      kindHint: "main",
      archived: overrides.archived ?? false,
      hasActiveRun: overrides.hasActiveRun ?? false,
      lineage: {},
      lastActivityAt: overrides.lastActivityAt ?? NOW,
      observedAt: NOW,
      coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "not_observed" },
    },
  ]);
}

function usage(sessionKey: string, overrides: Partial<UsageWrite> = {}): UsageWrite {
  return {
    sessionKey,
    observedAt: NOW,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    costMicroUsd: 1_500,
    hasCost: true,
    models: ["sonnet"],
    unpricedModels: [],
    ...overrides,
  };
}

describe("UsageStore", () => {
  it("keeps the newest reading per session instead of summing cumulative snapshots", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    repo.usage.record([usage("agent:builder:1", { observedAt: NOW - 60_000, inputTokens: 100, costMicroUsd: 1_000 })]);
    repo.usage.record([usage("agent:builder:1", { observedAt: NOW, inputTokens: 340, costMicroUsd: 3_400 })]);

    const latest = repo.usage.latest("agent:builder:1");
    expect(latest?.inputTokens).toBe(340);

    const windows = repo.usage.agentWindows(["builder"], NOW);
    expect(windows.get("builder")?.["24h"]).toMatchObject({
      inputTokens: 340,
      costMicroUsd: 3_400,
      sessionCount: 1,
    });
  });

  it("replaces a reading observed in the same millisecond rather than failing", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    repo.usage.record([usage("agent:builder:1", { inputTokens: 10 })]);
    repo.usage.record([usage("agent:builder:1", { inputTokens: 99 })]);
    expect(repo.usage.latest("agent:builder:1")?.inputTokens).toBe(99);
  });

  it("separates an unpriced total from a genuinely free one", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    session(repo, "agent:runner:1", "runner");
    repo.usage.record([
      usage("agent:builder:1", { hasCost: false, models: ["local-llm"], costMicroUsd: undefined }),
      usage("agent:runner:1", { hasCost: true, costMicroUsd: 0 }),
    ]);

    const windows = repo.usage.agentWindows(["builder", "runner"], NOW);
    expect(windows.get("builder")?.["24h"]).toMatchObject({ hasCost: false, unpricedModels: ["local-llm"] });
    expect(windows.get("builder")?.["24h"]).not.toHaveProperty("costMicroUsd");
    expect(windows.get("runner")?.["24h"]).toMatchObject({ hasCost: true, costMicroUsd: 0 });
  });

  it("counts a reading toward 7d but not 24h once it ages out", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    repo.usage.record([usage("agent:builder:1", { observedAt: NOW - 3 * DAY_MS })]);

    const windows = repo.usage.agentWindows(["builder"], NOW);
    expect(windows.get("builder")?.["24h"].sessionCount).toBe(0);
    expect(windows.get("builder")?.["7d"].sessionCount).toBe(1);
  });

  it("reports zero for an agent with no usage instead of dropping it", () => {
    const repo = repository();
    session(repo, "agent:quiet:1", "quiet");
    const windows = repo.usage.agentWindows(["quiet"], NOW);
    expect(windows.get("quiet")?.["24h"]).toMatchObject({ sessionCount: 0, inputTokens: 0, hasCost: true });
  });
});

describe("UsageStore candidates", () => {
  const options = {
    now: NOW,
    recentWindowMs: 15 * 60_000,
    staleAfterMs: 6 * 60 * 60_000,
    staleLimit: 20,
    limit: 100,
  };

  it("puts running sessions ahead of merely recent ones", () => {
    const repo = repository();
    session(repo, "agent:builder:recent", "builder", { lastActivityAt: NOW - 60_000 });
    session(repo, "agent:builder:running", "builder", { hasActiveRun: true, lastActivityAt: NOW - 600_000 });

    const { candidates } = repo.usage.candidates(options);
    expect(candidates.map((entry) => entry.sessionKey)).toEqual(["agent:builder:running", "agent:builder:recent"]);
    expect(candidates[0]?.reason).toBe("active");
  });

  it("skips archived sessions and quiet ones that were measured recently", () => {
    const repo = repository();
    session(repo, "agent:builder:archived", "builder", { archived: true, hasActiveRun: true });
    session(repo, "agent:builder:quiet", "builder", { lastActivityAt: NOW - 2 * DAY_MS });
    repo.usage.record([usage("agent:builder:quiet", { observedAt: NOW - 60_000 })]);

    expect(repo.usage.candidates(options).candidates).toEqual([]);
  });

  it("backfills a quiet session nobody has measured in hours", () => {
    const repo = repository();
    session(repo, "agent:builder:quiet", "builder", { lastActivityAt: NOW - 2 * DAY_MS });
    const { candidates } = repo.usage.candidates(options);
    expect(candidates).toEqual([{ sessionKey: "agent:builder:quiet", reason: "stale" }]);
  });

  it("caps the round but reports the demand behind it", () => {
    const repo = repository();
    for (let index = 0; index < 5; index += 1) {
      session(repo, `agent:builder:${index}`, "builder", { hasActiveRun: true });
    }
    const { candidates, demand } = repo.usage.candidates({ ...options, limit: 2 });
    expect(candidates).toHaveLength(2);
    expect(demand).toBe(5);
  });

  it("does not let a long tail of stale sessions crowd out active ones", () => {
    const repo = repository();
    for (let index = 0; index < 30; index += 1) {
      session(repo, `agent:builder:stale-${index}`, "builder", { lastActivityAt: NOW - 3 * DAY_MS });
    }
    session(repo, "agent:builder:live", "builder", { hasActiveRun: true });

    const { candidates } = repo.usage.candidates({ ...options, staleLimit: 5 });
    expect(candidates).toHaveLength(6);
    expect(candidates[0]?.sessionKey).toBe("agent:builder:live");
  });
});

describe("UsageStore rollup", () => {
  it("folds each session-day down to its last reading and drops the raw rows", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    const day = Math.floor((NOW - 10 * DAY_MS) / DAY_MS) * DAY_MS;
    repo.usage.record([
      usage("agent:builder:1", { observedAt: day + 1_000, inputTokens: 100, costMicroUsd: 1_000 }),
      usage("agent:builder:1", { observedAt: day + 2_000, inputTokens: 250, costMicroUsd: 2_500 }),
    ]);

    const result = repo.usage.rollupOlderThan(NOW - 7 * DAY_MS);
    expect(result).toEqual({ days: 1, snapshots: 2 });
    expect(repo.usage.latest("agent:builder:1")).toBeUndefined();

    const summary = repo.usage.summary(day, NOW);
    expect(summary.totals).toMatchObject({ inputTokens: 250, costMicroUsd: 2_500, sessionCount: 1 });
    expect(summary.byModel.get("sonnet")).toMatchObject({ inputTokens: 250 });
  });

  it("is idempotent when the same day is rolled up twice", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    const day = Math.floor((NOW - 10 * DAY_MS) / DAY_MS) * DAY_MS;
    repo.usage.record([usage("agent:builder:1", { observedAt: day + 1_000, inputTokens: 250 })]);
    repo.usage.rollupOlderThan(NOW - 7 * DAY_MS);

    repo.usage.record([usage("agent:builder:1", { observedAt: day + 1_000, inputTokens: 250 })]);
    repo.usage.rollupOlderThan(NOW - 7 * DAY_MS);

    expect(repo.usage.summary(day, NOW).totals.inputTokens).toBe(250);
  });

  it("keeps an unpriced day unpriced after it crosses the rollup horizon", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    const day = Math.floor((NOW - 10 * DAY_MS) / DAY_MS) * DAY_MS;
    repo.usage.record([
      usage("agent:builder:1", {
        observedAt: day + 1_000,
        hasCost: false,
        costMicroUsd: undefined,
        models: ["local-llm"],
      }),
    ]);
    repo.usage.rollupOlderThan(NOW - 7 * DAY_MS);

    expect(repo.usage.summary(day, NOW).totals).toMatchObject({ hasCost: false, unpricedModels: ["local-llm"] });
  });

  it("spans the rollup horizon without a gap where raw rows were folded", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    session(repo, "agent:builder:2", "builder");
    const oldDay = Math.floor((NOW - 10 * DAY_MS) / DAY_MS) * DAY_MS;
    repo.usage.record([usage("agent:builder:1", { observedAt: oldDay + 1_000, inputTokens: 100 })]);
    repo.usage.rollupOlderThan(NOW - 7 * DAY_MS);
    repo.usage.record([usage("agent:builder:2", { observedAt: NOW - 60_000, inputTokens: 40 })]);

    const summary = repo.usage.summary(oldDay, NOW);
    expect(summary.totals.inputTokens).toBe(140);
    expect(summary.byAgent.get("builder")?.sessionCount).toBe(2);
  });

  it("prunes snapshots past the retention horizon", () => {
    const repo = repository();
    session(repo, "agent:builder:1", "builder");
    repo.usage.record([
      usage("agent:builder:1", { observedAt: NOW - 100 * DAY_MS }),
      usage("agent:builder:1", { observedAt: NOW }),
    ]);
    expect(repo.usage.pruneSnapshots(NOW - 90 * DAY_MS)).toBe(1);
    expect(repo.usage.latest("agent:builder:1")?.observedAt).toBe(NOW);
  });
});
