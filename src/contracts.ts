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
};

export type CollectorChange = {
  epoch: string;
  revision: number;
  full: boolean;
  ids: string[];
  reasons: string[];
  syncState: CollectorSyncState;
};
