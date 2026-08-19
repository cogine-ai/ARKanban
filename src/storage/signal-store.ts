import type { DatabaseSync } from "node:sqlite";
import {
  SIGNAL_ALGORITHM_VERSION,
  computeSessionSignals,
  tallyToolEvents,
  type ActivityEvidence,
  type SignalEvidence,
  type ToolEventEvidence,
} from "../activity/session-signals.js";
import type {
  ActivityAttention,
  ActivityOutcome,
  ActivityState,
  SessionConfidence,
  SessionOutcomeClass,
  SessionSignalGrade,
  SessionSignals,
} from "../contracts.js";
import type { AuditStore } from "./audit-store.js";

/**
 * Storage for derived session signals.
 *
 * Signals are computed from locally stored evidence only, so a recompute never
 * touches the Gateway and stays available offline. Rows carry the algorithm
 * version that produced them, which is what makes a weight change safe: bumping
 * the version marks every row stale and the recompute pass drains the backlog.
 */

/** Sessions rescored per pass, so a large archive cannot stall the event loop. */
export const SIGNAL_RECOMPUTE_BATCH = 200;

/**
 * Severity ranks for `sort=grade`.
 *
 * A descending scan needs a number per row, and the useful order for a review
 * pass is worst first. Unscored ranks lowest so unmeasured rows land at the
 * bottom, the same convention the cost sort uses.
 */
export const GRADE_SEVERITY: Record<SessionSignalGrade, number> = {
  F: 5,
  D: 4,
  C: 3,
  B: 2,
  A: 1,
  unscored: 0,
};

type Row = Record<string, unknown>;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePenalties(value: unknown): Array<{ code: string; points: number }> {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const code = record.code;
      const points = asNumber(record.points);
      return typeof code === "string" && points !== undefined ? [{ code, points }] : [];
    });
  } catch {
    return [];
  }
}

function rowToSignals(row: Row): SessionSignals {
  const score = asNumber(row.score);
  return {
    sessionKey: String(row.session_key),
    algorithmVersion: Number(row.algorithm_version ?? 0),
    computedAt: Number(row.computed_at ?? 0),
    grade: String(row.grade) as SessionSignalGrade,
    ...(score !== undefined ? { score } : {}),
    outcome: String(row.outcome) as SessionOutcomeClass,
    confidence: String(row.confidence) as SessionConfidence,
    toolFailures: Number(row.tool_failures ?? 0),
    toolRetries: Number(row.tool_retries ?? 0),
    consecutiveFailureMax: Number(row.consecutive_failure_max ?? 0),
    penalties: parsePenalties(row.penalties_json),
  };
}

