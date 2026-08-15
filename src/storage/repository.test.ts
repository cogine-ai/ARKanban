import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptPatch, taskToActivity } from "../activity/projector.js";
import { decodeCursor } from "./keyset-cursor.js";
import {
  CollectorRepository,
  type SessionPage,
  type SessionPageQuery,
  type SessionWrite,
} from "./repository.js";

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

    // Inference supplies a placeholder name and an unknown kind as real values,
    // so they would overwrite the roster unless the write is held subordinate.
    expect(repo.listAgents()[0]).toMatchObject({
      origin: "roster",
      displayName: "Builder",
      kind: "agent",
      model: "sonnet",
      firstObservedAt: 1_000,
    });
  });

  it("does not bump the revision when inference repeats against a roster entry", () => {
    const repo = repository();
    repo.upsertAgents([
      { id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1_000 },
    ]);
    const revision = repo.revision;
    repo.upsertAgents([{ id: "builder", displayName: "builder", kind: "unknown", origin: "observed", observedAt: 2_000 }]);
    repo.upsertAgents([{ id: "builder", displayName: "builder", kind: "unknown", origin: "observed", observedAt: 3_000 }]);

    expect(repo.revision).toBe(revision);
  });

  it("upgrades an inferred entry when the roster finally arrives", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "builder", displayName: "builder", kind: "unknown", origin: "observed", observedAt: 1_000 }]);
    repo.upsertAgents([
      { id: "builder", displayName: "Builder", kind: "system", runtime: "openclaw", origin: "roster", observedAt: 2_000 },
    ]);

    expect(repo.listAgents()[0]).toMatchObject({
      origin: "roster",
      displayName: "Builder",
      kind: "system",
      runtime: "openclaw",
    });
  });

  it("lets a later roster write correct an earlier roster value", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1_000 }]);
    repo.upsertAgents([{ id: "builder", displayName: "Build Bot", kind: "system", origin: "roster", observedAt: 2_000 }]);

    expect(repo.listAgents()[0]).toMatchObject({ displayName: "Build Bot", kind: "system" });
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

