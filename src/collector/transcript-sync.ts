import { projectHistoryPage } from "../activity/message-projector.js";
import type { FieldInventory } from "./field-inventory.js";
import type { MessageWrite, TranscriptArchive, TranscriptCandidate } from "../storage/transcript-archive.js";

/**
 * Incremental transcript sync.
 *
 * Pull-based by design: `sessions.messages.subscribe` stays forbidden because
 * declaring it flips the Gateway's public `agent` fanout into per-session
 * subscriptions and breaks Live Flow's event coverage. The local copy therefore
 * lags, which is why every read surfaces a watermark instead of claiming to be
 * live.
 */

export const TRANSCRIPT_SYNC_MS = 30_000;
/** A session touched this recently is treated as still producing messages. */
export const ACTIVE_WINDOW_MS = 15 * 60_000;
/** Ceiling per round, so transcript sync cannot crowd out the Task/Session quota. */
export const ROUND_REQUEST_BUDGET = 20;
export const BACKFILL_SESSION_BUDGET = 5;
export const HISTORY_PAGE_LIMIT = 200;
/** dbstat walks every page, so the authoritative measure is taken sparingly. */
export const USAGE_MEASURE_MS = 5 * 60_000;

export type HistoryRequest = (method: string, params: unknown) => Promise<unknown>;

/**
 * Turns the stored continuation token into `chat.history` paging params.
 *
 * The method pages by `offset` counted back from the newest message, and it
 * rejects unknown params, so the `cursor` this code used to send was refused
 * outright. The archive column stays named `cursor` because it is opaque there;
 * only this function knows it holds a decimal offset. An absent or unparseable
 * token means start at the newest page, which is also the right behaviour for
 * the incremental case: the tail is what a live conversation needs.
 */
function continuationParams(cursor: string | undefined): { offset?: number } {
  if (cursor === undefined) return {};
  const offset = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(offset) && offset > 0 ? { offset } : {};
}

export type TranscriptSyncOutcome = {
  requests: number;
  inserted: number;
  sessions: number;
  /** `paused` means capacity stopped backfill; active increments continue. */
  capacity: "ok" | "paused";
  evictedSessions: number;
  skipped?: "disabled" | "unavailable" | "primary_sync_failed" | "not_connected";
  errorCode?: string;
};

export type TranscriptSyncDeps = {
  archive: TranscriptArchive;
  request: HistoryRequest;
  maxBytes: number;
  enabled: boolean;
  inventory?: FieldInventory;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Failure codes are a closed set and carry no transcript text, because sync
 * failures are logged and invariant 2 keeps message content out of logs
 * entirely — including at debug level.
 */
export function classifyHistoryFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("method_not_found") || message.includes("unknown method")) return "unavailable";
  if (message.includes("unauthorized") || message.includes("forbidden") || message.includes("scope")) {
    return "unauthorized";
  }
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  return "error";
}

export class TranscriptSynchronizer {
  private storedBytes = 0;
  private measuredAt = 0;

  constructor(private readonly deps: TranscriptSyncDeps) {}

