import type { DatabaseSync } from "node:sqlite";
import type { ActivityOutcome } from "../contracts.js";
import {
  AUDIT_KIND_RUN,
  AUDIT_KIND_TOOL,
  AUDIT_RUN_OUTCOMES,
  auditToolVerdict,
} from "../activity/audit-projector.js";

/**
 * Storage for the Gateway's audit trail.
 *
 * Metadata only, by contract and by projection: rows carry which tool ran, under
 * which run and session, and how it ended. That makes this store the one evidence
 * source for scoring that does not depend on transcript sync being on, and the
 * only one whose verdicts the Gateway states rather than this codebase inferring.
 *
 * Sync state lives in `meta` rather than a table of its own: it is three scalars
 * for one Gateway, and the alternative is a table that can only ever hold one row.
 */

/** How far a tail read has caught up, which is where the next one stops. */
const NEWEST_KEY = "audit_newest_sequence";
/** Set once the backwards walk has reached the end of the retained trail. */
const BACKFILL_DONE_KEY = "audit_backfill_complete";

export type AuditEventWrite = {
  eventId: string;
  sequence: number;
  sourceSequence?: number;
  occurredAt: number;
  kind: string;
  action?: string;
  status: string;
  errorCode?: string;
  actorType?: string;
  actorId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  observedAt: number;
};

/** One settled tool call, as the Gateway stated it. */
export type AuditToolVerdict = {
  toolName?: string;
  failed: boolean;
  occurredAt: number;
};

/** How a run ended, for a session no Activity row decided. */
export type AuditRunVerdict = {
  outcome: ActivityOutcome;
  endedAt: number;
};