describe("CollectorRepository session pagination", () => {
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

  /** Walks every page, returning the keys in order plus the number of pages taken. */
  function drain(
    repo: CollectorRepository,
    query: Omit<SessionPageQuery, "cursor">,
  ): { keys: string[]; pages: number } {
    const keys: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page: SessionPage = repo.listSessionsPage({
        ...query,
        ...(cursor ? { cursor: decodeCursor(cursor, query.sort)! } : {}),
      });
      keys.push(...page.items.map((item) => item.sessionKey));
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 50) throw new Error("pagination did not terminate");
    } while (cursor);
    return { keys, pages };
  }

  it("walks every session exactly once across pages", () => {
    const repo = repository();
    repo.upsertSessions(
      Array.from({ length: 25 }, (_, index) => session({ sessionKey: `s-${index}`, lastActivityAt: 1_000 + index })),
    );

    const { keys, pages } = drain(repo, { sort: "lastActivity", limit: 10 });
    expect(pages).toBe(3);
    expect(keys).toHaveLength(25);
    expect(new Set(keys).size).toBe(25);
  });

  it("does not skip or repeat rows that share one timestamp", () => {
    const repo = repository();
    // The tiebreaker carries the whole ordering here, which is where a keyset
    // scan comparing only the sort value would loop or drop rows.
    repo.upsertSessions(
      Array.from({ length: 12 }, (_, index) => session({ sessionKey: `same-${index}`, lastActivityAt: 7_000 })),
    );

    const { keys } = drain(repo, { sort: "lastActivity", limit: 5 });
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
  });

  it("orders by last activity descending with the session key as tiebreaker", () => {
    const repo = repository();
    repo.upsertSessions([
      session({ sessionKey: "b", lastActivityAt: 100 }),
      session({ sessionKey: "a", lastActivityAt: 100 }),
      session({ sessionKey: "c", lastActivityAt: 200 }),
    ]);

    expect(repo.listSessionsPage({ sort: "lastActivity", limit: 10 }).items.map((row) => row.sessionKey)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("omits the cursor on the final page", () => {
    const repo = repository();
    repo.upsertSessions([session({ sessionKey: "only" })]);
    expect(repo.listSessionsPage({ sort: "lastActivity", limit: 10 }).nextCursor).toBeUndefined();
  });

  it("issues a cursor when a further page exists", () => {
    const repo = repository();
    repo.upsertSessions([session({ sessionKey: "a", lastActivityAt: 1 }), session({ sessionKey: "b", lastActivityAt: 2 })]);
    expect(repo.listSessionsPage({ sort: "lastActivity", limit: 1 }).nextCursor).toBeDefined();
  });

  it("separates active, terminal and archived sessions", () => {
    const repo = repository();
    repo.upsertSessions([
      session({ sessionKey: "running", hasActiveRun: true }),
      session({ sessionKey: "idle", hasActiveRun: false }),
      session({ sessionKey: "gone", archived: true }),
    ]);

    const keysFor = (state: SessionPageQuery["state"]): string[] =>
      repo.listSessionsPage({ sort: "lastActivity", limit: 10, ...(state ? { state } : {}) }).items.map((r) => r.sessionKey);

    expect(keysFor("active")).toEqual(["running"]);
    expect(keysFor("terminal")).toEqual(["idle"]);
    expect(keysFor("archived")).toEqual(["gone"]);
    // Unfiltered includes archived, unlike the legacy listSessions default.
    expect(keysFor(undefined)).toHaveLength(3);
  });

  it("filters by agent and time window", () => {
    const repo = repository();
    repo.upsertSessions([
      session({ sessionKey: "old", agentId: "builder", lastActivityAt: 1_000 }),
      session({ sessionKey: "new", agentId: "builder", lastActivityAt: 9_000 }),
      session({ sessionKey: "other", agentId: "writer", lastActivityAt: 9_000 }),
    ]);

    expect(
      repo.listSessionsPage({ sort: "lastActivity", limit: 10, agentId: "builder", since: 5_000 }).items.map((r) => r.sessionKey),
    ).toEqual(["new"]);
    expect(
      repo.listSessionsPage({ sort: "lastActivity", limit: 10, until: 5_000 }).items.map((r) => r.sessionKey),
    ).toEqual(["old"]);
  });

  it("sorts by duration independently of recency", () => {
    const repo = repository();
    repo.upsertSessions([
      session({ sessionKey: "brief", createdAt: 9_000, lastActivityAt: 9_100 }),
      session({ sessionKey: "long", createdAt: 1_000, lastActivityAt: 8_000 }),
    ]);

    expect(repo.listSessionsPage({ sort: "duration", limit: 10 }).items.map((r) => r.sessionKey)).toEqual([
      "long",
      "brief",
    ]);
  });

  it("paginates a duration scan without repeating rows", () => {
    const repo = repository();
    repo.upsertSessions(
      Array.from({ length: 9 }, (_, index) =>
        session({ sessionKey: `d-${index}`, createdAt: 1_000, lastActivityAt: 1_000 + index * 100 }),
      ),
    );

    const { keys } = drain(repo, { sort: "duration", limit: 4 });
    expect(new Set(keys).size).toBe(9);
  });
});

describe("CollectorRepository agent overviews", () => {
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

  it("counts sessions per agent by state", () => {
    const repo = repository();
    repo.upsertAgents([
      { id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1_000 },
    ]);
    repo.upsertSessions([
      session({ sessionKey: "a", hasActiveRun: true }),
      session({ sessionKey: "b", hasActiveRun: false }),
      session({ sessionKey: "c", archived: true }),
    ]);

    expect(repo.getAgentOverview("builder")).toMatchObject({
      sessionCount: 3,
      activeSessionCount: 1,
      archivedSessionCount: 1,
    });
  });

  it("keeps a roster agent that has no sessions yet", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "idle", displayName: "Idle", kind: "agent", origin: "roster", observedAt: 1_000 }]);

    expect(repo.getAgentOverview("idle")).toMatchObject({ sessionCount: 0, activeSessionCount: 0 });
  });

  it("returns undefined for an unknown agent", () => {
    expect(repository().getAgentOverview("nobody")).toBeUndefined();
  });

  it("reports the most recent session activity per agent", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1 }]);
    repo.upsertSessions([
      session({ sessionKey: "a", lastActivityAt: 4_000 }),
      session({ sessionKey: "b", lastActivityAt: 8_000 }),
    ]);

    expect(repo.getAgentOverview("builder")?.lastSessionActivityAt).toBe(8_000);
  });
});

