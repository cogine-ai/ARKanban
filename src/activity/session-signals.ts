import type {
  ActivityAttention,
  ActivityOutcome,
  ActivityState,
  SessionConfidence,
  SessionOutcomeClass,
  SessionSignalGrade,
  SessionSignals,
} from "../contracts.js";

/**
 * Derived session health.
 *
 * Pure, so the weights can be retuned and re-run against stored evidence
 * without touching collection or storage. The spec defers the weights to the
 * values AgentsView uses; those are not readable from here, so this table is a
 * documented starting point that `SIGNAL_ALGORITHM_VERSION` makes safe to
 * replace — bumping it marks every stored row for recomputation.
 *
 * The scoring only ever reads observed evidence. Context-pressure signals
 * (compaction, context exhaustion) are omitted entirely rather than guessed at,
 * per §2.4 of the spec.
 */

export const SIGNAL_ALGORITHM_VERSION = 2;

/**
 * Points deducted from 100. Each entry is capped so one pathological session
 * cannot drive the score arbitrarily negative, which would make F meaningless
 * as a bucket.
 */
export const SIGNAL_PENALTIES = {
  /** Terminal failure. Dominant on purpose: nothing else about a run matters as much. */
  errored_outcome: { points: 45, max: 45 },
  timed_out: { points: 35, max: 35 },
  cancelled: { points: 15, max: 15 },
  /** Started, never reached a terminal state, then went quiet. */
  abandoned: { points: 25, max: 25 },
  tool_failure: { points: 6, max: 30 },
  /** Charged per failure beyond the first in a streak; a streak is worse than the same count spread out. */
  consecutive_failures: { points: 12, max: 24 },
  /** Charged per retry beyond the first: repeatedly re-running one failing tool is a loop. */
  retry_loop: { points: 8, max: 24 },
  /** Ended while still flagged for attention. */
  attention_error: { points: 10, max: 10 },
} as const satisfies Record<string, { points: number; max: number }>;

export type SignalPenaltyCode = keyof typeof SIGNAL_PENALTIES;

/** Score thresholds, inclusive lower bounds. */
export const GRADE_THRESHOLDS: Array<{ grade: Exclude<SessionSignalGrade, "unscored">; min: number }> = [
  { grade: "A", min: 90 },
  { grade: "B", min: 75 },
  { grade: "C", min: 60 },
  { grade: "D", min: 40 },
  { grade: "F", min: 0 },
];

/**
 * How long a session with no terminal activity must stay quiet before it counts
 * as abandoned rather than merely in progress.
 */
export const ABANDON_AFTER_MS = 6 * 60 * 60 * 1_000;

/**
 * Tool lifecycle phases that mean the call failed.
 *
 * Read as an alias set, like every other Gateway-shaped field in this codebase:
 * the phase vocabulary comes from protocol documentation, not from an observed
 * Gateway, and a wrong guess here silently scores every session as healthy.
 */
export const TOOL_FAILURE_STATUSES = ["error", "failed", "failure", "rejected", "denied", "timeout"] as const;
export const TOOL_SUCCESS_STATUSES = ["end", "ok", "success", "succeeded", "done", "result"] as const;

export type ToolEventEvidence = {
  toolName?: string;
  status?: string;
  /** Full event kind, e.g. `session.tool:tool:error`, used when status is absent. */
  kind?: string;
  occurredAt: number;
};

export type ActivityEvidence = {
  state: ActivityState;
  outcome: ActivityOutcome;
  attention: ActivityAttention;
  endedAt?: number;
  updatedAt: number;
};

export type SignalEvidence = {
  sessionKey: string;
  lastActivityAt: number;
  hasActiveRun: boolean;
  activities: ActivityEvidence[];
  /** Ordered oldest first; ordering is what makes streaks and retries readable. */
  toolEvents: ToolEventEvidence[];
};

function matches(haystack: string | undefined, needles: readonly string[]): boolean {
  if (!haystack) return false;
  const lowered = haystack.toLowerCase();
  return needles.some((needle) => lowered === needle || lowered.endsWith(`:${needle}`));
}

export function isToolFailure(event: ToolEventEvidence): boolean {
  return matches(event.status, TOOL_FAILURE_STATUSES) || matches(event.kind, TOOL_FAILURE_STATUSES);
}

function isToolSettled(event: ToolEventEvidence): boolean {
  return isToolFailure(event) || matches(event.status, TOOL_SUCCESS_STATUSES) || matches(event.kind, TOOL_SUCCESS_STATUSES);
}

type ToolTally = { failures: number; retries: number; consecutiveFailureMax: number; settled: number };

/**
 * Counts tool trouble over the ordered event stream.
 *
 * A retry is the same tool running again after that tool failed, which is what
 * separates a loop from a session that simply used many tools. Only settled
 * events are counted, so a `start` with no recorded end is not read as either
 * outcome.
 */
export function tallyToolEvents(events: ToolEventEvidence[]): ToolTally {
  const tally: ToolTally = { failures: 0, retries: 0, consecutiveFailureMax: 0, settled: 0 };
  const failedTools = new Set<string>();
  let streak = 0;

  for (const event of events) {
    if (!isToolSettled(event)) continue;
    tally.settled += 1;
    const name = event.toolName;

    if (isToolFailure(event)) {
      tally.failures += 1;
      streak += 1;
      tally.consecutiveFailureMax = Math.max(tally.consecutiveFailureMax, streak);
      if (name) {
        if (failedTools.has(name)) tally.retries += 1;
        else failedTools.add(name);
      }
      continue;
    }

    streak = 0;
    // A success after a failure of the same tool is the retry that recovered,
    // and is charged as a retry too: the loop happened either way.
    if (name && failedTools.has(name)) {
      tally.retries += 1;
      failedTools.delete(name);
    }
  }
  return tally;
}

