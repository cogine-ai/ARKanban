export type ActivityKind = "task" | "attempt";
export type ActivityOrigin = "task_ledger" | "online" | "session_segment";
export type ActivityCatalog = "operational" | "terminal_history";
export type ActivityState = "queued" | "active" | "terminal" | "unknown";
export type ActivityOutcome =
  | "none"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "blocked"
  | "unknown";
export type ActivityPhase =
  | "none"
  | "starting"
  | "planning"
  | "model"
  | "tool"
  | "waiting_approval"
  | "unknown";
export type ActivityAttention = "none" | "waiting" | "blocked" | "error" | "stale" | "partial";
export type ActivityStage = "incoming" | "in_flight" | "waiting" | "settled" | "unresolved";
export type ActivityFreshness = "live" | "reconciling" | "stale";
export type EvidenceSource = "task" | "session" | "events";

export type EvidenceState = {
  source: EvidenceSource;
  health: "live" | "snapshot" | "not_observed" | "gap" | "stale" | "unavailable" | "error";
  observedAt?: number;
  code?: string;
};

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  origin: ActivityOrigin;
  catalog: ActivityCatalog;
  agentId: string;
  runtime?: string;
  state: ActivityState;
  outcome: ActivityOutcome;
  phase: ActivityPhase;
  attention: ActivityAttention;
  stage: ActivityStage;
  freshness: ActivityFreshness;
  title: string;
  progressSummary?: string;
  lastToolName?: string;
  flowId?: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  lastObservedAt: number;
  evidence: EvidenceState[];
};

export type ActivityRelation = {
  type: "parent_task" | "run_correlation" | "session_lineage" | "flow_member";
  from: string;
  to: string;
  certainty: "exact" | "correlation_only";
  label: string;
};

export type ObservationView = {
  id: number;
  source: EvidenceSource | "collector";
  kind: string;
  phase?: ActivityPhase;
  status?: string;
  toolName?: string;
  occurredAt: number;
};

export type ActivityDetail = {
  epoch: string;
  revision: number;
  item: ActivityItem;
  identity: {
    taskId?: string;
    runRef?: string;
    sessionKey?: string;
    flowId?: string;
    parentTaskId?: string;
  };
  relations: ActivityRelation[];
  related: ActivityItem[];
  timeline: ObservationView[];
};

export type StageCounts = {
  incoming: number;
  inFlight: number;
  waiting: number;
  settled: number;
  unresolved: number;
};

export type LaneSummary = {
  key: string;
  label: string;
  counts: StageCounts;
  attention: number;
};

export type SourceCoverage = {
  source: "tasks" | "sessions" | "events";
  state: "connecting" | "live" | "reconciling" | "offline" | "unavailable" | "error";
  lastSnapshotAt?: number;
  lastEventAt?: number;
  code?: string;
};

export type CollectorSyncState =
  | "starting"
  | "live"
  | "reconciling"
  | "offline"
  | "unauthorized"
  | "incompatible"
  | "error";

export type CollectorStatus = {
  apiVersion: 1;
  process: {
    version: string;
    startedAt: number;
    ready: boolean;
  };
  epoch: string;
  revision: number;
  syncState: CollectorSyncState;
  syncReasons: string[];
  gateway: {
    name: string;
    endpoint: string;
    connected: boolean;
    serverVersion?: string;
    protocolVersion?: number;
    connectedAt?: number;
    disconnectedAt?: number;
    grantedScopes: string[];
  };
  sources: SourceCoverage[];
};

export type ActivitySnapshot = {
  apiVersion: 1;
  epoch: string;
  revision: number;
  generatedAt: number;
  sync: {
    state: CollectorSyncState;
    reasons: string[];
    lastGatewayEventAt?: number;
    lastAuthoritativeSnapshotAt?: number;
  };
  summary: StageCounts;
  lanes: LaneSummary[];
  items: ActivityItem[];
  relations: ActivityRelation[];
  schedule: UpcomingScheduleSnapshot;
};

export type UpcomingSchedule = {
  id: string;
  jobId: string;
  agentId: string;
  title: string;
  nextRunAt: number;
  scheduleKind: string;
  timezone?: string;
};

export type UpcomingScheduleSnapshot = {
  revision: number;
  state: "live" | "partial" | "unavailable" | "offline" | "error";
  schedulerEnabled: boolean;
  windowMinutes: 60;
  dueGraceMinutes: 3;
  lastSnapshotAt?: number;
  items: UpcomingSchedule[];
};

export type AgentKind = "agent" | "system" | "unknown";
export type AgentOrigin = "roster" | "observed";