describe("CollectorRepository agent recent rollups", () => {
  const day = 24 * 60 * 60 * 1_000;
  const rangeEnd = 30 * day;
  const run = (
    id: string,
    status: "completed" | "failed",
    endedAt: number,
    extra: { startedAt?: number; agentId?: string } = {},
  ) => taskToActivity({
    id,
    title: id,
    status,
    agentId: extra.agentId ?? "builder",
    endedAt,
    ...(extra.startedAt !== undefined ? { startedAt: extra.startedAt } : {}),
  }, rangeEnd)!;

  const overview = (repo: CollectorRepository, agentId = "builder") => repo.getAgentOverview(agentId, rangeEnd)!;

  it("separates the 24h and 7d windows", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1 }]);
    repo.upsertMany(
      [
        run("today", "completed", rangeEnd - 60_000),
        run("three-days-ago", "completed", rangeEnd - 3 * day),
        run("three-weeks-ago", "completed", rangeEnd - 21 * day),
      ],
      ["test"],
    );

    const agent = overview(repo);
    expect(agent.recent["24h"].completed).toBe(1);
    expect(agent.recent["7d"].completed).toBe(2);
  });

  it("counts outcomes and derives a success rate", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1 }]);
    repo.upsertMany(
      [
        run("ok-1", "completed", rangeEnd - 1_000),
        run("ok-2", "completed", rangeEnd - 2_000),
        run("ok-3", "completed", rangeEnd - 3_000),
        run("bad-1", "failed", rangeEnd - 4_000),
      ],
      ["test"],
    );

    expect(overview(repo).recent["24h"]).toMatchObject({ completed: 4, succeeded: 3, failed: 1, successRate: 0.75 });
  });

  it("leaves the success rate undefined when nothing completed, rather than reporting zero", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "quiet", displayName: "Quiet", kind: "agent", origin: "roster", observedAt: 1 }]);

    const agent = overview(repo, "quiet");
    expect(agent.recent["24h"].completed).toBe(0);
    expect(agent.recent["24h"].successRate).toBeUndefined();
    expect(agent.recent["7d"].successRate).toBeUndefined();
  });

  it("averages duration only over runs that reported both a start and an end", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1 }]);
    repo.upsertMany(
      [
        run("timed-1", "completed", rangeEnd - 1_000, { startedAt: rangeEnd - 11_000 }),
        run("timed-2", "completed", rangeEnd - 2_000, { startedAt: rangeEnd - 22_000 }),
        run("untimed", "completed", rangeEnd - 3_000),
      ],
      ["test"],
    );

    const rollup = overview(repo).recent["24h"];
    expect(rollup.completed).toBe(3);
    expect(rollup.durationSampleCount).toBe(2);
    expect(rollup.avgDurationMs).toBe(15_000);
  });

  it("leaves the average duration undefined when no run was timed", () => {
    const repo = repository();
    repo.upsertAgents([{ id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1 }]);
    repo.upsertMany([run("untimed", "completed", rangeEnd - 1_000)], ["test"]);

    expect(overview(repo).recent["24h"].avgDurationMs).toBeUndefined();
    expect(overview(repo).recent["24h"].durationSampleCount).toBe(0);
  });

  it("keeps rollups attributed to their own agent", () => {
    const repo = repository();
    repo.upsertAgents([
      { id: "builder", displayName: "Builder", kind: "agent", origin: "roster", observedAt: 1 },
      { id: "runner", displayName: "Runner", kind: "agent", origin: "roster", observedAt: 1 },
    ]);
    repo.upsertMany(
      [
        run("b-1", "completed", rangeEnd - 1_000),
        run("r-1", "failed", rangeEnd - 1_000, { agentId: "runner" }),
        run("r-2", "failed", rangeEnd - 2_000, { agentId: "runner" }),
      ],
      ["test"],
    );

    expect(overview(repo).recent["24h"]).toMatchObject({ completed: 1, succeeded: 1 });
    expect(overview(repo, "runner").recent["24h"]).toMatchObject({ completed: 2, failed: 2, successRate: 0 });
  });
});

describe("CollectorRepository change topics", () => {
  const session = (sessionKey: string): SessionWrite => ({
    sessionKey,
    agentId: "builder",
    label: "Session",
    kindHint: "main",
    archived: false,
    hasActiveRun: false,
    lineage: {},
    lastActivityAt: 5_000,
    observedAt: 5_000,
    coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "not_observed" },
  });

  it("tags session writes with the sessions topic", () => {
    const repo = repository();
    const topics: string[][] = [];
    repo.subscribe((change) => topics.push(change.topics));
    repo.upsertSessions([session("s-1")]);

    expect(topics).toEqual([["sessions"]]);
  });

  it("tags roster writes with the agents topic", () => {
    const repo = repository();
    const topics: string[][] = [];
    repo.subscribe((change) => topics.push(change.topics));
    repo.upsertAgents([{ id: "a", displayName: "A", kind: "agent", origin: "roster", observedAt: 1 }]);

    expect(topics).toEqual([["agents"]]);
  });

  it("stays silent when a reconcile changes nothing", () => {
    const repo = repository();
    repo.upsertSessions([session("s-1")]);
    const topics: string[][] = [];
    repo.subscribe((change) => topics.push(change.topics));
    repo.upsertSessions([session("s-1")]);

    expect(topics).toEqual([]);
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