/**
 * The terminal activity that decided the session, or undefined if none ended.
 *
 * The newest classified outcome wins over a newer unclassified one. `unknown`
 * says nothing, and it is routinely the newest row: an event arriving after its
 * run ended opens a fresh attempt, which the next snapshot closes as `unknown`
 * once the Gateway stops advertising it. Taking the newest row outright would
 * let that bookkeeping bury a verdict the Gateway actually gave.
 */
function decidingActivity(activities: ActivityEvidence[]): ActivityEvidence | undefined {
  let classified: ActivityEvidence | undefined;
  let latest: ActivityEvidence | undefined;
  const endedAt = (activity: ActivityEvidence): number => activity.endedAt ?? activity.updatedAt;

  for (const activity of activities) {
    if (activity.state !== "terminal") continue;
    if (!latest || endedAt(activity) >= endedAt(latest)) latest = activity;
    const isClassified = activity.outcome !== "unknown" && activity.outcome !== "none";
    if (isClassified && (!classified || endedAt(activity) >= endedAt(classified))) classified = activity;
  }
  return classified ?? latest;
}

function outcomeClass(outcome: ActivityOutcome): SessionOutcomeClass {
  switch (outcome) {
    case "succeeded":
      return "completed";
    case "failed":
    case "timed_out":
      return "errored";
    case "cancelled":
    case "blocked":
      return "abandoned";
    case "unknown":
    case "none":
      return "unknown";
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled activity outcome: ${String(exhaustive)}`);
    }
  }
}

export function gradeForScore(score: number): Exclude<SessionSignalGrade, "unscored"> {
  for (const threshold of GRADE_THRESHOLDS) {
    if (score >= threshold.min) return threshold.grade;
  }
  return "F";
}

function charge(
  penalties: Array<{ code: string; points: number }>,
  code: SignalPenaltyCode,
  units = 1,
): void {
  if (units <= 0) return;
  const weight = SIGNAL_PENALTIES[code];
  const points = Math.min(weight.points * units, weight.max);
  if (points > 0) penalties.push({ code, points });
}

/**
 * Scores one session.
 *
 * Returns `unscored` when nothing was observed that could support a grade:
 * no classified terminal outcome and no settled tool call. Guessing a number
 * there would be indistinguishable from a measured one on every surface that
 * reads it.
 */
export function computeSessionSignals(evidence: SignalEvidence, now: number): SessionSignals {
  const tally = tallyToolEvents(evidence.toolEvents);
  const deciding = decidingActivity(evidence.activities);
  const quietFor = now - evidence.lastActivityAt;

  // "Something ended" is not a verdict. Session-level terminal events often
  // carry no classified outcome at all, and treating that as success would
  // hand out clean grades on the strength of a run merely stopping.
  const hasVerdict = deciding !== undefined && deciding.outcome !== "none" && deciding.outcome !== "unknown";

  const outcome: SessionOutcomeClass = deciding
    ? outcomeClass(deciding.outcome)
    : evidence.hasActiveRun
      ? "unknown"
      : quietFor >= ABANDON_AFTER_MS
        ? "abandoned"
        : "unknown";

  const confidence: SessionConfidence = hasVerdict && tally.settled > 0
    ? "high"
    : hasVerdict || tally.settled > 0
      ? "medium"
      : "low";

  const base: Omit<SessionSignals, "grade" | "score"> = {
    sessionKey: evidence.sessionKey,
    algorithmVersion: SIGNAL_ALGORITHM_VERSION,
    computedAt: now,
    outcome,
    confidence,
    toolFailures: tally.failures,
    toolRetries: tally.retries,
    consecutiveFailureMax: tally.consecutiveFailureMax,
    penalties: [],
  };

  // A grade needs either a classified terminal outcome or at least one settled
  // tool call. Below that bar the outcome guess still ships — `confidence` is
  // there to qualify it — but no number does.
  if (!hasVerdict && tally.settled === 0) {
    return { ...base, grade: "unscored" };
  }

  const penalties: Array<{ code: string; points: number }> = [];
  if (deciding) {
    switch (deciding.outcome) {
      case "failed":
        charge(penalties, "errored_outcome");
        break;
      case "timed_out":
        charge(penalties, "timed_out");
        break;
      case "cancelled":
      case "blocked":
        charge(penalties, "cancelled");
        break;
      case "succeeded":
      case "unknown":
      case "none":
        break;
      default: {
        const exhaustive: never = deciding.outcome;
        throw new Error(`Unhandled activity outcome: ${String(exhaustive)}`);
      }
    }
    if (deciding.attention === "error") charge(penalties, "attention_error");
  } else if (outcome === "abandoned") {
    charge(penalties, "abandoned");
  }

  charge(penalties, "tool_failure", tally.failures);
  charge(penalties, "consecutive_failures", Math.max(0, tally.consecutiveFailureMax - 1));
  charge(penalties, "retry_loop", Math.max(0, tally.retries - 1));

  const deducted = penalties.reduce((sum, penalty) => sum + penalty.points, 0);
  const score = Math.max(0, 100 - deducted);

  return { ...base, penalties, score, grade: gradeForScore(score) };
}