export type AgentSummary = {
  id: string;
  displayName: string;
  kind: AgentKind;
  runtime?: string;
  model?: string;
  /** `roster` came from agents.list; `observed` was inferred from seen agentIds. */
  origin: AgentOrigin;
  firstObservedAt: number;
  lastActivityAt?: number;
};

/** Windows the agent overview rolls terminal activity up over. */
export type AgentRollupWindow = "24h" | "7d";

/**
 * Terminal-activity rollup for one agent over one window.
 *
 * `successRate` and `avgDurationMs` are optional rather than zero-defaulted:
 * an agent that completed nothing has no success rate, and reporting 0% would
 * read as total failure. Same reasoning as SessionCoverage — "no data" and
 * "measured zero" must not collapse into the same value.
 */
export type AgentActivityRollup = {
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  blocked: number;
  unknown: number;
  successRate?: number;
  avgDurationMs?: number;
  /** Runs that had both a start and an end observed, so avgDurationMs is readable. */
  durationSampleCount: number;
};

export type AgentOverview = AgentSummary & {
  sessionCount: number;
  activeSessionCount: number;
  archivedSessionCount: number;
  activityCount: number;
  lastSessionActivityAt?: number;
  recent: Record<AgentRollupWindow, AgentActivityRollup>;
  /**
   * Carries its own coverage so the card can say "not collected" instead of
   * rendering a confident zero for an agent whose usage was never observed.
   *
   * `source` names where the amount came from, because a card priced by
   * `usage.cost` can legitimately differ from `/usage/summary`, which only ever
   * reports stored per-session readings.
   */
  cost: {
    coverage: SessionUsageCoverage;
    source: "gateway" | "snapshots";
    windows: Record<AgentRollupWindow, UsageTotals>;
  };
};

export type SessionKindHint = "main" | "fork" | "subagent" | "global" | "unknown";

/**
 * Per-source evidence completeness for one session row. The four paths stay
 * separate on purpose: "usage unavailable" and "usage is zero" mean opposite
 * things on a cost view and must never collapse into one flag.
 */
/**
 * `snapshot` means the session was pushed past the per-round candidate ceiling
 * and is carrying an older observation. The spec's §2.2 type omitted it while
 * §3.3 requires it; without it, a deferred session would be indistinguishable
 * from a freshly measured one.
 *
 * `unreported` means the endpoint answered and reported no usage: it totals a
 * session's own accounting file, and a session whose harness never wrote counts
 * there comes back as zeros. Every session on the calibration machine did, with
 * `cacheStatus` reporting `fresh`. It is separate from `error` because nothing
 * failed, and separate from `not_observed` because the reading did happen —
 * collapsing either way would present a session with no accounting as one that
 * cost nothing.
 */
export type SessionUsageCoverage =
  | "live"
  | "snapshot"
  | "unreported"
  | "not_observed"
  | "unavailable"
  | "unauthorized"
  | "error";

export type SessionCoverage = {
  index: "live" | "snapshot" | "stale" | "unavailable";
  detail: "live" | "not_observed" | "unavailable";
  usage: SessionUsageCoverage;
  messages: "live" | "not_observed" | "unavailable";
};

export type SessionLineage = {
  parentSessionKey?: string;
  previousSessionId?: string;
  forkSourceKey?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  subagentRole?: string;
  worktreeBranch?: string;
};

export type SessionSummary = {
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  label: string;
  runtime?: string;
  model?: string;
  category?: string;
  kindHint: SessionKindHint;
  archived: boolean;
  hasActiveRun: boolean;
  placement?: string;
  createdAt?: number;
  lastActivityAt: number;
  lastObservedAt: number;
  activityCount: number;
  coverage: SessionCoverage;
  /** Enough of the derived health to render a list row; the full row is on the detail. */
  signals?: SessionSignalsBrief;
};

export type SessionSignalsBrief = Pick<SessionSignals, "grade" | "score" | "outcome" | "confidence">;

export type SessionRecord = SessionSummary & {
  lineage: SessionLineage;
};

/**
 * Cost is an integer count of micro-USD; floats are banned because summing
 * rounded fractions of a cent across thousands of sessions drifts.
 *
 * `hasCost` is not the same as `costMicroUsd === 0`. The first says the price
 * of at least one model was unknown, the second says the work was genuinely
 * free — a cost view that conflates them is lying about spend.
 */
export type SessionUsage = {
  sessionKey: string;
  observedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  peakContextTokens?: number;
  costMicroUsd?: number;
  hasCost: boolean;
  models: string[];
  unpricedModels: string[];
};

/** Aggregated usage over a window, for an agent or the whole collector. */
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd?: number;
  /** False when any contributing model had no price, making the cost a floor. */
  hasCost: boolean;
  sessionCount: number;
  unpricedModels: string[];
};

