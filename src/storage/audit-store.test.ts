import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "./repository.js";
import type { AuditEventWrite } from "./audit-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = 1_800_000_000_000;

function repository(): CollectorRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-audit-"));
  const repo = new CollectorRepository(path.join(directory, "collector.sqlite"));
  cleanups.push(() => {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return repo;
}

function toolEvent(overrides: Partial<AuditEventWrite> & { eventId: string; sequence: number }): AuditEventWrite {
  return {
    occurredAt: NOW - 60_000,
    kind: "tool_action",
    action: "tool.action.finished",
    status: "succeeded",
    agentId: "main",
    sessionKey: "agent:main:one",
    runId: "run-1",
    toolName: "bash",
    observedAt: NOW,
    ...overrides,
  };
}

function runEvent(overrides: Partial<AuditEventWrite> & { eventId: string; sequence: number }): AuditEventWrite {
  return {
    occurredAt: NOW - 30_000,
    kind: "agent_run",
    action: "agent.run.finished",
    status: "succeeded",
    agentId: "main",
    sessionKey: "agent:main:one",
    runId: "run-1",
    observedAt: NOW,
    ...overrides,
  };
}

describe("AuditStore writes", () => {
  it("stores a page and names the sessions it touched", () => {
    const repo = repository();

    const result = repo.audit.append([
      toolEvent({ eventId: "a", sequence: 1 }),
      toolEvent({ eventId: "b", sequence: 2, sessionKey: "agent:main:two" }),
    ]);

    expect(result.inserted).toBe(2);
    expect(result.sessionKeys.sort()).toEqual(["agent:main:one", "agent:main:two"]);
  });

  /**
   * The tail read overlaps by design and a rewound watermark replays everything
   * already held, so re-storing a page has to be free rather than doubling the
   * failures a session is charged for.
   */
  it("ignores a record it already holds", () => {
    const repo = repository();
    repo.audit.append([toolEvent({ eventId: "a", sequence: 1 })]);

    const again = repo.audit.append([toolEvent({ eventId: "a", sequence: 1 }), toolEvent({ eventId: "b", sequence: 2 })]);

    expect(again.inserted).toBe(1);
    expect(repo.audit.totals().events).toBe(2);
  });

  it("reports no touched session for a record that names none", () => {
    const repo = repository();

    const result = repo.audit.append([toolEvent({ eventId: "a", sequence: 1, sessionKey: undefined })]);

    expect(result).toEqual({ inserted: 1, sessionKeys: [] });
  });

  it("records nothing for an empty page", () => {
    const repo = repository();

    expect(repo.audit.append([])).toEqual({ inserted: 0, sessionKeys: [] });
  });
});

describe("AuditStore verdicts", () => {
  it("returns settled tool calls oldest first", () => {
    const repo = repository();
    repo.audit.append([
      toolEvent({ eventId: "b", sequence: 2, status: "succeeded", occurredAt: NOW - 20_000, toolName: "deploy" }),
      toolEvent({ eventId: "a", sequence: 1, status: "failed", errorCode: "tool_failed", occurredAt: NOW - 30_000 }),
    ]);

    expect(repo.audit.toolVerdicts("agent:main:one")).toEqual([
      { toolName: "bash", failed: true, occurredAt: NOW - 30_000 },
      { toolName: "deploy", failed: false, occurredAt: NOW - 20_000 },
    ]);
  });

  /**
   * A tool that starts and ends inside the same millisecond has to stay in the
   * order it happened, or a failure and the retry that followed it read as a
   * retry that preceded its own failure.
   */
  it("breaks a tie on the Gateway's own insertion order", () => {
    const repo = repository();
    repo.audit.append([
      toolEvent({ eventId: "second", sequence: 9, status: "succeeded", occurredAt: NOW }),
      toolEvent({ eventId: "first", sequence: 8, status: "failed", occurredAt: NOW }),
    ]);

    expect(repo.audit.toolVerdicts("agent:main:one").map((verdict) => verdict.failed)).toEqual([true, false]);
  });

  it("leaves out a call that has only started", () => {
    const repo = repository();
    repo.audit.append([
      toolEvent({ eventId: "start", sequence: 1, status: "started", action: "tool.action.started" }),
    ]);

    expect(repo.audit.toolVerdicts("agent:main:one")).toEqual([]);
  });

  it("does not read a run record as a tool call", () => {
    const repo = repository();
    repo.audit.append([runEvent({ eventId: "run", sequence: 1, status: "failed" })]);

    expect(repo.audit.toolVerdicts("agent:main:one")).toEqual([]);
  });

  it("reports the newest run verdict, since that is the one that decided the session", () => {
    const repo = repository();
    repo.audit.append([
      runEvent({ eventId: "older", sequence: 1, status: "failed", occurredAt: NOW - 50_000 }),
      runEvent({ eventId: "newer", sequence: 2, status: "succeeded", occurredAt: NOW - 10_000 }),
    ]);

    expect(repo.audit.runVerdict("agent:main:one")).toEqual({ outcome: "succeeded", endedAt: NOW - 10_000 });
  });

  it("skips a run status it cannot map rather than calling it unknown", () => {
    const repo = repository();
    repo.audit.append([
      runEvent({ eventId: "newer", sequence: 2, status: "started", occurredAt: NOW - 10_000 }),
      runEvent({ eventId: "older", sequence: 1, status: "failed", occurredAt: NOW - 50_000 }),
    ]);

    expect(repo.audit.runVerdict("agent:main:one")).toEqual({ outcome: "failed", endedAt: NOW - 50_000 });
  });

  it("returns nothing for a session with no run records", () => {
    const repo = repository();

    expect(repo.audit.runVerdict("agent:main:ghost")).toBeUndefined();
  });
});

describe("AuditStore sync state", () => {
  it("keeps the contiguous read mark apart from the newest record held", () => {
    const repo = repository();
    repo.audit.append([toolEvent({ eventId: "a", sequence: 900 })]);

    expect(repo.audit.readNewestMark()).toBeUndefined();
    repo.audit.writeNewestMark(500);

    expect(repo.audit.readNewestMark()).toBe(500);
    expect(repo.audit.oldestSequence()).toBe(900);
  });

  it("reports where the backwards walk resumes from what is stored", () => {
    const repo = repository();
    repo.audit.append([toolEvent({ eventId: "a", sequence: 40 }), toolEvent({ eventId: "b", sequence: 12 })]);

    expect(repo.audit.oldestSequence()).toBe(12);
  });

  it("remembers that the walk finished, and forgets it on request", () => {
    const repo = repository();

    expect(repo.audit.readBackfillComplete()).toBe(false);
    repo.audit.writeBackfillComplete(true);
    expect(repo.audit.readBackfillComplete()).toBe(true);

    repo.audit.writeBackfillComplete(false);
    expect(repo.audit.readBackfillComplete()).toBe(false);
  });
});

describe("AuditStore retention", () => {
  it("deletes records older than the cutoff and keeps the rest", () => {
    const repo = repository();
    repo.audit.append([
      toolEvent({ eventId: "old", sequence: 1, occurredAt: NOW - 90_000 }),
      toolEvent({ eventId: "new", sequence: 2, occurredAt: NOW - 10_000 }),
    ]);

    expect(repo.audit.pruneOlderThan(NOW - 60_000)).toBe(1);
    expect(repo.audit.totals()).toEqual({ events: 1, newestSequence: 2, oldestOccurredAt: NOW - 10_000 });
  });

  it("reports empty totals for a store with nothing in it", () => {
    const repo = repository();

    expect(repo.audit.totals()).toEqual({ events: 0 });
  });
});
