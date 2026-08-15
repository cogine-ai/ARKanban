import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "../storage/repository.js";
import {
  BACKFILL_SESSION_BUDGET,
  ROUND_REQUEST_BUDGET,
  TranscriptSynchronizer,
  classifyHistoryFailure,
  type HistoryRequest,
} from "./transcript-sync.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = 1_000_000_000;

function repository(): CollectorRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-sync-"));
  const result = new CollectorRepository(path.join(directory, "collector.sqlite"));
  cleanups.push(() => {
    result.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return result;
}

function seedSession(
  repo: CollectorRepository,
  sessionKey: string,
  options: { active?: boolean; lastActivityAt?: number } = {},
): void {
  repo.upsertSessions([
    {
      sessionKey,
      agentId: "builder",
      label: sessionKey,
      kindHint: "main",
      archived: false,
      hasActiveRun: options.active ?? true,
      lineage: {},
      lastActivityAt: options.lastActivityAt ?? NOW,
      observedAt: NOW,
      coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "live" },
    },
  ]);
}

/** Serves a fixed transcript, one page per call, recording every request. */
function gateway(pages: Record<string, Array<Record<string, unknown>>>): {
  request: HistoryRequest;
  calls: string[];
} {
  const calls: string[] = [];
  const request: HistoryRequest = async (_method, params) => {
    const { sessionKey, cursor } = params as { sessionKey: string; cursor?: string };
    calls.push(sessionKey);
    const messages = pages[sessionKey] ?? [];
    const offset = Number(cursor ?? 0);
    const page = messages.slice(offset, offset + 2);
    const next = offset + page.length;
    return { messages: page, hasMore: next < messages.length, ...(next < messages.length ? { nextCursor: String(next) } : {}) };
  };
  return { request, calls };
}

function turn(seq: number): Record<string, unknown> {
  return { id: `m${seq}`, seq, role: "user", content: `message ${seq}`, createdAt: NOW - 1_000 + seq };
}

function synchronizer(
  repo: CollectorRepository,
  request: HistoryRequest,
  overrides: { maxBytes?: number; enabled?: boolean } = {},
): TranscriptSynchronizer {
  return new TranscriptSynchronizer({
    archive: repo.transcripts,
    request,
    maxBytes: overrides.maxBytes ?? 64 * 1024 * 1024,
    enabled: overrides.enabled ?? true,
  });
}

const healthy = { now: NOW, connected: true, available: true, primaryHealthy: true };

describe("transcript sync gating", () => {
  it("skips the whole round when the primary sync is unhealthy", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request, calls } = gateway({ "agent:builder:one": [turn(0)] });

    const outcome = await synchronizer(repo, request).runOnce({ ...healthy, primaryHealthy: false });

    expect(outcome.skipped).toBe("primary_sync_failed");
    expect(calls).toEqual([]);
  });

  it("does nothing when transcript sync is switched off", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request, calls } = gateway({ "agent:builder:one": [turn(0)] });

    const outcome = await synchronizer(repo, request, { enabled: false }).runOnce(healthy);

    expect(outcome.skipped).toBe("disabled");
    expect(calls).toEqual([]);
  });

  it("does nothing when the Gateway does not advertise chat.history", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request, calls } = gateway({ "agent:builder:one": [turn(0)] });

    const outcome = await synchronizer(repo, request).runOnce({ ...healthy, available: false });

    expect(outcome.skipped).toBe("unavailable");
    expect(calls).toEqual([]);
  });
});

