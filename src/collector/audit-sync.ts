import { projectAuditPage, type ProjectedAuditPage } from "../activity/audit-projector.js";
import type { FieldInventory } from "./field-inventory.js";
import type { AuditStore } from "../storage/audit-store.js";
import type { CapabilityState } from "./capability-probe.js";

/**
 * Incremental audit trail sync.
 *
 * `audit.list` pages newest first and takes a cursor meaning "sequence below
 * this one". There is no "everything above this sequence" filter, so an
 * incremental read is a walk from the top that stops once it recognises what it
 * is seeing — and a separate walk downwards for the history that predates the
 * first sync, kept apart for the same reason transcripts keep them apart: a long
 * backwards walk must not delay the records that arrived a minute ago.
 */

/** The trail only moves when agents run, so this is deliberately slow. */
export const AUDIT_SYNC_MS = 300_000;
/** The method's own ceiling. */
export const AUDIT_PAGE_LIMIT = 500;
/** Pages per round, so a full trail cannot monopolise a reconcile cycle. */
export const AUDIT_ROUND_PAGE_BUDGET = 4;
/** Of that budget, what the tail may spend before backfill gets the rest. */
export const AUDIT_TAIL_PAGE_BUDGET = 2;

export type AuditRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type AuditSyncOutcome = {
  requests: number;
  inserted: number;
  /**
   * False when the tail ran out of request budget before recognising a record it
   * already had, which leaves a gap the next round re-reads from the top.
   */
  caughtUp: boolean;
  /** True once the backwards walk has reached the end of the retained trail. */
  complete: boolean;
  /**
   * True when the Gateway's trail restarted below what this collector had read.
   *
   * Its sequences come from a table the Gateway prunes by age and by row count,
   * and a reset state database starts counting again from one. Left undetected,
   * the stop condition would recognise every new record as one already seen and
   * the trail would stop being collected, silently and for as long as the
   * collector stayed up.
   */
  rewound: boolean;
  newestSequence?: number;
  skipped?: "not_connected" | "unavailable" | "unauthorized";
  errorCode?: string;
};

export type AuditSyncDeps = {
  store: AuditStore;
  request: AuditRequest;
  inventory?: FieldInventory;
  /**
   * Called with the sessions that gained verdicts this round.
   *
   * A verdict is evidence for a session's grade, and it can arrive long after the
   * session went quiet — the backwards walk is nothing but that — so the staleness
   * check, which compares against `last_activity_at`, would never notice.
   */
  onRecorded?: (sessionKeys: readonly string[]) => void;
};

