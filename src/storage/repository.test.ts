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
});
