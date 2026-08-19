import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "../storage/repository.js";
import {
  BACKFILL_SESSION_BUDGET,
  ROUND_REQUEST_BUDGET,
  TRANSCRIPT_SYNC_MS,
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

const PAGE = 2;

/**
 * Serves a fixed transcript, one page per call, recording every request.
 *
 * Pages the way `chat.history` does: `offset` counts back from the *newest*
 * message, so no offset returns the tail and each `nextOffset` walks further into
 * the past. Fixtures are ordered oldest-first, as a transcript reads.
 */
function gateway(pages: Record<string, Array<Record<string, unknown>>>): {
  request: HistoryRequest;
  calls: Array<{ sessionKey: string; offset?: number }>;
} {
  const calls: Array<{ sessionKey: string; offset?: number }> = [];
  const request: HistoryRequest = async (_method, params) => {
    const { sessionKey, offset } = params as { sessionKey: string; offset?: number };
    calls.push({ sessionKey, ...(offset === undefined ? {} : { offset }) });
    const messages = pages[sessionKey] ?? [];
    const skipped = offset ?? 0;
    const end = Math.max(0, messages.length - skipped);
    const start = Math.max(0, end - PAGE);
    const page = messages.slice(start, end);
    const next = skipped + page.length;
    const hasMore = next < messages.length;
    return { messages: page, hasMore, ...(hasMore ? { nextOffset: next } : {}) };
  };
  return { request, calls };
}

/** The envelope shape `chat.history` returns: metadata under `__openclaw`. */
function turn(seq: number): Record<string, unknown> {
  return {
    role: "user",
    content: `message ${seq}`,
    timestamp: NOW - 1_000 + seq,
    __openclaw: { id: `m${seq}`, seq },
  };
}

function synchronizer(
  repo: CollectorRepository,
  request: HistoryRequest,
  overrides: {
    maxBytes?: number;
    enabled?: boolean;
    onArchived?: (sessionKeys: readonly string[]) => void;
  } = {},
): TranscriptSynchronizer {
  return new TranscriptSynchronizer({
    archive: repo.transcripts,
    request,
    maxBytes: overrides.maxBytes ?? 64 * 1024 * 1024,
    enabled: overrides.enabled ?? true,
    ...(overrides.onArchived ? { onArchived: overrides.onArchived } : {}),
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
  it("stores an active session's newest page and walks the rest of its history", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request, calls } = gateway({ "agent:builder:one": [turn(0), turn(1), turn(2)] });
    const sync = synchronizer(repo, request);

    // One round: the tail first, then the page below it. A live conversation gets
    // its newest messages without waiting for its history to be walked.
    const first = await sync.runOnce(healthy);
    expect(first.inserted).toBe(3);
    expect(calls).toEqual([{ sessionKey: "agent:builder:one" }, { sessionKey: "agent:builder:one", offset: 2 }]);
    expect(repo.transcripts.syncState("agent:builder:one")).toMatchObject({ syncedCount: 3, complete: true });

    const second = await sync.runOnce(healthy);
    expect(second.inserted).toBe(0);
  });

  /**
   * Archived tool results are evidence for a session's grade, and the sessions a
   * round added to are the only way anything downstream can hear about it: a
   * backfill page does not move `last_activity_at`, so a staleness check on the
   * session row alone would never rescore on it.
   */
  it("names the sessions a round added to, and stays quiet about the ones it only re-read", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const archived: string[][] = [];
    const { request } = gateway({ "agent:builder:one": [turn(0), turn(1)] });
    const sync = synchronizer(repo, request, { onArchived: (keys) => archived.push([...keys]) });

    await sync.runOnce(healthy);
    expect(archived).toEqual([["agent:builder:one"]]);

    // Nothing new landed on the replay, so there is nothing to rescore.
    await sync.runOnce(healthy);
    expect(archived).toHaveLength(1);
  });

  it("keeps the round's pages when the listener throws", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request } = gateway({ "agent:builder:one": [turn(0)] });
    const sync = synchronizer(repo, request, {
      onArchived: () => {
        throw new Error("rescore failed");
      },
    });

    const outcome = await sync.runOnce(healthy);

    expect(outcome.inserted).toBe(1);
    expect(outcome.errorCode).toBeUndefined();
  });

  /**
   * The whole point of separating the two reads. While they shared a path, an
   * active session with a backfill in progress spent its one request per round on
   * a page it had already read, and the newest messages only arrived once the
   * entire history had been walked — minutes, for a long conversation.
   */
  it("reads the tail of a busy session every round, mid-backfill", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const history = Array.from({ length: 9 }, (_, index) => turn(index));
    const { request, calls } = gateway({ "agent:builder:one": history });
    const sync = synchronizer(repo, request);

    await sync.runOnce(healthy);
    await sync.runOnce(healthy);

    // Every round opens with a tail read, and backfill advances underneath it.
    expect(calls.filter((call) => call.offset === undefined)).toHaveLength(2);
    expect(calls.map((call) => call.offset)).toEqual([undefined, 2, undefined, 4]);
    expect(repo.transcripts.syncState("agent:builder:one")).toMatchObject({ complete: false });
  });

  /**
   * The end of a session's history is not the end of the session. Once the stored
   * offset had nothing to advance to, it used to stay pointing at the page already
   * read, and every later round re-requested that offset — so an active
   * conversation's newest messages were never fetched again.
   */
  it("keeps reading the newest page once a session's history runs out", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request, calls } = gateway({ "agent:builder:one": [turn(0), turn(1), turn(2)] });
    const sync = synchronizer(repo, request);

    await sync.runOnce(healthy);
    expect(repo.transcripts.syncState("agent:builder:one")).toMatchObject({ syncedCount: 3, complete: true });

    await sync.runOnce(healthy);
    expect(calls.at(-1)).toEqual({ sessionKey: "agent:builder:one" });
  });

  /**
   * `chat.history` counts its offset back from the newest message, so page two
   * holds *older* turns with lower sequence numbers than page one. The watermark
   * used to be set from whatever the current page happened to contain, which sent
   * it backwards as soon as backfill started.
   */
  it("does not lower the sequence watermark when backfill reaches an older page", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const request: HistoryRequest = async (_method, params) => {
      const { offset } = params as { offset?: number };
      return offset === undefined
        ? { messages: [turn(300), turn(301)], hasMore: true, nextOffset: 2 }
        : { messages: [turn(100), turn(101)], hasMore: false };
    };
    const sync = synchronizer(repo, request);

    await sync.runOnce(healthy);
    expect(repo.transcripts.activeCandidates({ now: NOW, withinMs: 60_000, limit: 5 })[0]?.lastSeq).toBe(301);

    await sync.runOnce(healthy);
    expect(repo.transcripts.activeCandidates({ now: NOW, withinMs: 60_000, limit: 5 })[0]?.lastSeq).toBe(301);
  });

  /**
   * What the regression above actually costs. Sequence numbers for rows the
   * Gateway did not number are counted from the watermark, so a watermark that
   * has moved back hands out numbers already in the table — and the idempotency
   * key drops those rows as duplicates of messages they have nothing to do with.
   */
  it("keeps an unnumbered message that arrives after a backfill page", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    let served = 0;
    const request: HistoryRequest = async () => {
      served += 1;
      // The tail, then the page below it, then a tail read that finds a new turn
      // the Gateway did not number.
      if (served === 1) return { messages: [turn(52), turn(53)], hasMore: true, nextOffset: 2 };
      if (served === 2) return { messages: [turn(50), turn(51)], hasMore: false };
      return { messages: [{ id: "fresh", role: "user", content: "the newest turn" }], hasMore: false };
    };
    const sync = synchronizer(repo, request);

    await sync.runOnce(healthy);
    const second = await sync.runOnce(healthy);

    expect(second.inserted).toBe(1);
    expect(repo.transcripts.listMessages("agent:builder:one").map((message) => message.content)).toContain(
      "the newest turn",
    );
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

  /**
   * A session that stays busy is always in the active set, and while that also
   * excluded it from backfill it could never walk its own history: the older half
   * of a conversation someone is actively having was unreachable.
   */
  it("backfills a session the active pass has already read", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const { request, calls } = gateway({
      "agent:builder:one": Array.from({ length: 5 }, (_, index) => turn(index)),
    });

    await synchronizer(repo, request).runOnce(healthy);

    expect(calls).toEqual([{ sessionKey: "agent:builder:one" }, { sessionKey: "agent:builder:one", offset: 2 }]);
  });
});

