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
      const result = await this.syncSession(candidate, options.now);
      requests += result.requests;
      inserted += result.inserted;
      touched.add(candidate.sessionKey);
      errorCode ??= result.errorCode;
    }

    // Backfill is what capacity pressure gives up: growing the archive backwards
    // is optional, whereas losing the tail of a live conversation is a hole that
    // never gets filled.
    if (capacity === "ok") {
      const backfill = this.deps.archive.backfillCandidates({ limit: BACKFILL_SESSION_BUDGET, exclude: touched });
      for (const candidate of backfill) {
        if (requests >= ROUND_REQUEST_BUDGET) break;
        const result = await this.syncSession(candidate, options.now);
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
   */
  private async syncSession(
    candidate: TranscriptCandidate,
    now: number,
  ): Promise<{ requests: number; inserted: number; errorCode?: string }> {
    let payload: Record<string, unknown>;
    try {
      payload = record(
        await this.deps.request("chat.history", {
          sessionKey: candidate.sessionKey,
          limit: HISTORY_PAGE_LIMIT,
          ...(candidate.cursor ? { cursor: candidate.cursor } : {}),
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
      ...(this.deps.inventory ? { inventory: this.deps.inventory } : {}),
    });

    const writes = this.withoutKnown(candidate.sessionKey, page.writes);
    const { inserted } = this.deps.archive.append(writes);
    this.storedBytes += writes.reduce((total, write) => total + Buffer.byteLength(write.content, "utf8"), 0);

    const lastSeq = writes.length > 0 ? Math.max(...writes.map((write) => write.seq)) : candidate.lastSeq;
    this.deps.archive.recordSync({
      sessionKey: candidate.sessionKey,
      ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
      ...(lastSeq !== undefined ? { lastSeq } : {}),
      complete: !page.hasMore,
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