type Row = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class AuditStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Stores a page, ignoring rows already held.
   *
   * `event_id` is the Gateway's own row identity, which is what makes re-reading
   * a page free: the tail read overlaps by design, and a watermark reset replays
   * everything the store already has.
   *
   * Returns the sessions that gained rows, because those are the sessions whose
   * score is now wrong — and a verdict for last week's run does not move the
   * session's `last_activity_at`, so nothing else would ever notice.
   */
  append(writes: readonly AuditEventWrite[]): { inserted: number; sessionKeys: string[] } {
    if (writes.length === 0) return { inserted: 0, sessionKeys: [] };
    const statement = this.db.prepare(`
      INSERT INTO audit_events (
        event_id, sequence, source_sequence, occurred_at, kind, action, status, error_code,
        actor_type, actor_id, agent_id, session_key, session_id, run_id, tool_call_id, tool_name,
        observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (event_id) DO NOTHING
    `);
    let inserted = 0;
    const sessionKeys = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        const result = statement.run(
          write.eventId,
          write.sequence,
          write.sourceSequence ?? null,
          write.occurredAt,
          write.kind,
          write.action ?? null,
          write.status,
          write.errorCode ?? null,
          write.actorType ?? null,
          write.actorId ?? null,
          write.agentId ?? null,
          write.sessionKey ?? null,
          write.sessionId ?? null,
          write.runId ?? null,
          write.toolCallId ?? null,
          write.toolName ?? null,
          write.observedAt,
        );
        if (Number(result.changes) > 0) {
          inserted += 1;
          if (write.sessionKey) sessionKeys.add(write.sessionKey);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { inserted, sessionKeys: [...sessionKeys] };
  }

  /**
   * The oldest sequence held, which is where the backwards walk resumes.
   *
   * Derived from the rows rather than stored as a cursor, so the two cannot
   * disagree: the Gateway pages by "sequence below this one", which is exactly
   * what the oldest row held describes.
   */
  oldestSequence(): number | undefined {
    const row = this.db.prepare("SELECT MIN(sequence) AS oldest FROM audit_events").get() as Row | undefined;
    const oldest = row?.oldest;
    return typeof oldest === "number" && Number.isFinite(oldest) ? oldest : undefined;
  }

  /**
   * The sequence the last tail read caught up to.
   *
   * Stored rather than derived from `MAX(sequence)`, because they answer different
   * questions: the maximum says what is held, while this says how far the trail was
   * read contiguously. A round that stored the newest page and then ran out of
   * request budget holds a high maximum with a gap under it, and stopping the next
   * round at that maximum would step over the gap for good.
   */
  readNewestMark(): number | undefined {
    const stored = this.meta(NEWEST_KEY);
    if (stored === undefined) return undefined;
    const parsed = Number.parseInt(stored, 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }

  writeNewestMark(sequence: number): void {
    this.setMeta(NEWEST_KEY, String(sequence));
  }

  /** Whether the backwards walk has already reached the end of the trail. */
  readBackfillComplete(): boolean {
    return this.meta(BACKFILL_DONE_KEY) === "1";
  }

  writeBackfillComplete(complete: boolean): void {
    if (complete) this.setMeta(BACKFILL_DONE_KEY, "1");
    else this.db.prepare("DELETE FROM meta WHERE key = ?").run(BACKFILL_DONE_KEY);
  }

  /**
   * Settled tool verdicts for one session, oldest first.
   *
   * Ordered by `occurred_at` then `sequence`: a fast tool call starts and ends
   * inside the same millisecond, and `sequence` is the Gateway's own insertion
   * order, so it is the tiebreak that keeps a failure and the retry after it in
   * the order they happened. Unsettled rows — a `started` with no end yet — are
   * dropped by the verdict lookup rather than guessed at.
   */
  toolVerdicts(sessionKey: string): AuditToolVerdict[] {
    const rows = this.db
      .prepare(`
        SELECT tool_name, status, error_code, occurred_at
        FROM audit_events
        WHERE session_key = ? AND kind = ?
        ORDER BY occurred_at ASC, sequence ASC
      `)
      .all(sessionKey, AUDIT_KIND_TOOL) as Row[];
    const verdicts: AuditToolVerdict[] = [];
    for (const row of rows) {
      const failed = auditToolVerdict(String(row.status ?? ""), optionalString(row.error_code));
      if (failed === undefined) continue;
      const toolName = optionalString(row.tool_name);
      verdicts.push({
        ...(toolName ? { toolName } : {}),
        failed,
        occurredAt: Number(row.occurred_at ?? 0),
      });
    }
    return verdicts;
  }

  /**
   * The newest run verdict for one session, if the Gateway stated one.
   *
   * Newest rather than merged: a session is many runs, and the one that decided
   * how it stands is the last one to end. Statuses this build does not recognise
   * are skipped rather than mapped to `unknown`, which is a claim of its own.
   */
  runVerdict(sessionKey: string): AuditRunVerdict | undefined {
    const rows = this.db
      .prepare(`
        SELECT status, occurred_at
        FROM audit_events
        WHERE session_key = ? AND kind = ?
        ORDER BY occurred_at DESC, sequence DESC
      `)
      .all(sessionKey, AUDIT_KIND_RUN) as Row[];
    for (const row of rows) {
      const outcome = AUDIT_RUN_OUTCOMES[String(row.status ?? "").toLowerCase()];
      if (outcome === undefined) continue;
      return { outcome, endedAt: Number(row.occurred_at ?? 0) };
    }
    return undefined;
  }

  /**
   * Ages rows out.
   *
   * There is no re-fetching what this deletes: the Gateway keeps its own audit
   * trail for 30 days and prunes by row count as well, so a deleted row is gone
   * for good. Retention therefore follows the session retention window, which is
   * how long the sessions these verdicts score are kept.
   */
  pruneOlderThan(cutoff: number): number {
    const result = this.db.prepare("DELETE FROM audit_events WHERE occurred_at < ?").run(cutoff);
    return Number(result.changes);
  }

  /** Counts only; used by diagnostics, which never carries session identities. */
  totals(): { events: number; newestSequence?: number; oldestOccurredAt?: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS events, MAX(sequence) AS newest, MIN(occurred_at) AS oldest FROM audit_events")
      .get() as Row | undefined;
    const newest = row?.newest;
    const oldest = row?.oldest;
    return {
      events: Number(row?.events ?? 0),
      ...(typeof newest === "number" ? { newestSequence: newest } : {}),
      ...(typeof oldest === "number" ? { oldestOccurredAt: oldest } : {}),
    };
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
  }
}