export class SignalStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditStore,
  ) {}

  get(sessionKey: string): SessionSignals | undefined {
    const row = this.db.prepare("SELECT * FROM session_signals WHERE session_key = ?").get(sessionKey) as Row | undefined;
    return row ? rowToSignals(row) : undefined;
  }

  getMany(sessionKeys: string[]): Map<string, SessionSignals> {
    const result = new Map<string, SessionSignals>();
    if (sessionKeys.length === 0) return result;
    const placeholders = sessionKeys.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM session_signals WHERE session_key IN (${placeholders})`)
      .all(...sessionKeys) as Row[];
    for (const row of rows) {
      const signals = rowToSignals(row);
      result.set(signals.sessionKey, signals);
    }
    return result;
  }

  record(signals: SessionSignals[]): number {
    if (signals.length === 0) return 0;
    const statement = this.db.prepare(`
      INSERT INTO session_signals (
        session_key, algorithm_version, computed_at, grade, score, outcome,
        confidence, tool_failures, tool_retries, consecutive_failure_max, penalties_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_key) DO UPDATE SET
        algorithm_version = excluded.algorithm_version,
        computed_at = excluded.computed_at,
        grade = excluded.grade,
        score = excluded.score,
        outcome = excluded.outcome,
        confidence = excluded.confidence,
        tool_failures = excluded.tool_failures,
        tool_retries = excluded.tool_retries,
        consecutive_failure_max = excluded.consecutive_failure_max,
        penalties_json = excluded.penalties_json
    `);
    let written = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of signals) {
        statement.run(
          row.sessionKey,
          row.algorithmVersion,
          row.computedAt,
          row.grade,
          row.score ?? null,
          row.outcome,
          row.confidence,
          row.toolFailures,
          row.toolRetries,
          row.consecutiveFailureMax,
          JSON.stringify(row.penalties),
        );
        written += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return written;
  }

  /**
   * Sessions whose stored signals no longer reflect the evidence.
   *
   * A session qualifies when it has never been scored, when it was scored by an
   * older algorithm, or when it has moved since it was scored. Active sessions
   * come first: their verdict is the one most likely to be wrong right now.
   */
  staleSessions(limit = SIGNAL_RECOMPUTE_BATCH): string[] {
    const rows = this.db
      .prepare(`
        SELECT s.session_key
        FROM sessions s
        LEFT JOIN session_signals g ON g.session_key = s.session_key
        WHERE g.session_key IS NULL
           OR g.algorithm_version <> ?
           OR g.computed_at < s.last_activity_at
        ORDER BY s.has_active_run DESC, s.last_activity_at DESC
        LIMIT ?
      `)
      .all(SIGNAL_ALGORITHM_VERSION, limit) as Row[];
    return rows.map((row) => String(row.session_key));
  }

  /**
   * Loads the evidence one session's score rests on.
   *
   * Tool outcomes have three possible sources. The audit trail states the verdict
   * in `status` and pairs each call by `toolCallId`; an archived `toolResult`
   * message states it in `is_error`; an observation carries only a lifecycle phase
   * whose failure vocabulary this codebase had to guess. All three describe the
   * same calls, so they are alternatives rather than additions — summing them would
   * charge one failed call twice, or three times — and the one that settled more
   * calls is the one scored.
   *
   * "Whichever saw more" rather than "the stated source whenever it has anything":
   * every one of them is assembled a page at a time, and a session mid-backfill
   * holds only its newest page. Letting two records speak for a session whose
   * events recorded ten would drop the older failures, the streak they formed and
   * the retries after them — and the grade would improve as collection caught up,
   * which is the opposite of what more evidence should do.
   *
   * Ties go to the audit trail, then the transcript, then observations: that is
   * the order in which the Gateway stated the verdict rather than this codebase
   * inferring it.
   *
   * Ordering by `occurred_at` / `created_at` is what makes failure streaks and
   * retry loops readable at all.
   */
  evidenceFor(sessionKey: string): SignalEvidence | undefined {
    const session = this.db
      .prepare("SELECT session_key, last_activity_at, has_active_run FROM sessions WHERE session_key = ?")
      .get(sessionKey) as Row | undefined;
    if (!session) return undefined;

    // Matches the timeline query's tolerance: `session_ref` is only promoted
    // once the session row exists, so scoring on it alone would ignore evidence
    // the detail page displays right beside the grade.
    const activityRows = this.db
      .prepare(`
        SELECT state, outcome, attention, ended_at, updated_at
        FROM activities
        WHERE session_ref = ? OR session_key = ?
      `)
      .all(sessionKey, sessionKey) as Row[];

    const toolRows = this.db
      .prepare(`
        SELECT o.kind, o.status, o.tool_name, o.occurred_at
        FROM observations o
        JOIN activities a ON a.id = o.activity_id
        WHERE (a.session_ref = ? OR a.session_key = ?)
          AND (o.tool_name IS NOT NULL OR o.kind LIKE '%tool%')
        ORDER BY o.occurred_at ASC, o.id ASC
      `)
      .all(sessionKey, sessionKey) as Row[];

    /**
     * Superseded generations are left out. Compaction re-sends the surviving turns
     * under a fresh `sessionId`, so a tool result that outlived a compaction is
     * held twice, and counting both would double every failure a long session
     * carried across one.
     */
    const transcriptRows = this.db
      .prepare(`
        SELECT tool_name, is_error, created_at
        FROM session_messages
        WHERE session_key = ?
          AND is_error IS NOT NULL
          AND superseded_by_session_id IS NULL
        ORDER BY created_at ASC, seq ASC, id ASC
      `)
      .all(sessionKey) as Row[];

    const activities: ActivityEvidence[] = activityRows.map((row) => {
      const endedAt = asNumber(row.ended_at);
      return {
        state: String(row.state) as ActivityState,
        outcome: String(row.outcome) as ActivityOutcome,
        attention: String(row.attention) as ActivityAttention,
        ...(endedAt !== undefined ? { endedAt } : {}),
        updatedAt: Number(row.updated_at ?? 0),
      };
    });

    const observedTools: ToolEventEvidence[] = toolRows.map((row) => {
      const toolName = typeof row.tool_name === "string" ? row.tool_name : undefined;
      const status = typeof row.status === "string" ? row.status : undefined;
      return {
        ...(toolName ? { toolName } : {}),
        ...(status ? { status } : {}),
        kind: String(row.kind ?? ""),
        occurredAt: Number(row.occurred_at ?? 0),
      };
    });

    const archivedTools: ToolEventEvidence[] = transcriptRows.map((row) => {
      const toolName = typeof row.tool_name === "string" ? row.tool_name : undefined;
      return {
        ...(toolName ? { toolName } : {}),
        kind: "transcript.toolResult",
        failed: Number(row.is_error) === 1,
        occurredAt: Number(row.created_at ?? 0),
      };
    });

    const auditTools: ToolEventEvidence[] = this.audit.toolVerdicts(sessionKey).map((verdict) => ({
      ...(verdict.toolName ? { toolName: verdict.toolName } : {}),
      kind: "audit.tool_action",
      failed: verdict.failed,
      occurredAt: verdict.occurredAt,
    }));

    // Audit and archive rows are settled calls by construction: each is there
    // because the Gateway stated an outcome for it, and the unsettled ones were
    // dropped on the way in. Observations have to be counted, since a `start` with
    // no recorded end settles nothing.
    const candidates = [
      { events: auditTools, settled: auditTools.length },
      { events: archivedTools, settled: archivedTools.length },
      { events: observedTools, settled: tallyToolEvents(observedTools).settled },
    ];
    // First maximum wins, so the array order above is the tiebreak.
    const richest = candidates.reduce((best, candidate) => (candidate.settled > best.settled ? candidate : best));
    const auditRun = this.audit.runVerdict(sessionKey);

    return {
      sessionKey: String(session.session_key),
      lastActivityAt: Number(session.last_activity_at ?? 0),
      hasActiveRun: Number(session.has_active_run ?? 0) === 1,
      activities,
      toolEvents: richest.events,
      ...(auditRun ? { auditRun } : {}),
    };
  }

  /** Recomputes one session and stores the result. */
  recompute(sessionKey: string, now: number): SessionSignals | undefined {
    const evidence = this.evidenceFor(sessionKey);
    if (!evidence) return undefined;
    const signals = computeSessionSignals(evidence, now);
    this.record([signals]);
    return signals;
  }

  /** Drains up to `limit` stale sessions. Returns how many were rescored. */
  recomputeStale(now: number, limit = SIGNAL_RECOMPUTE_BATCH): number {
    const keys = this.staleSessions(limit);
    if (keys.length === 0) return 0;
    const computed: SessionSignals[] = [];
    for (const key of keys) {
      const evidence = this.evidenceFor(key);
      if (evidence) computed.push(computeSessionSignals(evidence, now));
    }
    return this.record(computed);
  }

  /**
   * Reads a stored row, recomputing first when it is stale.
   *
   * Used by the detail endpoint: opening one session is the moment its verdict
   * matters most, and scoring a single session is a couple of indexed reads.
   */
  freshFor(sessionKey: string, now: number): SessionSignals | undefined {
    const stored = this.get(sessionKey);
    if (stored && stored.algorithmVersion === SIGNAL_ALGORITHM_VERSION) {
      const evidence = this.db
        .prepare("SELECT last_activity_at FROM sessions WHERE session_key = ?")
        .get(sessionKey) as Row | undefined;
      if (!evidence) return stored;
      if (stored.computedAt >= Number(evidence.last_activity_at ?? 0)) return stored;
    }
    return this.recompute(sessionKey, now) ?? stored;
  }
}
