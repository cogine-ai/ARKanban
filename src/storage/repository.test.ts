import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptPatch, taskToActivity } from "../activity/projector.js";
import { CollectorRepository } from "./repository.js";

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