/** Fills a session's archive directly, to put the store over a ceiling. */
function padArchive(repo: CollectorRepository, sessionKey: string, count = 40): void {
  repo.transcripts.append(
    Array.from({ length: count }, (_unused, index) => ({
      sessionKey,
      seq: index,
      role: "assistant" as const,
      content: `padding ${"x".repeat(500)} ${index}`,
      createdAt: NOW - 100_000 + index,
      observedAt: NOW - 100_000 + index,
    })),
  );
}

describe("transcript sync capacity", () => {
  it("keeps active increments but stops backfill once the ceiling is reached", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:live", { lastActivityAt: NOW });
    seedSession(repo, "agent:builder:cold", { active: false, lastActivityAt: NOW - 60 * 60_000 });
    padArchive(repo, "agent:builder:live");
    padArchive(repo, "agent:builder:cold");
    const { request, calls } = gateway({
      "agent:builder:live": [turn(0), turn(1), turn(2)],
      "agent:builder:cold": [turn(0), turn(1), turn(2)],
    });
    // Tight enough to be over budget, loose enough that dropping the cold session
    // gets back under it — measured, not estimated: two equal sessions here keep
    // 68% of their pages after one of them goes, because index and FTS pages do
    // not shrink in step with the text they cover.
    const sync = synchronizer(repo, request, { maxBytes: Math.floor(repo.transcripts.usage().storedBytes * 0.8) });

    const outcome = await sync.runOnce(healthy);

    expect(outcome.capacity).toBe("paused");
    expect(outcome.evictedSessions).toBe(1);
    // The live session keeps receiving its tail; only backfill was given up.
    expect(calls).toEqual([{ sessionKey: "agent:builder:live" }]);
  });

  /**
   * The end of a full archive, stated rather than worked around. Every session
   * left is too recent to evict, so continuing to pull would push further over a
   * ceiling nothing can bring it back under — and the only way to make room would
   * be to tear up a conversation still being written to.
   */
  it("stops archiving and says so when everything left is too recent to evict", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:live", { lastActivityAt: NOW });
    padArchive(repo, "agent:builder:live");
    const { request, calls } = gateway({ "agent:builder:live": [turn(0), turn(1), turn(2)] });
    const sync = synchronizer(repo, request, { maxBytes: Math.floor(repo.transcripts.usage().storedBytes * 0.5) });

    const outcome = await sync.runOnce(healthy);

    expect(outcome).toMatchObject({ capacity: "full", requests: 0, inserted: 0, evictedSessions: 0 });
    expect(calls).toEqual([]);
    expect(repo.transcripts.listMessages("agent:builder:live")).toHaveLength(40);
  });

  /**
   * The budget is in page bytes — the space the archive actually occupies once its
   * indexes and FTS shadow tables are counted. A round only knows the UTF-8 length
   * of what it wrote, so adding that raw would let the estimate climb at a
   * fraction of the real rate and sail past the ceiling unnoticed.
   */
  it("counts a round's writes at the archive's real cost per byte of text", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:live", { lastActivityAt: NOW });
    padArchive(repo, "agent:builder:live");
    const measured = repo.transcripts.usage();
    const overhead = measured.storedBytes / measured.contentBytes;
    expect(overhead).toBeGreaterThan(1);

    // Sequence numbers above the padding, which already occupies 0-39: the archive
    // treats a repeated number in the same session as the same message.
    const { request } = gateway({ "agent:builder:live": [turn(100), turn(101)] });
    const sync = synchronizer(repo, request, { maxBytes: 512 * 1024 * 1024 });
    await sync.runOnce(healthy);

    const written = repo.transcripts.usage().contentBytes - measured.contentBytes;
    expect(written).toBeGreaterThan(0);
    expect(sync.archiveBytes).toBe(measured.storedBytes + Math.round(written * overhead));
  });

  /**
   * A tail read asks for the newest page every round, so the same messages come
   * back over and over. `withoutKnown` filters them only when the Gateway gives a
   * message an id; otherwise the idempotency key drops them at the insert and the
   * file does not grow. Charging the estimate for those writes anyway made an idle
   * session climb towards the ceiling on text that was already stored, until the
   * archive started evicting transcripts to make room for nothing.
   */
  it("does not charge the estimate for a page it already had", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:live", { lastActivityAt: NOW });
    // Numbered but not identified, which is what makes the duplicates reach the
    // insert instead of being filtered before it.
    const unidentified = (seq: number) => ({
      role: "user",
      content: `message ${seq}`,
      timestamp: NOW - 1_000 + seq,
      __openclaw: { seq },
    });
    const { request } = gateway({ "agent:builder:live": [unidentified(0), unidentified(1)] });
    const sync = synchronizer(repo, request);

    const first = await sync.runOnce(healthy);
    const afterFirst = sync.archiveBytes;
    const second = await sync.runOnce({ ...healthy, now: NOW + TRANSCRIPT_SYNC_MS });

    expect(first.inserted).toBe(2);
    expect(afterFirst).toBeGreaterThan(0);
    expect(second.inserted).toBe(0);
    expect(sync.archiveBytes).toBe(afterFirst);
  });

  /**
   * Retention deletes rows the synchronizer never hears about, and its estimate
   * only ever grows. Left uncorrected it reads as over budget and starts evicting
   * transcripts that are no longer there.
   */
  it("re-measures after a prune instead of trusting a stale estimate", async () => {
    const repo = repository();
    seedSession(repo, "agent:builder:live", { lastActivityAt: NOW });
    padArchive(repo, "agent:builder:live");
    // An empty history, so the rounds below only move the estimate by measuring.
    const { request } = gateway({});
    const sync = synchronizer(repo, request, { maxBytes: 512 * 1024 * 1024 });
    await sync.runOnce(healthy);
    const beforePrune = sync.archiveBytes;
    expect(beforePrune).toBeGreaterThan(0);

    repo.transcripts.pruneOlderThan(NOW);
    sync.markUsageStale();
    await sync.runOnce(healthy);

    expect(sync.archiveBytes).toBeLessThan(beforePrune);
    expect(sync.archiveBytes).toBe(repo.transcripts.usage().storedBytes);
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