export type UsageSummary = {
  from: number;
  to: number;
  coverage: SessionUsageCoverage;
  totals: UsageTotals;
  byAgent: Array<{ agentId: string; totals: UsageTotals }>;
  byModel: Array<{ model: string; totals: UsageTotals }>;
};

export type SessionSignalGrade = "A" | "B" | "C" | "D" | "F" | "unscored";
export type SessionOutcomeClass = "completed" | "abandoned" | "errored" | "unknown";
export type SessionConfidence = "high" | "medium" | "low";

/**
 * Derived health for one session.
 *
 * `algorithmVersion` is mandatory. The model is heuristic and will be retuned,
 * and without a version there is no way to tell which rows need recomputing.
 *
 * `unscored` is a legitimate result. When the evidence is too thin, this must
 * say so rather than emit a number that looks precise.
 */
export type SessionSignals = {
  sessionKey: string;
  algorithmVersion: number;
  computedAt: number;
  grade: SessionSignalGrade;
  score?: number;
  outcome: SessionOutcomeClass;
  confidence: SessionConfidence;
  toolFailures: number;
  toolRetries: number;
  consecutiveFailureMax: number;
  penalties: Array<{ code: string; points: number }>;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type ArchivedMessage = {
  id: number;
  sessionKey: string;
  sessionId?: string;
  messageId?: string;
  seq: number;
  role: MessageRole;
  channel?: string;
  toolName?: string;
  content: string;
  /** Set when a later transcript generation replaced this message's lineage. */
  supersededBySessionId?: string;
  divergent: boolean;
  createdAt: number;
};

export type TranscriptSyncState = {
  sessionKey: string;
  syncedCount: number;
  syncedBytes: number;
  complete: boolean;
  syncedAt?: number;
  errorCode?: string;
};

/**
 * `fts` used the trigram index; `fallback` used a bounded LIKE scan because the
 * query was shorter than the three characters FTS5 trigram requires.
 */
export type MessageSearchMode = "fts" | "fallback";

export type MessageSearchHit = {
  message: ArchivedMessage;
  agentId: string;
  sessionLabel: string;
};

export type MessageSearchResult = {
  mode: MessageSearchMode;
  hits: MessageSearchHit[];
  truncated: boolean;
};

export type SettledRange = "24h" | "7d" | "30d";
export type SettledGroupingConfidence = "canonical" | "display_exact";
export type SettledPriorityTier = "P0" | "P1" | "P2" | "P3";

export type SettledOutcomeCounts = Record<ActivityOutcome, number>;

export type SettledGroupSummary = {
  seriesKey: string;
  groupingConfidence: SettledGroupingConfidence;
  agentId: string;
  kind: ActivityKind;
  title: string;
  rangeStart: number;
  rangeEnd: number;
  runCount: number;
  succeededCount: number;
  failedCount: number;
  timedOutCount: number;
  cancelledCount: number;
  blockedCount: number;
  unknownCount: number;
  latestActivityId: string;
  latestOutcome: ActivityOutcome;
  latestEndedAt: number;
  failureRate: number;
  priorityTier: SettledPriorityTier;
};

export type SettledGroupSnapshot = {
  apiVersion: 1;
  epoch: string;
  revision: number;
  generatedAt: number;
  range: SettledRange;
  rangeStart: number;
  rangeEnd: number;
  complete: boolean;
  totalSeries: number;
  totalRuns: number;
  outcomeCounts: SettledOutcomeCounts;
  groupsByAgent: Record<string, SettledGroupSummary[]>;
};

export type SettledRunSummary = {
  id: string;
  agentId: string;
  kind: ActivityKind;
  title: string;
  outcome: ActivityOutcome;
  terminalAt: number;
  updatedAt: number;
};

export type SettledSeriesRuns = {
  apiVersion: 1;
  epoch: string;
  revision: number;
  range: SettledRange;
  rangeStart: number;
  rangeEnd: number;
  complete: boolean;
  group: SettledGroupSummary;
  runs: SettledRunSummary[];
};

export type ChangeTopic = "activities" | "sessions" | "usage" | "agents";

export type CollectorChange = {
  epoch: string;
  revision: number;
  full: boolean;
  /**
   * Which surfaces the change affects. The existing invalidate frame is
   * coarse-grained, so a session-only refresh currently makes clients refetch
   * every endpoint. Absent on frames from older collectors, where clients must
   * assume `["activities"]` to preserve today's behaviour.
   */
  topics?: ChangeTopic[];
  ids: string[];
  reasons: string[];
  syncState: CollectorSyncState;
};