  /**
   * One sync round.
   *
   * `primaryHealthy` gates the whole round rather than individual sessions:
   * transcripts are a secondary goal and must never compete with Live Flow for
   * Gateway attention while the primary sync is already struggling.
   */
  async runOnce(options: { now: number; connected: boolean; available: boolean; primaryHealthy: boolean }): Promise<TranscriptSyncOutcome> {
    const idle: TranscriptSyncOutcome = { requests: 0, inserted: 0, sessions: 0, capacity: "ok", evictedSessions: 0 };
    if (!this.deps.enabled) return { ...idle, skipped: "disabled" };
    if (!options.connected) return { ...idle, skipped: "not_connected" };
    if (!options.available) return { ...idle, skipped: "unavailable" };
    if (!options.primaryHealthy) return { ...idle, skipped: "primary_sync_failed" };

    const capacity = this.capacityState(options.now);
    let evictedSessions = 0;
    if (capacity === "paused") {
      evictedSessions = this.deps.archive.evictOldestSessions(this.deps.maxBytes).sessions;
      if (evictedSessions > 0) this.measure(options.now);
    }

    let requests = 0;
    let inserted = 0;
    const touched = new Set<string>();
    let errorCode: string | undefined;

    const active = this.deps.archive.activeCandidates({
      now: options.now,
      withinMs: ACTIVE_WINDOW_MS,
      limit: ROUND_REQUEST_BUDGET,
    });
    for (const candidate of active) {
      if (requests >= ROUND_REQUEST_BUDGET) break;
      const result = await this.syncSession(candidate, options.now, "tail");
      requests += result.requests;
      inserted += result.inserted;
      touched.add(candidate.sessionKey);
      errorCode ??= result.errorCode;
    }

    // Backfill is what capacity pressure gives up: growing the archive backwards
    // is optional, whereas losing the tail of a live conversation is a hole that
    // never gets filled.
    //
    // Sessions read above are not excluded. A tail read and a backfill page are
    // different requests now, and excluding them meant a session that stayed busy
    // never walked its own history — it was always in the active set, so it was
    // always skipped here.
    if (capacity === "ok") {
      const backfill = this.deps.archive.backfillCandidates({ limit: BACKFILL_SESSION_BUDGET });
      for (const candidate of backfill) {
        if (requests >= ROUND_REQUEST_BUDGET) break;
        const result = await this.syncSession(candidate, options.now, "backfill");
        requests += result.requests;
        inserted += result.inserted;
        touched.add(candidate.sessionKey);
        errorCode ??= result.errorCode;
      }
    }

    return {
      requests,
      inserted,
      sessions: touched.size,
      capacity,
      evictedSessions,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  /** Bytes as last measured, for status reporting. */
  get archiveBytes(): number {
    return this.storedBytes;
  }

  private capacityState(now: number): "ok" | "paused" {
    if (this.measuredAt === 0 || now - this.measuredAt >= USAGE_MEASURE_MS) this.measure(now);
    return this.storedBytes >= this.deps.maxBytes ? "paused" : "ok";
  }

  private measure(now: number): void {
    this.storedBytes = this.deps.archive.usage().storedBytes;
    this.measuredAt = now;
  }

  /**
   * Pulls one page per call rather than draining a session's history in a single
   * round. A long backfill therefore progresses across rounds instead of
   * monopolising the request budget.
   *
   * `tail` reads the newest page and `backfill` follows the stored offset
   * backwards. Keeping them apart is what makes a live conversation's newest
   * messages arrive on the next round: while the two shared one path, an active
   * session with a backfill in progress spent its request on a page it had
   * already read, and the tail only appeared once the whole history had been
   * walked — a session with fifty pages of history refreshed every 25 minutes.
   */
  private async syncSession(
    candidate: TranscriptCandidate,
    now: number,
    mode: "tail" | "backfill",
  ): Promise<{ requests: number; inserted: number; errorCode?: string }> {
    const offset = mode === "backfill" ? (continuationParams(candidate.cursor).offset ?? 0) : 0;
    let payload: Record<string, unknown>;
    try {
      payload = record(
        await this.deps.request("chat.history", {
          sessionKey: candidate.sessionKey,
          limit: HISTORY_PAGE_LIMIT,
          ...(offset > 0 ? { offset } : {}),
        }),
      );
    } catch (error) {
      const errorCode = classifyHistoryFailure(error);
      this.deps.archive.recordSync({
        sessionKey: candidate.sessionKey,
        complete: candidate.complete,
        syncedAt: now,
        errorCode,
      });
      return { requests: 1, inserted: 0, errorCode };
    }

    const page = projectHistoryPage(payload, {
      sessionKey: candidate.sessionKey,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      observedAt: now,
      seqBase: candidate.lastSeq ?? -1,
      request: { limit: HISTORY_PAGE_LIMIT, offset },
      ...(this.deps.inventory ? { inventory: this.deps.inventory } : {}),
    });

    const writes = this.withoutKnown(candidate.sessionKey, page.writes);
    const { inserted } = this.deps.archive.append(writes);
    this.storedBytes += writes.reduce((total, write) => total + Buffer.byteLength(write.content, "utf8"), 0);

    // Backfill pages walk backwards, so their sequence numbers sit below the
    // watermark. Reporting this page's own maximum would move the watermark down,
    // and the next round would synthesise numbers for unnumbered rows starting
    // from there — colliding with rows already stored, which the idempotency key
    // then discards as duplicates. The watermark only rises.
    const lastSeq = writes.reduce(
      (highest, write) => (highest === undefined ? write.seq : Math.max(highest, write.seq)),
      candidate.lastSeq,
    );
    this.deps.archive.recordSync({
      sessionKey: candidate.sessionKey,
      // A page with no next offset is the end of this session's history, so the
      // token is cleared rather than left pointing at a page already read. Keeping
      // it would send every later round back to that same offset, and the tail a
      // live conversation keeps adding would never be fetched.
      //
      // A tail read has no such offset to report, and "there are older messages"
      // seen from the newest page is not the claim that backfill is unfinished —
      // writing either would undo the progress backfill has made. It does seed
      // the token when nothing has walked this session yet, so backfill starts on
      // the page below the tail instead of re-reading the one just fetched.
      ...(mode === "backfill"
        ? { cursor: page.nextOffset !== undefined ? String(page.nextOffset) : null }
        : candidate.cursor === undefined && !candidate.complete && page.nextOffset !== undefined
          ? { cursor: String(page.nextOffset) }
          : {}),
      ...(lastSeq !== undefined ? { lastSeq } : {}),
      // A tail read that found no older page has, by that fact, seen the whole
      // history: it started at the newest message and the Gateway reported
      // nothing beyond it.
      complete: mode === "backfill" ? !page.hasMore : candidate.complete || !page.hasMore,
      syncedAt: now,
    });
    return { requests: 1, inserted };
  }

  private withoutKnown(sessionKey: string, writes: MessageWrite[]): MessageWrite[] {
    const ids = writes.map((write) => write.messageId).filter((id): id is string => id !== undefined);
    if (ids.length === 0) return writes;
    const known = this.deps.archive.knownMessageIds(sessionKey, ids);
    return known.size === 0 ? writes : writes.filter((write) => !write.messageId || !known.has(write.messageId));
  }
}
