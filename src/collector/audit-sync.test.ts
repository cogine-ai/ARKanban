import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "../storage/repository.js";
import { AUDIT_PAGE_LIMIT, AuditSynchronizer } from "./audit-sync.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = 1_800_000_000_000;

function repository(): CollectorRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-audit-sync-"));
  const repo = new CollectorRepository(path.join(directory, "collector.sqlite"));
  cleanups.push(() => {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return repo;
}

/** One page of records, newest first, as the Gateway returns them. */
function page(sequences: number[], nextCursor?: string): Record<string, unknown> {
  return {
    events: sequences.map((sequence) => ({
      eventId: `event-${sequence}`,
      sequence,
      occurredAt: NOW - sequence * 1_000,
      kind: "tool_action",
      action: "tool.action.finished",
      status: sequence % 2 === 0 ? "succeeded" : "failed",
      agentId: "main",
      sessionKey: "agent:main:one",
      runId: "run-1",
      toolName: "bash",
      redaction: "metadata_only",
    })),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

type Call = { cursor?: string; limit?: number };

/** Answers cursors from a fixed trail, the way the Gateway's own query does. */
function gateway(trail: number[], options: { pageSize?: number } = {}) {
  const pageSize = options.pageSize ?? 2;
  const calls: Call[] = [];
  const request = async (_method: string, params: Record<string, unknown>): Promise<unknown> => {
    const cursor = typeof params.cursor === "string" ? Number.parseInt(params.cursor, 10) : undefined;
    calls.push({
      ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    });
    const below = cursor === undefined ? trail : trail.filter((sequence) => sequence < cursor);
    const window = below.slice(0, pageSize);
    const remaining = below.length > window.length;
    return page(window, remaining ? String(window[window.length - 1]) : undefined);
  };
  return { calls, request };
}

describe("AuditSynchronizer gates", () => {
  it.each([
    ["not_connected", { connected: false, auditState: "live" as const }],
    ["unavailable", { connected: true, auditState: "unavailable" as const }],
    ["unauthorized", { connected: true, auditState: "unauthorized" as const }],
  ])("does not call the Gateway when %s", async (skipped, options) => {
    const repo = repository();
    const asked: string[] = [];
    const sync = new AuditSynchronizer({
      store: repo.audit,
      request: async (method) => {
        asked.push(method);
        return {};
      },
    });

    const outcome = await sync.runOnce({ now: NOW, ...options });

    expect(outcome.skipped).toBe(skipped);
    expect(asked).toEqual([]);
  });
});

describe("AuditSynchronizer first sync", () => {
  it("walks from the newest record down to the end of the trail", async () => {
    const repo = repository();
    const { request, calls } = gateway([9, 8, 7, 6]);
    const sync = new AuditSynchronizer({ store: repo.audit, request });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(outcome).toMatchObject({ inserted: 4, complete: true, caughtUp: true, newestSequence: 9 });
    expect(repo.audit.totals().events).toBe(4);
    expect(calls[0]).toEqual({ limit: AUDIT_PAGE_LIMIT });
    expect(repo.audit.readNewestMark()).toBe(9);
  });

  /**
   * The tail budget stops after two pages. What is left has to be walked by the
   * backfill phase in the same round, or the records below the tail would only be
   * reachable by re-reading the whole trail from the top.
   */
  it("hands the rest of the trail to the backwards walk when the tail budget runs out", async () => {
    const repo = repository();
    const { request, calls } = gateway([9, 8, 7, 6, 5, 4, 3, 2]);
    const sync = new AuditSynchronizer({ store: repo.audit, request });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(outcome.inserted).toBe(8);
    expect(outcome.complete).toBe(true);
    expect(calls).toHaveLength(4);
    // The third call resumes below the oldest record the tail stored, rather than
    // from the top again.
    expect(calls[2]?.cursor).toBe("6");
  });

  it("resumes the walk on the next round when a round runs out of pages", async () => {
    const repo = repository();
    const { request } = gateway([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
    const sync = new AuditSynchronizer({ store: repo.audit, request });

    const first = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });
    expect(first.complete).toBe(false);
    expect(repo.audit.oldestSequence()).toBe(13);

    const second = await sync.runOnce({ now: NOW + 1_000, connected: true, auditState: "live" });

    expect(second.complete).toBe(true);
    expect(repo.audit.totals().events).toBe(10);
  });
});

describe("AuditSynchronizer tail", () => {
  it("stops at the first record it already read", async () => {
    const repo = repository();
    const { request, calls } = gateway([5, 4, 3]);
    const sync = new AuditSynchronizer({ store: repo.audit, request });
    await sync.runOnce({ now: NOW, connected: true, auditState: "live" });
    const before = calls.length;

    const outcome = await sync.runOnce({ now: NOW + 1_000, connected: true, auditState: "live" });

    expect(outcome).toMatchObject({ inserted: 0, caughtUp: true });
    // One request: the newest page, recognised and not stored again.
    expect(calls.length - before).toBe(1);
  });

  it("stores only what arrived since the last round", async () => {
    const repo = repository();
    const trail = [5, 4, 3];
    const sync = new AuditSynchronizer({
      store: repo.audit,
      request: async (_method, params) => {
        const cursor = typeof params.cursor === "string" ? Number.parseInt(params.cursor, 10) : undefined;
        const below = cursor === undefined ? trail : trail.filter((sequence) => sequence < cursor);
        return page(below.slice(0, 2), below.length > 2 ? String(below[1]) : undefined);
      },
    });
    await sync.runOnce({ now: NOW, connected: true, auditState: "live" });
    trail.unshift(7, 6);

    const outcome = await sync.runOnce({ now: NOW + 1_000, connected: true, auditState: "live" });

    expect(outcome).toMatchObject({ inserted: 2, caughtUp: true, newestSequence: 7 });
    expect(repo.audit.totals().events).toBe(5);
  });

  /**
   * The Gateway prunes its own trail by age and by row count, and a reset state
   * database starts counting from one again. Undetected, the stop condition would
   * recognise every new record as one already seen, and collection would end
   * silently for as long as the collector stayed up.
   */
  it("detects a trail that restarted below what it had already read", async () => {
    const repo = repository();
    repo.audit.writeNewestMark(9_000);
    repo.audit.writeBackfillComplete(true);
    const { request } = gateway([3, 2, 1]);
    const sync = new AuditSynchronizer({ store: repo.audit, request });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(outcome.rewound).toBe(true);
    expect(outcome.inserted).toBe(3);
    expect(repo.audit.readNewestMark()).toBe(3);
  });

  /**
   * A round that stored the newest pages and ran out of budget has a gap beneath
   * them. Recording the top as read would stop the next round at page one and
   * nothing would ever ask for the gap again.
   */
  it("holds the read mark where it is when the tail never caught up", async () => {
    const repo = repository();
    repo.audit.writeNewestMark(10);
    repo.audit.writeBackfillComplete(true);
    const { request } = gateway([40, 39, 38, 37, 36, 35]);
    const sync = new AuditSynchronizer({ store: repo.audit, request });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(outcome.caughtUp).toBe(false);
    expect(repo.audit.readNewestMark()).toBe(10);
  });
});

/**
 * A record this build cannot read is not the end of the trail.
 *
 * The projector drops rows without an identity, and rows that do not promise
 * `metadata_only`. A page made entirely of those still carries the Gateway's
 * cursor, and treating its absence of writes as the bottom would set the flag
 * that stops the backwards walk for good — on a database that would then never
 * collect history again.
 */
describe("AuditSynchronizer unreadable pages", () => {
  function unreadable(nextCursor: string): Record<string, unknown> {
    return {
      events: [{ eventId: "leaked", sequence: 90, occurredAt: NOW, kind: "tool_action", status: "failed", redaction: "full" }],
      nextCursor,
    };
  }

  it("keeps walking past a page it could read nothing on", async () => {
    const repo = repository();
    const asked: Array<string | undefined> = [];
    const sync = new AuditSynchronizer({
      store: repo.audit,
      request: async (_method, params) => {
        const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
        asked.push(cursor);
        if (cursor === undefined) return unreadable("90");
        return page([80, 79]);
      },
    });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(asked).toEqual([undefined, "90"]);
    expect(outcome.inserted).toBe(2);
  });

  it("does not report the trail finished because a page was unreadable", async () => {
    const repo = repository();
    repo.audit.append([
      {
        eventId: "known",
        sequence: 100,
        occurredAt: NOW - 1_000,
        kind: "tool_action",
        status: "succeeded",
        sessionKey: "agent:main:one",
        observedAt: NOW,
      },
    ]);
    repo.audit.writeNewestMark(100);
    const sync = new AuditSynchronizer({ store: repo.audit, request: async () => unreadable("99") });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(outcome.complete).toBe(false);
    expect(repo.audit.readBackfillComplete()).toBe(false);
  });
});

describe("AuditSynchronizer failures", () => {
  it("reports a closed-set code and keeps what it had already stored", async () => {
    const repo = repository();
    let calls = 0;
    const sync = new AuditSynchronizer({
      store: repo.audit,
      request: async () => {
        calls += 1;
        if (calls === 1) return page([9, 8], "8");
        throw new Error("ETIMEDOUT: request timed out");
      },
    });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(outcome).toMatchObject({ inserted: 2, errorCode: "timeout", complete: false });
    expect(repo.audit.totals().events).toBe(2);
  });

  it("does not mark the walk finished when the walk itself failed", async () => {
    const repo = repository();
    let calls = 0;
    const sync = new AuditSynchronizer({
      store: repo.audit,
      request: async () => {
        calls += 1;
        if (calls <= 2) return page([9 - calls], String(8 - calls));
        throw new Error("boom");
      },
    });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(outcome.complete).toBe(false);
    expect(repo.audit.readBackfillComplete()).toBe(false);
    expect(outcome.errorCode).toBe("error");
  });

  it("names the sessions that gained verdicts, and survives a listener that throws", async () => {
    const repo = repository();
    const announced: string[][] = [];
    const { request } = gateway([2, 1]);
    const sync = new AuditSynchronizer({
      store: repo.audit,
      request,
      onRecorded: (sessionKeys) => {
        announced.push([...sessionKeys]);
        throw new Error("listener failed");
      },
    });

    const outcome = await sync.runOnce({ now: NOW, connected: true, auditState: "live" });

    expect(announced).toEqual([["agent:main:one"]]);
    expect(outcome.inserted).toBe(2);
    expect(outcome.errorCode).toBeUndefined();
  });
});