/** Closed set, carrying no session-specific text into logs or diagnostics. */
export function classifyAuditFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("method_not_found") || message.includes("unknown method")) return "unavailable";
  if (message.includes("unauthorized") || message.includes("forbidden") || message.includes("scope")) {
    return "unauthorized";
  }
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  return "error";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class AuditSynchronizer {
  constructor(private readonly deps: AuditSyncDeps) {}

  async runOnce(options: { now: number; connected: boolean; auditState: CapabilityState }): Promise<AuditSyncOutcome> {
    const idle: AuditSyncOutcome = {
      requests: 0,
      inserted: 0,
      caughtUp: false,
      complete: this.deps.store.readBackfillComplete(),
      rewound: false,
    };
    if (!options.connected) return { ...idle, skipped: "not_connected" };
    if (options.auditState === "unavailable") return { ...idle, skipped: "unavailable" };
    if (options.auditState === "unauthorized") return { ...idle, skipped: "unauthorized" };

    const gained = new Set<string>();
    let requests = 0;
    let inserted = 0;
    let errorCode: string | undefined;
    let rewound = false;
    let caughtUp = false;
    let complete = this.deps.store.readBackfillComplete();
    let mark = this.deps.store.readNewestMark();
    let newestSeen: number | undefined;

    // The tail. Stops as soon as a page contains something already read, which on
    // a quiet Gateway is the first page and one request.
    let cursor: string | undefined;
    while (requests < AUDIT_TAIL_PAGE_BUDGET) {
      let page: ProjectedAuditPage;
      try {
        page = await this.fetch(cursor, options.now);
      } catch (error) {
        errorCode = classifyAuditFailure(error);
        break;
      }
      requests += 1;

      if (newestSeen === undefined && page.newestSequence !== undefined) {
        newestSeen = page.newestSequence;
        if (mark !== undefined && page.newestSequence < mark) {
          rewound = true;
          mark = undefined;
          // What is left of the trail is shorter than what was walked, so whether
          // its end has been reached is an open question again.
          complete = false;
          this.deps.store.writeBackfillComplete(false);
        }
      }

      const floor = mark;
      const fresh = floor === undefined ? page.writes : page.writes.filter((write) => write.sequence > floor);
      const result = this.deps.store.append(fresh);
      inserted += result.inserted;
      for (const key of result.sessionKeys) gained.add(key);

      if (floor !== undefined && page.writes.some((write) => write.sequence <= floor)) {
        caughtUp = true;
        break;
      }
      if (page.nextCursor === undefined) {
        // Read from the newest record to the oldest one the Gateway still keeps,
        // which settles both questions at once.
        caughtUp = true;
        complete = true;
        this.deps.store.writeBackfillComplete(true);
        break;
      }
      cursor = page.nextCursor;
    }

    /**
     * The mark only moves on a contiguous read.
     *
     * A round that stored the newest pages and then ran out of budget has a gap
     * beneath them. Recording the top as read would make the next round stop at
     * page one, and the records in that gap would never be asked for again — so
     * the mark stays put and the next round walks down from the top a second time.
     * The repeated pages cost requests and store nothing, which is the cheaper
     * failure by a wide margin.
     */
    if (newestSeen !== undefined && (caughtUp || rewound || mark === undefined)) {
      this.deps.store.writeNewestMark(newestSeen);
    }

    if (!complete && errorCode === undefined) {
      const walked = await this.backfill(options.now, requests, gained);
      requests += walked.requests;
      inserted += walked.inserted;
      complete = walked.complete;
      errorCode ??= walked.errorCode;
    }

    // Contained: whatever the listener does with the news, failing at it is not
    // this round failing. The rows landed, and reporting otherwise would send the
    // next round to fetch them again.
    if (gained.size > 0) {
      try {
        this.deps.onRecorded?.([...gained]);
      } catch {
        // The periodic recompute pass covers these sessions regardless.
      }
    }

    return {
      requests,
      inserted,
      caughtUp,
      complete,
      rewound,
      ...(newestSeen !== undefined ? { newestSequence: newestSeen } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  /**
   * Walks below the oldest record held.
   *
   * The cursor is the oldest stored sequence rather than a saved token: the two
   * would have to agree, and only one of them can be wrong. Once the end is
   * reached the flag stops this walk for good — retention will later delete the
   * oldest rows, and without the flag the walk would read that as history to
   * fetch again.
   */
  private async backfill(
    now: number,
    spent: number,
    gained: Set<string>,
  ): Promise<{ requests: number; inserted: number; complete: boolean; errorCode?: string }> {
    let requests = 0;
    let inserted = 0;
    const oldest = this.deps.store.oldestSequence();
    if (oldest === undefined) return { requests, inserted, complete: false };

    let cursor = String(oldest);
    while (spent + requests < AUDIT_ROUND_PAGE_BUDGET) {
      let page: ProjectedAuditPage;
      try {
        page = await this.fetch(cursor, now);
      } catch (error) {
        return { requests, inserted, complete: false, errorCode: classifyAuditFailure(error) };
      }
      requests += 1;

      const result = this.deps.store.append(page.writes);
      inserted += result.inserted;
      for (const key of result.sessionKeys) gained.add(key);

      // No readable record below the cursor is the end of the trail as far as this
      // collector can ever see it.
      if (page.writes.length === 0 || page.nextCursor === undefined) {
        this.deps.store.writeBackfillComplete(true);
        return { requests, inserted, complete: true };
      }
      cursor = page.nextCursor;
    }
    return { requests, inserted, complete: false };
  }

  private async fetch(cursor: string | undefined, now: number) {
    const payload = record(
      await this.deps.request("audit.list", {
        limit: AUDIT_PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    return projectAuditPage(payload, {
      observedAt: now,
      ...(this.deps.inventory ? { inventory: this.deps.inventory } : {}),
    });
  }
}