describe("transcript sync progress", () => {
  it("stores an active session's messages and remembers the cursor", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request } = gateway({ "agent:builder:one": [turn(0), turn(1), turn(2)] });
    const sync = synchronizer(repo, request);

    const first = await sync.runOnce(healthy);
    expect(first.inserted).toBe(2);
    expect(repo.transcripts.syncState("agent:builder:one")).toMatchObject({ syncedCount: 2, complete: false });

    // The second round resumes from the stored cursor rather than page one.
    const second = await sync.runOnce(healthy);
    expect(second.inserted).toBe(1);
    expect(repo.transcripts.syncState("agent:builder:one")).toMatchObject({ syncedCount: 3, complete: true });
  });

  it("re-pulling an already stored page inserts nothing", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    // Always serves page one, as a Gateway ignoring the cursor would.
    const request: HistoryRequest = async () => ({ messages: [turn(0), turn(1)], hasMore: false });
    const sync = synchronizer(repo, request);

    await sync.runOnce(healthy);
    const repeat = await sync.runOnce(healthy);

    expect(repeat.inserted).toBe(0);
    expect(repo.transcripts.listMessages("agent:builder:one")).toHaveLength(2);
  });

  it("stays idempotent when the Gateway numbers nothing, using message ids", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const request: HistoryRequest = async () => ({
      messages: [
        { id: "a", role: "user", content: "one" },
        { id: "b", role: "assistant", content: "two" },
      ],
      hasMore: false,
    });
    const sync = synchronizer(repo, request);

    await sync.runOnce(healthy);
    await sync.runOnce(healthy);

    expect(repo.transcripts.listMessages("agent:builder:one")).toHaveLength(2);
  });

  it("records a closed-set error code and keeps the session's stored text", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const request: HistoryRequest = async () => {
      throw new Error("unauthorized: operator.read required");
    };

    const outcome = await synchronizer(repo, request).runOnce(healthy);

    expect(outcome.errorCode).toBe("unauthorized");
    expect(repo.transcripts.syncState("agent:builder:one")).toMatchObject({ errorCode: "unauthorized" });
  });
});

describe("transcript sync budgets", () => {
  it("never spends more than the per-round request budget", async () => {
    const repo = repository();
    const pages: Record<string, Array<Record<string, unknown>>> = {};
    for (let index = 0; index < ROUND_REQUEST_BUDGET + 10; index += 1) {
      const key = `agent:builder:live-${index}`;
      seedSession(repo, key, { lastActivityAt: NOW - index });
      pages[key] = [turn(0)];
    }
    const { request, calls } = gateway(pages);

    const outcome = await synchronizer(repo, request).runOnce(healthy);

    expect(calls.length).toBeLessThanOrEqual(ROUND_REQUEST_BUDGET);
    expect(outcome.requests).toBeLessThanOrEqual(ROUND_REQUEST_BUDGET);
  });

  it("limits how many idle sessions are backfilled in one round", async () => {
    const repo = repository();
    const pages: Record<string, Array<Record<string, unknown>>> = {};
    for (let index = 0; index < BACKFILL_SESSION_BUDGET + 4; index += 1) {
      const key = `agent:builder:idle-${index}`;
      // Older than the active window and not running, so only backfill can reach it.
      seedSession(repo, key, { active: false, lastActivityAt: NOW - 60 * 60_000 - index });
      pages[key] = [turn(0), turn(1), turn(2)];
    }
    const { request, calls } = gateway(pages);

    await synchronizer(repo, request).runOnce(healthy);

    expect(calls).toHaveLength(BACKFILL_SESSION_BUDGET);
  });

  it("does not spend backfill quota on a session the active pass already pulled", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request, calls } = gateway({ "agent:builder:one": [turn(0), turn(1), turn(2)] });

    await synchronizer(repo, request).runOnce(healthy);

    expect(calls).toEqual(["agent:builder:one"]);
  });
});

describe("transcript sync capacity", () => {
  it("keeps active increments but stops backfill once the ceiling is reached", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:live", { lastActivityAt: NOW });
    seedSession(repo, "agent:builder:old", { active: false, lastActivityAt: NOW - 60 * 60_000 });
    const { request, calls } = gateway({
      "agent:builder:live": [turn(0), turn(1), turn(2)],
      "agent:builder:old": [turn(0), turn(1), turn(2)],
    });
    // Any stored page exceeds a one-byte ceiling, so the first round already
    // reports pressure rather than needing a large fixture to build up.
    const sync = synchronizer(repo, request, { maxBytes: 1 });

    await sync.runOnce(healthy);
    const outcome = await sync.runOnce(healthy);

    expect(outcome.capacity).toBe("paused");
    expect(calls).not.toContain("agent:builder:old");
  });
});

describe("history failure classification", () => {
  it("separates the outcomes that mean different things to an operator", () => {
    expect(classifyHistoryFailure(new Error("METHOD_NOT_FOUND: chat.history"))).toBe("unavailable");
    expect(classifyHistoryFailure(new Error("forbidden: scope missing"))).toBe("unauthorized");
    expect(classifyHistoryFailure(new Error("request timed out"))).toBe("timeout");
    expect(classifyHistoryFailure(new Error("socket closed"))).toBe("error");
  });
});
