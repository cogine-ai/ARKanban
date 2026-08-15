import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptPatch, taskToActivity } from "../activity/projector.js";
import { CollectorRepository, type SessionWrite } from "./repository.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function repository(): CollectorRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-repository-"));
  const result = new CollectorRepository(path.join(directory, "collector.sqlite"));
  cleanups.push(() => {
    result.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return result;
}

describe("CollectorRepository agents and sessions", () => {
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

  it("never downgrades an authoritative roster entry to an inferred one", () => {
    const repo = repository();
    repo.upsertAgents([
      { id: "builder", displayName: "Builder", kind: "agent", model: "sonnet", origin: "roster", observedAt: 1_000 },
    ]);
    repo.upsertAgents([{ id: "builder", displayName: "builder", kind: "unknown", origin: "observed", observedAt: 2_000 }]);

    expect(repo.listAgents()[0]).toMatchObject({ origin: "roster", model: "sonnet", firstObservedAt: 1_000 });
  });

  it("keeps lineage facts that a later partial observation omits", () => {
    const repo = repository();
    repo.upsertSessions([
      session({ sessionKey: "s-1", lineage: { forkSourceKey: "s-0", spawnDepth: 2 }, createdAt: 100 }),
    ]);
    repo.upsertSessions([session({ sessionKey: "s-1", label: "Renamed", lastActivityAt: 9_000 })]);

    const stored = repo.getSession("s-1");
    expect(stored).toMatchObject({ label: "Renamed", lastActivityAt: 9_000, createdAt: 100 });
    expect(stored?.lineage).toEqual({ forkSourceKey: "s-0", spawnDepth: 2 });
  });

  it("reports no change when the same session row is observed twice", () => {
    const repo = repository();
    expect(repo.upsertSessions([session({ sessionKey: "s-1" })])).toBe(1);
    expect(repo.upsertSessions([session({ sessionKey: "s-1" })])).toBe(0);
  });

  it("promotes a claimed session key to a confirmed reference only once the session exists", () => {
    const repo = repository();
    const attempt = attemptPatch({
      id: "attempt:ri_1",
      sourceKey: "attempt:run:run-1",
      origin: "online",
      agentId: "builder",
      title: "Run",
      now: 1_100,
      sessionKey: "s-1",
      state: "active",
      phase: "tool",
      source: "events",
      eventKind: "agent:tool:start",
    });
    repo.upsertMany([attempt], ["test"]);

    expect(repo.linkActivitySessions()).toBe(0);

    repo.upsertSessions([session({ sessionKey: "s-1" })]);
    expect(repo.linkActivitySessions()).toBe(1);
    expect(repo.getSession("s-1")?.activityCount).toBe(1);
  });

  it("keeps session archives when the terminal activities they describe are pruned", () => {
    const repo = repository();
    repo.upsertSessions([session({ sessionKey: "s-1", lastActivityAt: 1_000 })]);
    repo.prune(Date.now());

    expect(repo.getSession("s-1")).toBeDefined();
  });

  it("ages out only archived sessions and clears the references they leave behind", () => {
    const repo = repository();
    repo.upsertSessions([
      session({ sessionKey: "old-archived", archived: true, lastActivityAt: 1_000 }),
      session({ sessionKey: "old-live", archived: false, lastActivityAt: 1_000 }),
    ]);

    expect(repo.pruneSessions(2_000)).toBe(1);
    expect(repo.getSession("old-archived")).toBeUndefined();
    expect(repo.getSession("old-live")).toBeDefined();
  });

  it("excludes archived sessions from the default listing", () => {
    const repo = repository();
    repo.upsertSessions([
      session({ sessionKey: "live", lastActivityAt: 2_000 }),
      session({ sessionKey: "archived", archived: true, lastActivityAt: 3_000 }),
    ]);

    expect(repo.listSessions().map((row) => row.sessionKey)).toEqual(["live"]);
    expect(repo.listSessions({ includeArchived: true })).toHaveLength(2);
  });
});

describe("CollectorRepository", () => {
  it("stores a queryable projection, relations, and a bounded timeline", () => {
    const repo = repository();
    const task = taskToActivity({ id: "task-1", status: "running", runId: "run-1", agentId: "builder", title: "Build MVP" }, 1_000)!;
    const attempt = attemptPatch({
      id: "attempt:ri_1",
      sourceKey: "attempt:run:run-1",
      origin: "online",
      agentId: "builder",
      title: "Build MVP run",
      now: 1_100,
      runRef: "run-1",
      sessionKey: "agent:builder:one",
      state: "active",
      phase: "tool",
      lastToolName: "edit",
      source: "events",
      eventKind: "agent:tool:start",
    });
    repo.upsertMany([task, attempt], ["test"]);

    const snapshot = repo.snapshotViews();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.relations).toContainEqual(expect.objectContaining({ type: "run_correlation", from: task.id, to: attempt.id }));
    expect(repo.detail(attempt.id)?.timeline[0]).toMatchObject({ kind: "agent:tool:start", toolName: "edit" });
  });

  it("does not advance revision for an identical snapshot", () => {
    const repo = repository();
    const task = taskToActivity({ id: "task-1", status: "queued" }, 1_000)!;
    repo.upsertMany([task], ["first"]);
    const firstRevision = repo.revision;
    expect(repo.upsertMany([task], ["repeat"])).toBeNull();
    expect(repo.revision).toBe(firstRevision);
  });

  it("moves an operational task missing from the next authoritative snapshot to unresolved", () => {
    const repo = repository();
    const task = taskToActivity({ id: "task-1", status: "running" }, 1_000)!;
    repo.upsertMany([task], ["first"]);
    repo.markMissingTasks(new Set(), 2_000);
    expect(repo.snapshotViews().items[0]).toMatchObject({ state: "unknown", stage: "unresolved", freshness: "stale" });
  });

  it("upgrades only a unique unbound session placeholder when a run reference arrives", () => {
    const repo = repository();
    const sessionKey = "agent:pm-awb:feishu:group:one";
    const placeholder = (id: string, sourceKey: string, now: number) => attemptPatch({
      id,
      sourceKey,
      origin: "session_segment",
      agentId: "pm-awb",
      title: "Feishu session",
      now,
      sessionKey,
      state: "active",
      phase: "unknown",
      source: "session",
      eventKind: "session_snapshot",
    });

    repo.upsertMany([placeholder("attempt:placeholder-one", "attempt:session:one", 1_000)], ["snapshot"]);
    expect(repo.findOpenAttempt({ runRef: "run-one", sessionKey })?.id).toBe("attempt:placeholder-one");

    repo.upsertMany([placeholder("attempt:placeholder-two", "attempt:session:two", 2_000)], ["ambiguous_snapshot"]);
    expect(repo.findOpenAttempt({ runRef: "run-two", sessionKey })).toBeUndefined();
    expect(repo.findOpenAttempt({ sessionKey })).toBeUndefined();
    expect(repo.findOpenAttemptsBySessionKey(sessionKey)).toHaveLength(2);
  });

  it("backfills only Unattributed activities with a strict agent session key when reopening storage", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "collector-repository-backfill-"));
    const databasePath = path.join(directory, "collector.sqlite");
    let initial: CollectorRepository | undefined = new CollectorRepository(databasePath);
    let reopened: CollectorRepository | undefined;
    const candidate = (id: string, sessionKey: string) => attemptPatch({
      id,
      sourceKey: `attempt:${id}`,
      origin: "online",
      agentId: "Unattributed",
      title: id,
      now: 1_000,
      sessionKey,
      state: "terminal",
      outcome: "unknown",
      source: "events",
      eventKind: "agent:lifecycle:end",
    });
    try {
      initial.upsertMany([
        candidate("repairable", "agent:pm-awb:cron:one"),
        candidate("malformed", "agent:bad/id:cron:one"),
        candidate("unknown-format", "external-session"),
      ], ["fixture"]);
      initial.close();
      initial = undefined;

      reopened = new CollectorRepository(databasePath);
      expect(reopened.detail("repairable")?.item.agentId).toBe("pm-awb");
      expect(reopened.detail("repairable")?.timeline[0]).toMatchObject({ source: "collector", kind: "session_agent_backfill", status: "pm-awb" });
      expect(reopened.detail("malformed")?.item.agentId).toBe("Unattributed");
      expect(reopened.detail("unknown-format")?.item.agentId).toBe("Unattributed");
    } finally {
      initial?.close();
      reopened?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("aggregates the complete settled range before grouping and preserves low-frequency series", () => {
    const repo = repository();
    const day = 24 * 60 * 60 * 1_000;
    const rangeEnd = 10 * day;
    const frequent = Array.from({ length: 205 }, (_, index) => taskToActivity({
      id: `frequent-${index}`,
      status: "completed",
      agentId: "builder",
      title: "Frequent health check",
      endedAt: rangeEnd - 10_000 - index,
    }, rangeEnd)!);
    const lowFrequency = taskToActivity({
      id: "monthly-report",
      status: "completed",
      agentId: "builder",
      title: "Monthly report",
      endedAt: rangeEnd - 5_000,
    }, rangeEnd)!;
    const outsideRange = taskToActivity({
      id: "old-run",
      status: "completed",
      agentId: "builder",
      title: "Old series",
      endedAt: rangeEnd - 8 * day,
    }, rangeEnd)!;
    repo.upsertMany([...frequent, lowFrequency, outsideRange], ["test"]);

    const groups = repo.settledGroups("7d", rangeEnd);
    expect(groups.totalRuns).toBe(206);
    expect(groups.totalSeries).toBe(2);
    expect(groups.outcomeCounts.succeeded).toBe(206);
    expect(groups.groupsByAgent.builder?.map((group) => [group.title, group.runCount])).toEqual([
      ["Monthly report", 1],
      ["Frequent health check", 205],
    ]);
    const monthly = groups.groupsByAgent.builder?.[0];
    expect(monthly).toMatchObject({ groupingConfidence: "display_exact", priorityTier: "P3" });
    expect(repo.settledSeriesRuns(monthly!.seriesKey, "7d", rangeEnd)?.runs.map((run) => run.id)).toEqual([lowFrequency.id]);
  });

  it("keeps task and attempt series separate and orders exception tiers first", () => {
    const repo = repository();
    const rangeEnd = 1_000_000;
    const task = taskToActivity({
      id: "task-shared",
      status: "completed",
      agentId: "agent-one",
      title: "Shared title",
      endedAt: rangeEnd - 100,
    }, rangeEnd)!;
    const attempt = attemptPatch({
      id: "attempt:shared",
      sourceKey: "attempt:shared",
      origin: "online",
      agentId: "agent-one",
      title: "Shared title",
      now: rangeEnd,
      state: "terminal",
      outcome: "unknown",
      endedAt: rangeEnd - 50,
      source: "events",
      eventKind: "agent:end",
    });
    repo.upsertMany([task, attempt], ["test"]);

    const groups = repo.settledGroups("24h", rangeEnd).groupsByAgent["agent-one"]!;
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.kind).sort()).toEqual(["attempt", "task"]);
    expect(groups[0]).toMatchObject({ kind: "attempt", priorityTier: "P1", latestOutcome: "unknown" });
    expect(groups[1]).toMatchObject({ kind: "task", priorityTier: "P3", latestOutcome: "succeeded" });
  });

  it("sorts P0 through P3 deterministically and uses failure rate inside P2", () => {
    const repo = repository();
    const rangeEnd = 20_000_000;
    const task = (id: string, title: string, status: "completed" | "failed", endedAt: number) => taskToActivity({
      id,
      title,
      status,
      agentId: "sorting-agent",
      endedAt,
    }, rangeEnd)!;
    const unknown = attemptPatch({
      id: "attempt:unknown",
      sourceKey: "attempt:unknown",
      origin: "online",
      agentId: "sorting-agent",
      title: "Latest unknown",
      now: rangeEnd,
      state: "terminal",
      outcome: "unknown",
      endedAt: rangeEnd - 50,
      source: "events",
      eventKind: "agent:end",
    });
    repo.upsertMany([
      task("p0", "Latest failed", "failed", rangeEnd - 10),
      unknown,
      task("p2-high-old", "Recovered high rate", "failed", rangeEnd - 500),
      task("p2-high-new", "Recovered high rate", "completed", rangeEnd - 100),
      task("p2-low-old", "Recovered low rate", "failed", rangeEnd - 800),
      task("p2-low-mid-1", "Recovered low rate", "completed", rangeEnd - 700),
      task("p2-low-mid-2", "Recovered low rate", "completed", rangeEnd - 600),
      task("p2-low-new", "Recovered low rate", "completed", rangeEnd - 90),
      task("p3", "Always healthy", "completed", rangeEnd - 20),
    ], ["test"]);

    const groups = repo.settledGroups("24h", rangeEnd).groupsByAgent["sorting-agent"]!;
    expect(groups.map((group) => [group.title, group.priorityTier, group.failureRate])).toEqual([
      ["Latest failed", "P0", 1],
      ["Latest unknown", "P1", 0],
      ["Recovered high rate", "P2", 0.5],
      ["Recovered low rate", "P2", 0.25],
      ["Always healthy", "P3", 0],
    ]);
  });
});
