import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  ActivityDetail,
  ActivityItem,
  ActivityOutcome,
  ActivityRelation,
  AgentActivityRollup,
  AgentKind,
  AgentOrigin,
  AgentOverview,
  AgentRollupWindow,
  AgentSummary,
  ChangeTopic,
  EvidenceState,
  LaneSummary,
  ObservationView,
  SessionCoverage,
  SessionKindHint,
  SessionLineage,
  SessionRecord,
  SessionSummary,
  SettledGroupSnapshot,
  SettledGroupSummary,
  SettledOutcomeCounts,
  SettledPriorityTier,
  SettledRange,
  SettledSeriesRuns,
  StageCounts,
} from "../contracts.js";
import { agentIdFromSessionKey, type ActivityWrite } from "../activity/projector.js";
import { applyMigrations, type MigrationResult } from "./migrations.js";
import { encodeCursor, type KeysetCursor, type SessionSort } from "./keyset-cursor.js";
import { TranscriptArchive } from "./transcript-archive.js";

export type RepositoryChange = {
  epoch: string;
  revision: number;
  topics: ChangeTopic[];
  ids: string[];
  reasons: string[];
};

export type StoredActivity = ActivityItem & {
  sourceKey: string;
  taskId?: string;
  runRef?: string;
  sessionKey?: string;
  parentTaskId?: string;
};

export type AgentWrite = {
  id: string;
  displayName: string;
  kind: AgentKind;
  runtime?: string;
  model?: string;
  origin: AgentOrigin;
  observedAt: number;
  lastActivityAt?: number;
};

export type SessionWrite = {
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
  lineage: SessionLineage;
  createdAt?: number;
  lastActivityAt: number;
  observedAt: number;
  coverage: SessionCoverage;
};

export type SessionListQuery = {
  agentId?: string;
  includeArchived?: boolean;
  limit?: number;
};

/**
 * `active` and `archived` are read straight off the row. `terminal` is the
 * remainder — observed, not archived, nothing running — which is a real state
 * the schema stores no column for.
 */
export type SessionStateFilter = "active" | "terminal" | "archived";

export type SessionPageQuery = {
  agentId?: string;
  state?: SessionStateFilter;
  since?: number;
  until?: number;
  sort: SessionSort;
  limit: number;
  cursor?: KeysetCursor;
};

export type SessionPage = {
  items: SessionSummary[];
  nextCursor?: string;
};

type ActivityRow = Record<string, unknown>;

const AGENT_ROLLUP_WINDOW_MS: Record<AgentRollupWindow, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
};

function emptyRollup(): AgentActivityRollup {
  return {
    completed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    blocked: 0,
    unknown: 0,
    durationSampleCount: 0,
  };
}

const EMPTY_COUNTS: StageCounts = {
  incoming: 0,
  inFlight: 0,
  waiting: 0,
  settled: 0,
  unresolved: 0,
};

const SETTLED_RANGE_MS: Record<SettledRange, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

const PRIORITY_ORDER: Record<SettledPriorityTier, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function settledRangeDuration(range: SettledRange): number {
  return SETTLED_RANGE_MS[range];
}

function emptyOutcomeCounts(): SettledOutcomeCounts {
  return {
    none: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timed_out: 0,
    blocked: 0,
    unknown: 0,
  };
}

function terminalAt(item: StoredActivity): number {
  return item.endedAt ?? item.updatedAt;
}

function fallbackSeriesKey(item: StoredActivity): string {
  const identity = JSON.stringify([item.agentId, item.title.trim(), item.kind]);
  const digest = createHash("sha256").update(identity).digest("base64url").slice(0, 18);
  return `display_exact:${digest}`;
}

function priorityTier(counts: SettledOutcomeCounts, latestOutcome: StoredActivity["outcome"], runCount: number): SettledPriorityTier {
  if (latestOutcome === "failed" || latestOutcome === "timed_out" || latestOutcome === "blocked") return "P0";
  if (latestOutcome === "unknown" || latestOutcome === "none") return "P1";
  if (latestOutcome === "cancelled") return "P2";
  if (latestOutcome === "succeeded" && counts.failed + counts.timed_out > 0) return "P2";
  if (counts.succeeded === runCount) return "P3";
  return "P1";
}

function compareSettledGroups(left: SettledGroupSummary, right: SettledGroupSummary): number {
  const tierDifference = PRIORITY_ORDER[left.priorityTier] - PRIORITY_ORDER[right.priorityTier];
  if (tierDifference !== 0) return tierDifference;
  if (left.priorityTier === "P2" && left.failureRate !== right.failureRate) return right.failureRate - left.failureRate;
  if (left.priorityTier === "P3" && left.runCount !== right.runCount) return left.runCount - right.runCount;
  if (left.latestEndedAt !== right.latestEndedAt) return right.latestEndedAt - left.latestEndedAt;
  const titleDifference = left.title.localeCompare(right.title, "en");
  return titleDifference !== 0 ? titleDifference : left.seriesKey.localeCompare(right.seriesKey, "en");
}

function aggregateSettledGroups(
  stored: StoredActivity[],
  rangeStart: number,
  rangeEnd: number,
): { groupsByAgent: Record<string, SettledGroupSummary[]>; outcomeCounts: SettledOutcomeCounts; totalSeries: number } {
  const outcomeCounts = emptyOutcomeCounts();
  const grouped = new Map<string, StoredActivity[]>();
  for (const item of stored) {
    outcomeCounts[item.outcome] += 1;
    const seriesKey = fallbackSeriesKey(item);
    const runs = grouped.get(seriesKey) ?? [];
    runs.push(item);
    grouped.set(seriesKey, runs);
  }

  const groups = [...grouped.entries()].map(([seriesKey, runs]): SettledGroupSummary => {
    runs.sort((left, right) => terminalAt(right) - terminalAt(left) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"));
    const latest = runs[0]!;
    const counts = emptyOutcomeCounts();
    for (const run of runs) counts[run.outcome] += 1;
    const runCount = runs.length;
    return {
      seriesKey,
      groupingConfidence: "display_exact",
      agentId: latest.agentId,
      kind: latest.kind,
      title: latest.title,
      rangeStart,
      rangeEnd,
      runCount,
      succeededCount: counts.succeeded,
      failedCount: counts.failed,
      timedOutCount: counts.timed_out,
      cancelledCount: counts.cancelled,
      blockedCount: counts.blocked,
      unknownCount: counts.unknown,
      latestActivityId: latest.id,
      latestOutcome: latest.outcome,
      latestEndedAt: terminalAt(latest),
      failureRate: (counts.failed + counts.timed_out) / runCount,
      priorityTier: priorityTier(counts, latest.outcome, runCount),
    };
  });

  const groupsByAgent = Object.create(null) as Record<string, SettledGroupSummary[]>;
  const agentIds = [...new Set(groups.map((group) => group.agentId))].sort((left, right) => left.localeCompare(right, "en"));
  for (const agentId of agentIds) {
    groupsByAgent[agentId] = groups.filter((group) => group.agentId === agentId).sort(compareSettledGroups);
  }
  return { groupsByAgent, outcomeCounts, totalSeries: groups.length };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mergeEvidence(current: EvidenceState[], incoming: EvidenceState[]): EvidenceState[] {
  const bySource = new Map(current.map((evidence) => [evidence.source, evidence]));
  for (const evidence of incoming) {
    const previous = bySource.get(evidence.source);
    if (!previous || (evidence.observedAt ?? 0) >= (previous.observedAt ?? 0)) bySource.set(evidence.source, evidence);
  }
  return [...bySource.values()].sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0));
}

function rowToStored(row: ActivityRow): StoredActivity {
  return {
    id: String(row.id),
    kind: row.kind as StoredActivity["kind"],
    origin: row.origin as StoredActivity["origin"],
    catalog: row.catalog as StoredActivity["catalog"],
    sourceKey: String(row.source_key),
    ...(asString(row.task_id) ? { taskId: asString(row.task_id) } : {}),
    ...(asString(row.run_ref) ? { runRef: asString(row.run_ref) } : {}),
    ...(asString(row.session_key) ? { sessionKey: asString(row.session_key) } : {}),
    ...(asString(row.parent_task_id) ? { parentTaskId: asString(row.parent_task_id) } : {}),
    ...(asString(row.flow_id) ? { flowId: asString(row.flow_id) } : {}),
    agentId: String(row.agent_id),
    ...(asString(row.runtime) ? { runtime: asString(row.runtime) } : {}),
    title: String(row.title),
    state: row.state as StoredActivity["state"],
    outcome: row.outcome as StoredActivity["outcome"],
    phase: row.phase as StoredActivity["phase"],
    attention: row.attention as StoredActivity["attention"],
    stage: row.stage as StoredActivity["stage"],
    freshness: row.freshness as StoredActivity["freshness"],
    ...(asString(row.progress_summary) ? { progressSummary: asString(row.progress_summary) } : {}),
    ...(asString(row.last_tool_name) ? { lastToolName: asString(row.last_tool_name) } : {}),
    ...(asNumber(row.created_at) !== undefined ? { createdAt: asNumber(row.created_at) } : {}),
    ...(asNumber(row.started_at) !== undefined ? { startedAt: asNumber(row.started_at) } : {}),
    ...(asNumber(row.ended_at) !== undefined ? { endedAt: asNumber(row.ended_at) } : {}),
    updatedAt: Number(row.updated_at),
    lastObservedAt: Number(row.last_observed_at),
    evidence: parseJson(row.evidence_json, []),
  };
}

function publicItem(item: StoredActivity): ActivityItem {
  const { sourceKey: _sourceKey, taskId: _taskId, runRef: _runRef, sessionKey: _sessionKey, parentTaskId: _parentTaskId, ...view } = item;
  return view;
}

const DEFAULT_SESSION_COVERAGE: SessionCoverage = {
  index: "unavailable",
  detail: "not_observed",
  usage: "not_observed",
  messages: "not_observed",
};

function agentFingerprint(write: AgentWrite): string {
  return JSON.stringify([write.displayName, write.kind, write.runtime, write.model, write.origin]);
}

function sessionFingerprint(write: SessionWrite): string {
  return JSON.stringify([
    write.sessionId,
    write.agentId,
    write.label,
    write.runtime,
    write.model,
    write.category,
    write.kindHint,
    write.archived,
    write.hasActiveRun,
    write.placement,
    write.lineage,
    write.createdAt,
    write.coverage,
  ]);
}

function rowToAgent(row: ActivityRow): AgentSummary {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    kind: row.kind as AgentSummary["kind"],
    ...(asString(row.runtime) ? { runtime: asString(row.runtime) } : {}),
    ...(asString(row.model) ? { model: asString(row.model) } : {}),
    origin: row.origin as AgentSummary["origin"],
    firstObservedAt: Number(row.first_observed_at),
    ...(asNumber(row.last_activity_at) !== undefined ? { lastActivityAt: asNumber(row.last_activity_at) } : {}),
  };
}

function rowToSessionSummary(row: ActivityRow): SessionSummary {
  return {
    sessionKey: String(row.session_key),
    ...(asString(row.session_id) ? { sessionId: asString(row.session_id) } : {}),
    agentId: String(row.agent_id),
    label: String(row.label),
    ...(asString(row.runtime) ? { runtime: asString(row.runtime) } : {}),
    ...(asString(row.model) ? { model: asString(row.model) } : {}),
    ...(asString(row.category) ? { category: asString(row.category) } : {}),
    kindHint: row.kind_hint as SessionKindHint,
    archived: Number(row.archived) === 1,
    hasActiveRun: Number(row.has_active_run) === 1,
    ...(asString(row.placement) ? { placement: asString(row.placement) } : {}),
    ...(asNumber(row.created_at) !== undefined ? { createdAt: asNumber(row.created_at) } : {}),
    lastActivityAt: Number(row.last_activity_at),
    lastObservedAt: Number(row.last_observed_at),
    activityCount: Number(row.activity_count ?? 0),
    coverage: parseJson(row.coverage_json, DEFAULT_SESSION_COVERAGE),
  };
}

function rowToSessionRecord(row: ActivityRow): SessionRecord {
  return {
    ...rowToSessionSummary(row),
    lineage: {
      ...(asString(row.parent_session_key) ? { parentSessionKey: asString(row.parent_session_key) } : {}),
      ...(asString(row.previous_session_id) ? { previousSessionId: asString(row.previous_session_id) } : {}),
      ...(asString(row.fork_source_key) ? { forkSourceKey: asString(row.fork_source_key) } : {}),
      ...(asString(row.spawned_by) ? { spawnedBy: asString(row.spawned_by) } : {}),
      ...(asNumber(row.spawn_depth) !== undefined ? { spawnDepth: asNumber(row.spawn_depth) } : {}),
      ...(asString(row.subagent_role) ? { subagentRole: asString(row.subagent_role) } : {}),
      ...(asString(row.worktree_branch) ? { worktreeBranch: asString(row.worktree_branch) } : {}),
    },
  };
}

function coreFingerprint(item: ActivityWrite): string {
  return JSON.stringify({
    kind: item.kind,
    origin: item.origin,
    catalog: item.catalog,
    sourceKey: item.sourceKey,
    taskId: item.taskId,
    runRef: item.runRef,
    sessionKey: item.sessionKey,
    parentTaskId: item.parentTaskId,
    flowId: item.flowId,
    agentId: item.agentId,
    runtime: item.runtime,
    title: item.title,
    state: item.state,
    outcome: item.outcome,
    phase: item.phase,
    attention: item.attention,
    stage: item.stage,
    freshness: item.freshness,
    progressSummary: item.progressSummary,
    lastToolName: item.lastToolName,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
  });
}

function countStages(items: ActivityItem[]): StageCounts {
  const counts = { ...EMPTY_COUNTS };
  for (const item of items) {
    if (item.stage === "incoming") counts.incoming += 1;
    else if (item.stage === "in_flight") counts.inFlight += 1;
    else if (item.stage === "waiting") counts.waiting += 1;
    else if (item.stage === "settled") counts.settled += 1;
    else counts.unresolved += 1;
  }
  return counts;
}

function buildRelations(stored: StoredActivity[]): ActivityRelation[] {
  const relations: ActivityRelation[] = [];
  const relationKeys = new Set<string>();
  const tasksByTaskId = new Map<string, StoredActivity>();
  const tasksByRunRef = new Map<string, StoredActivity[]>();
  const attemptsByRunRef = new Map<string, StoredActivity[]>();

  for (const item of stored) {
    if (item.taskId) tasksByTaskId.set(item.taskId, item);
    if (item.runRef) {
      const target = item.kind === "task" ? tasksByRunRef : attemptsByRunRef;
      const rows = target.get(item.runRef) ?? [];
      rows.push(item);
      target.set(item.runRef, rows);
    }
  }

  const add = (relation: ActivityRelation): void => {
    const key = `${relation.type}:${relation.from}:${relation.to}`;
    if (relationKeys.has(key)) return;
    relationKeys.add(key);
    relations.push(relation);
  };

  for (const item of stored) {
    if (item.parentTaskId) {
      const parent = tasksByTaskId.get(item.parentTaskId);
      if (parent) {
        add({
          type: "parent_task",
          from: parent.id,
          to: item.id,
          certainty: "exact",
          label: "parent task",
        });
      }
    }
  }

  for (const [runRef, tasks] of tasksByRunRef) {
    for (const task of tasks) {
      for (const attempt of attemptsByRunRef.get(runRef) ?? []) {
        add({
          type: "run_correlation",
          from: task.id,
          to: attempt.id,
          certainty: "correlation_only",
          label: "shared run reference",
        });
      }
    }
  }

  return relations;
}

export class CollectorRepository {
  readonly epoch = randomUUID();
  readonly migration: MigrationResult;
  /** The only permitted write path for session transcripts. */
  readonly transcripts: TranscriptArchive;
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(change: RepositoryChange) => void>();
  private readonly findFingerprint: StatementSync;
  private readonly upsertActivity: StatementSync;
  private readonly insertObservation: StatementSync;
  private currentRevision = 0;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");
    this.migration = applyMigrations(this.db, databasePath);
    this.transcripts = new TranscriptArchive(this.db);
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('epoch', ?)").run(this.epoch);
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('revision', '0')").run();

    this.findFingerprint = this.db.prepare("SELECT fingerprint, evidence_json FROM activities WHERE id = ?");
    this.upsertActivity = this.db.prepare(`
      INSERT INTO activities (
        id, source_key, kind, origin, catalog, task_id, run_ref, session_key, parent_task_id, flow_id,
        agent_id, runtime, title, state, outcome, phase, attention, stage, freshness,
        progress_summary, last_tool_name, created_at, started_at, ended_at, updated_at,
        last_observed_at, evidence_json, fingerprint
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        source_key = excluded.source_key,
        kind = excluded.kind,
        origin = excluded.origin,
        catalog = excluded.catalog,
        task_id = excluded.task_id,
        run_ref = COALESCE(excluded.run_ref, activities.run_ref),
        session_key = COALESCE(excluded.session_key, activities.session_key),
        parent_task_id = COALESCE(excluded.parent_task_id, activities.parent_task_id),
        flow_id = COALESCE(excluded.flow_id, activities.flow_id),
        agent_id = excluded.agent_id,
        runtime = COALESCE(excluded.runtime, activities.runtime),
        title = excluded.title,
        state = excluded.state,
        outcome = excluded.outcome,
        phase = excluded.phase,
        attention = excluded.attention,
        stage = excluded.stage,
        freshness = excluded.freshness,
        progress_summary = COALESCE(excluded.progress_summary, activities.progress_summary),
        last_tool_name = COALESCE(excluded.last_tool_name, activities.last_tool_name),
        created_at = COALESCE(excluded.created_at, activities.created_at),
        started_at = COALESCE(excluded.started_at, activities.started_at),
        ended_at = COALESCE(excluded.ended_at, activities.ended_at),
        updated_at = MAX(excluded.updated_at, activities.updated_at),
        last_observed_at = MAX(excluded.last_observed_at, activities.last_observed_at),
        evidence_json = excluded.evidence_json,
        fingerprint = excluded.fingerprint
    `);
    this.insertObservation = this.db.prepare(`
      INSERT INTO observations(activity_id, source, kind, phase, status, tool_name, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.repairSessionAgentAttribution();
  }

  get revision(): number {
    return this.currentRevision;
  }

  close(): void {
    this.db.close();
  }

  subscribe(listener: (change: RepositoryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private repairSessionAgentAttribution(observedAt = Date.now()): RepositoryChange | null {
    const candidates = this.db
      .prepare("SELECT id, session_key FROM activities WHERE agent_id = 'Unattributed' AND session_key IS NOT NULL")
      .all() as Array<{ id: string; session_key: string }>;
    const repairs = candidates.flatMap((row) => {
      const agentId = agentIdFromSessionKey(row.session_key);
      return agentId ? [{ ...row, agentId }] : [];
    });
    if (repairs.length === 0) return null;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(`
        UPDATE activities
        SET agent_id = ?, last_observed_at = MAX(last_observed_at, ?),
            fingerprint = fingerprint || ':agent-backfill:' || ?
        WHERE id = ? AND agent_id = 'Unattributed'
      `);
      for (const repair of repairs) {
        update.run(repair.agentId, observedAt, repair.agentId, repair.id);
        this.insertObservation.run(repair.id, "collector", "session_agent_backfill", null, repair.agentId, null, observedAt);
      }
      this.bumpRevision();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.emit(repairs.map((repair) => repair.id), ["session_agent_backfill"]);
  }

  upsertMany(writes: ActivityWrite[], reasons: string[]): RepositoryChange | null {
    if (writes.length === 0) return null;
    const changedIds = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        const fingerprint = coreFingerprint(write);
        const existing = this.findFingerprint.get(write.id) as { fingerprint?: string; evidence_json?: string } | undefined;
        const meaningfullyChanged = existing?.fingerprint !== fingerprint;
        const evidence = mergeEvidence(parseJson(existing?.evidence_json, []), write.evidence);
        this.upsertActivity.run(
          write.id,
          write.sourceKey,
          write.kind,
          write.origin,
          write.catalog,
          write.taskId ?? null,
          write.runRef ?? null,
          write.sessionKey ?? null,
          write.parentTaskId ?? null,
          write.flowId ?? null,
          write.agentId,
          write.runtime ?? null,
          write.title,
          write.state,
          write.outcome,
          write.phase,
          write.attention,
          write.stage,
          write.freshness,
          write.progressSummary ?? null,
          write.lastToolName ?? null,
          write.createdAt ?? null,
          write.startedAt ?? null,
          write.endedAt ?? null,
          write.updatedAt,
          write.lastObservedAt,
          JSON.stringify(evidence),
          fingerprint,
        );
        if (meaningfullyChanged || write.observation?.source === "events") {
          changedIds.add(write.id);
          if (write.observation) {
            this.insertObservation.run(
              write.id,
              write.observation.source,
              write.observation.kind,
              write.observation.phase ?? null,
              write.observation.status ?? null,
              write.observation.toolName ?? null,
              write.observation.occurredAt,
            );
          }
        }
      }
      if (changedIds.size > 0) this.bumpRevision();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (changedIds.size === 0) return null;
    return this.emit([...changedIds], reasons);
  }

  markMissingTasks(seenSourceKeys: Set<string>, observedAt: number): RepositoryChange | null {
    const activeRows = this.db
      .prepare("SELECT id, source_key FROM activities WHERE kind = 'task' AND catalog = 'operational'")
      .all() as Array<{ id: string; source_key: string }>;
    const missing = activeRows.filter((row) => !seenSourceKeys.has(row.source_key));
    if (missing.length === 0) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare(`
        UPDATE activities
        SET state = 'unknown', outcome = 'unknown', phase = 'unknown', attention = 'partial',
            stage = 'unresolved', freshness = 'stale', last_observed_at = ?,
            fingerprint = fingerprint || ':missing:' || ?
        WHERE id = ?
      `);
      for (const row of missing) statement.run(observedAt, observedAt, row.id);
      this.bumpRevision();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.emit(
      missing.map((row) => row.id),
      ["task_snapshot_missing"],
    );
  }

  closeSessionAttempts(activeSourceKeys: Set<string>, observedAt: number): RepositoryChange | null {
    const rows = this.db
      .prepare("SELECT id, source_key FROM activities WHERE kind = 'attempt' AND state = 'active' AND session_key IS NOT NULL")
      .all() as Array<{ id: string; source_key: string }>;
    const closed = rows.filter((row) => !activeSourceKeys.has(row.source_key));
    if (closed.length === 0) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare(`
        UPDATE activities
        SET state = 'terminal', catalog = 'terminal_history', outcome = 'unknown', phase = 'none',
            attention = 'none', stage = 'settled', freshness = 'live', ended_at = ?, updated_at = ?,
            last_observed_at = ?, fingerprint = fingerprint || ':closed:' || ?
        WHERE id = ?
      `);
      for (const row of closed) statement.run(observedAt, observedAt, observedAt, observedAt, row.id);
      this.bumpRevision();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.emit(
      closed.map((row) => row.id),
      ["session_snapshot_inactive"],
    );
  }

  findOpenAttempt(params: { runRef?: string; sessionKey?: string }): StoredActivity | undefined {
    if (params.runRef) {
      const row = this.db
        .prepare("SELECT * FROM activities WHERE kind = 'attempt' AND state = 'active' AND run_ref = ? ORDER BY updated_at DESC LIMIT 1")
        .get(params.runRef) as ActivityRow | undefined;
      if (row) return rowToStored(row);
    }
    if (params.sessionKey) {
      const rows = this.db
        .prepare(`
          SELECT * FROM activities
          WHERE kind = 'attempt' AND state = 'active' AND session_key = ?
            ${params.runRef ? "AND run_ref IS NULL" : ""}
          ORDER BY updated_at DESC
          LIMIT 2
        `)
        .all(params.sessionKey) as ActivityRow[];
      if (rows.length === 1) return rowToStored(rows[0]!);
    }
    return undefined;
  }

  findOpenAttemptsBySessionKey(sessionKey: string): StoredActivity[] {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE kind = 'attempt' AND state = 'active' AND session_key = ? ORDER BY updated_at DESC")
      .all(sessionKey) as ActivityRow[];
    return rows.map(rowToStored);
  }

  findBySourceKey(sourceKey: string): StoredActivity | undefined {
    const row = this.db.prepare("SELECT * FROM activities WHERE source_key = ?").get(sourceKey) as ActivityRow | undefined;
    return row ? rowToStored(row) : undefined;
  }

  list(recentTerminalLimit = 200): StoredActivity[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM activities
        WHERE catalog = 'operational'
        UNION ALL
        SELECT * FROM (
          SELECT * FROM activities WHERE catalog = 'terminal_history' ORDER BY updated_at DESC LIMIT ?
        )
        ORDER BY updated_at DESC
      `)
      .all(recentTerminalLimit) as ActivityRow[];
    return rows.map(rowToStored);
  }

  snapshotViews(recentTerminalLimit = 200): {
    items: ActivityItem[];
    relations: ActivityRelation[];
    summary: StageCounts;
    lanes: LaneSummary[];
  } {
    const stored = this.list(recentTerminalLimit);
    const items = stored.map(publicItem);
    const byAgent = new Map<string, ActivityItem[]>();
    for (const item of items) {
      const lane = byAgent.get(item.agentId) ?? [];
      lane.push(item);
      byAgent.set(item.agentId, lane);
    }
    const lanes = [...byAgent.entries()]
      .map(([key, laneItems]) => ({
        key,
        label: key,
        counts: countStages(laneItems),
        attention: laneItems.filter((item) => item.attention !== "none").length,
      }))
      .sort((a, b) => b.attention - a.attention || a.label.localeCompare(b.label));
    return {
      items,
      relations: buildRelations(stored),
      summary: countStages(items),
      lanes,
    };
  }

  settledGroups(range: SettledRange, rangeEnd = Date.now(), complete = true): SettledGroupSnapshot {
    const rangeStart = rangeEnd - settledRangeDuration(range);
    const stored = this.listSettledInRange(rangeStart, rangeEnd);
    const aggregation = aggregateSettledGroups(stored, rangeStart, rangeEnd);
    return {
      apiVersion: 1,
      epoch: this.epoch,
      revision: this.currentRevision,
      generatedAt: Date.now(),
      range,
      rangeStart,
      rangeEnd,
      complete,
      totalSeries: aggregation.totalSeries,
      totalRuns: stored.length,
      outcomeCounts: aggregation.outcomeCounts,
      groupsByAgent: aggregation.groupsByAgent,
    };
  }

  settledSeriesRuns(
    seriesKey: string,
    range: SettledRange,
    rangeEnd = Date.now(),
    complete = true,
  ): SettledSeriesRuns | undefined {
    const rangeStart = rangeEnd - settledRangeDuration(range);
    const stored = this.listSettledInRange(rangeStart, rangeEnd);
    const aggregation = aggregateSettledGroups(stored, rangeStart, rangeEnd);
    const group = Object.values(aggregation.groupsByAgent).flat().find((candidate) => candidate.seriesKey === seriesKey);
    if (!group) return undefined;
    const runs = stored
      .filter((item) => fallbackSeriesKey(item) === seriesKey)
      .sort((left, right) => terminalAt(right) - terminalAt(left) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"))
      .map((item) => ({
        id: item.id,
        agentId: item.agentId,
        kind: item.kind,
        title: item.title,
        outcome: item.outcome,
        terminalAt: terminalAt(item),
        updatedAt: item.updatedAt,
      }));
    return {
      apiVersion: 1,
      epoch: this.epoch,
      revision: this.currentRevision,
      range,
      rangeStart,
      rangeEnd,
      complete,
      group,
      runs,
    };
  }

  detail(id: string): ActivityDetail | undefined {
    const row = this.db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as ActivityRow | undefined;
    if (!row) return undefined;
    const item = rowToStored(row);
    const all = this.list(500);
    const relations = buildRelations(all).filter((relation) => relation.from === id || relation.to === id);
    const relatedIds = new Set(relations.flatMap((relation) => [relation.from, relation.to]).filter((relationId) => relationId !== id));
    const observations = this.db
      .prepare("SELECT * FROM observations WHERE activity_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 100")
      .all(id) as ActivityRow[];
    const timeline: ObservationView[] = observations.map((observation) => ({
      id: Number(observation.id),
      source: observation.source as ObservationView["source"],
      kind: String(observation.kind),
      ...(asString(observation.phase) ? { phase: observation.phase as ObservationView["phase"] } : {}),
      ...(asString(observation.status) ? { status: asString(observation.status) } : {}),
      ...(asString(observation.tool_name) ? { toolName: asString(observation.tool_name) } : {}),
      occurredAt: Number(observation.occurred_at),
    }));
    return {
      epoch: this.epoch,
      revision: this.currentRevision,
      item: publicItem(item),
      identity: {
        ...(item.taskId ? { taskId: item.taskId } : {}),
        ...(item.runRef ? { runRef: item.runRef } : {}),
        ...(item.sessionKey ? { sessionKey: item.sessionKey } : {}),
        ...(item.flowId ? { flowId: item.flowId } : {}),
        ...(item.parentTaskId ? { parentTaskId: item.parentTaskId } : {}),
      },
      relations,
      related: all.filter((candidate) => relatedIds.has(candidate.id)).map(publicItem),
      timeline,
    };
  }

  /**
   * Agent roster upsert. An authoritative `roster` entry is never downgraded to
   * `observed` by a later inference, and `runtime`/`model` are only widened so a
   * partial observation cannot erase known facts.
   */
  upsertAgents(writes: AgentWrite[]): number {
    if (writes.length === 0) return 0;
    const statement = this.db.prepare(`
      INSERT INTO agents (
        id, display_name, kind, runtime, model, origin, first_observed_at, last_activity_at, fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        kind = excluded.kind,
        runtime = COALESCE(excluded.runtime, agents.runtime),
        model = COALESCE(excluded.model, agents.model),
        origin = CASE WHEN excluded.origin = 'roster' THEN 'roster' ELSE agents.origin END,
        first_observed_at = MIN(excluded.first_observed_at, agents.first_observed_at),
        last_activity_at = CASE
          WHEN excluded.last_activity_at IS NULL THEN agents.last_activity_at
          WHEN agents.last_activity_at IS NULL THEN excluded.last_activity_at
          ELSE MAX(excluded.last_activity_at, agents.last_activity_at)
        END,
        fingerprint = excluded.fingerprint
    `);
    const findFingerprint = this.db.prepare("SELECT fingerprint FROM agents WHERE id = ?");
    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        const fingerprint = agentFingerprint(write);
        const existing = findFingerprint.get(write.id) as { fingerprint?: string } | undefined;
        if (existing?.fingerprint !== fingerprint) changed += 1;
        statement.run(
          write.id,
          write.displayName,
          write.kind,
          write.runtime ?? null,
          write.model ?? null,
          write.origin,
          write.observedAt,
          write.lastActivityAt ?? null,
          fingerprint,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (changed > 0) {
      this.bumpRevision();
      this.emit([], ["agents_upserted"], ["agents"]);
    }
    return changed;
  }

  listAgents(): AgentSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY COALESCE(last_activity_at, first_observed_at) DESC, id ASC")
      .all() as ActivityRow[];
    return rows.map(rowToAgent);
  }

  /**
   * Session archive upsert.
   *
   * Current-truth fields (label, archived, active run, category, placement hint)
   * take the incoming value. Write-once lineage facts are merged with COALESCE
   * because Gateway rows can omit them, and a partial observation must not erase
   * a fork source or subagent role that was already established.
   */
  upsertSessions(writes: SessionWrite[]): number {
    if (writes.length === 0) return 0;
    const statement = this.db.prepare(`
      INSERT INTO sessions (
        session_key, session_id, agent_id, label, runtime, model, category, kind_hint,
        archived, has_active_run, placement, parent_session_key, previous_session_id,
        fork_source_key, spawned_by, spawn_depth, subagent_role, worktree_branch,
        created_at, last_activity_at, last_observed_at, coverage_json, fingerprint
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
      ON CONFLICT(session_key) DO UPDATE SET
        session_id = COALESCE(excluded.session_id, sessions.session_id),
        agent_id = excluded.agent_id,
        label = excluded.label,
        runtime = COALESCE(excluded.runtime, sessions.runtime),
        model = COALESCE(excluded.model, sessions.model),
        category = excluded.category,
        kind_hint = excluded.kind_hint,
        archived = excluded.archived,
        has_active_run = excluded.has_active_run,
        placement = COALESCE(excluded.placement, sessions.placement),
        parent_session_key = COALESCE(excluded.parent_session_key, sessions.parent_session_key),
        previous_session_id = COALESCE(excluded.previous_session_id, sessions.previous_session_id),
        fork_source_key = COALESCE(excluded.fork_source_key, sessions.fork_source_key),
        spawned_by = COALESCE(excluded.spawned_by, sessions.spawned_by),
        spawn_depth = COALESCE(excluded.spawn_depth, sessions.spawn_depth),
        subagent_role = COALESCE(excluded.subagent_role, sessions.subagent_role),
        worktree_branch = COALESCE(excluded.worktree_branch, sessions.worktree_branch),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        last_activity_at = MAX(excluded.last_activity_at, sessions.last_activity_at),
        last_observed_at = MAX(excluded.last_observed_at, sessions.last_observed_at),
        coverage_json = excluded.coverage_json,
        fingerprint = excluded.fingerprint
    `);
    const findFingerprint = this.db.prepare("SELECT fingerprint FROM sessions WHERE session_key = ?");
    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        const fingerprint = sessionFingerprint(write);
        const existing = findFingerprint.get(write.sessionKey) as { fingerprint?: string } | undefined;
        if (existing?.fingerprint !== fingerprint) changed += 1;
        statement.run(
          write.sessionKey,
          write.sessionId ?? null,
          write.agentId,
          write.label,
          write.runtime ?? null,
          write.model ?? null,
          write.category ?? null,
          write.kindHint,
          write.archived ? 1 : 0,
          write.hasActiveRun ? 1 : 0,
          write.placement ?? null,
          write.lineage.parentSessionKey ?? null,
          write.lineage.previousSessionId ?? null,
          write.lineage.forkSourceKey ?? null,
          write.lineage.spawnedBy ?? null,
          write.lineage.spawnDepth ?? null,
          write.lineage.subagentRole ?? null,
          write.lineage.worktreeBranch ?? null,
          write.createdAt ?? null,
          write.lastActivityAt,
          write.observedAt,
          JSON.stringify(write.coverage),
          fingerprint,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // Reconciles run every few seconds and are usually no-ops, so only a real
    // fingerprint change earns a revision bump and an invalidate frame.
    if (changed > 0) {
      this.bumpRevision();
      this.emit([], ["sessions_upserted"], ["sessions"]);
    }
    return changed;
  }

  getSession(sessionKey: string): SessionRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT s.*, (SELECT COUNT(*) FROM activities a WHERE a.session_ref = s.session_key) AS activity_count
        FROM sessions s WHERE s.session_key = ?
      `)
      .get(sessionKey) as ActivityRow | undefined;
    return row ? rowToSessionRecord(row) : undefined;
  }

  listSessions(query: SessionListQuery = {}): SessionSummary[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.agentId !== undefined) {
      conditions.push("s.agent_id = ?");
      parameters.push(query.agentId);
    }
    if (query.includeArchived !== true) conditions.push("s.archived = 0");
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    parameters.push(query.limit ?? 100);
    const rows = this.db
      .prepare(`
        SELECT s.*, (SELECT COUNT(*) FROM activities a WHERE a.session_ref = s.session_key) AS activity_count
        FROM sessions s
        ${where}
        ORDER BY s.last_activity_at DESC, s.session_key ASC
        LIMIT ?
      `)
      .all(...parameters) as ActivityRow[];
    return rows.map(rowToSessionSummary);
  }

  /**
   * Keyset-paginated session list.
   *
   * Fetches one row beyond the limit to decide whether a next page exists,
   * which avoids a second COUNT query whose answer would already be stale by
   * the time the page is served.
   */
  listSessionsPage(query: SessionPageQuery): SessionPage {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];

    if (query.agentId !== undefined) {
      conditions.push("s.agent_id = ?");
      parameters.push(query.agentId);
    }
    if (query.state === "active") conditions.push("s.archived = 0 AND s.has_active_run = 1");
    else if (query.state === "terminal") conditions.push("s.archived = 0 AND s.has_active_run = 0");
    else if (query.state === "archived") conditions.push("s.archived = 1");
    if (query.since !== undefined) {
      conditions.push("s.last_activity_at >= ?");
      parameters.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push("s.last_activity_at <= ?");
      parameters.push(query.until);
    }

    // Sorting on an expression requires the cursor comparison to repeat that
    // exact expression, so both are derived from one definition.
    const sortExpression =
      query.sort === "duration" ? "(s.last_activity_at - COALESCE(s.created_at, s.last_activity_at))" : "s.last_activity_at";

    if (query.cursor) {
      // Strict inequality on the tiebreaker prevents re-emitting the boundary row.
      conditions.push(`(${sortExpression} < ? OR (${sortExpression} = ? AND s.session_key > ?))`);
      parameters.push(query.cursor.value, query.cursor.value, query.cursor.sessionKey);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    parameters.push(query.limit + 1);

    const rows = this.db
      .prepare(`
        SELECT s.*, ${sortExpression} AS sort_value,
               (SELECT COUNT(*) FROM activities a WHERE a.session_ref = s.session_key) AS activity_count
        FROM sessions s
        ${where}
        ORDER BY sort_value DESC, s.session_key ASC
        LIMIT ?
      `)
      .all(...parameters) as ActivityRow[];

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const items = page.map(rowToSessionSummary);
    const last = page.at(-1);
    if (!hasMore || !last) return { items };

    return {
      items,
      nextCursor: encodeCursor({
        sort: query.sort,
        value: Number(last.sort_value ?? 0),
        sessionKey: String(last.session_key),
      }),
    };
  }

  /**
   * Roster joined with per-agent session counts.
   *
   * Aggregated in SQL rather than by loading sessions into memory, because the
   * roster is small but the session archive is not bounded by the UI's page size.
   */
  listAgentOverviews(rangeEnd = Date.now()): AgentOverview[] {
    const rows = this.db
      .prepare(`
        SELECT a.*,
               COUNT(s.session_key) AS session_count,
               COALESCE(SUM(CASE WHEN s.has_active_run = 1 AND s.archived = 0 THEN 1 ELSE 0 END), 0) AS active_count,
               COALESCE(SUM(CASE WHEN s.archived = 1 THEN 1 ELSE 0 END), 0) AS archived_count,
               MAX(s.last_activity_at) AS last_session_activity_at
        FROM agents a
        LEFT JOIN sessions s ON s.agent_id = a.id
        GROUP BY a.id
        ORDER BY COALESCE(MAX(s.last_activity_at), a.last_activity_at, a.first_observed_at) DESC, a.id ASC
      `)
      .all() as ActivityRow[];

    const activityCounts = new Map<string, number>(
      (this.db.prepare("SELECT agent_id, COUNT(*) AS c FROM activities GROUP BY agent_id").all() as ActivityRow[]).map(
        (row) => [String(row.agent_id), Number(row.c ?? 0)],
      ),
    );

    const recent = {
      "24h": this.agentRollups("24h", rangeEnd),
      "7d": this.agentRollups("7d", rangeEnd),
    };

    return rows.map((row) => {
      const id = String(row.id);
      return {
        ...rowToAgent(row),
        sessionCount: Number(row.session_count ?? 0),
        activeSessionCount: Number(row.active_count ?? 0),
        archivedSessionCount: Number(row.archived_count ?? 0),
        activityCount: activityCounts.get(id) ?? 0,
        ...(asNumber(row.last_session_activity_at) !== undefined
          ? { lastSessionActivityAt: asNumber(row.last_session_activity_at) }
          : {}),
        recent: {
          "24h": recent["24h"].get(id) ?? emptyRollup(),
          "7d": recent["7d"].get(id) ?? emptyRollup(),
        },
      };
    });
  }

  /**
   * Terminal-activity rollup per agent for one window.
   *
   * Duration is averaged only over runs that reported both a start and an end.
   * Falling back to `updated_at` would let the reconcile cadence, rather than
   * the run, decide the number.
   */
  private agentRollups(window: AgentRollupWindow, rangeEnd: number): Map<string, AgentActivityRollup> {
    const rangeStart = rangeEnd - AGENT_ROLLUP_WINDOW_MS[window];
    const rows = this.db
      .prepare(`
        SELECT agent_id,
               outcome,
               COUNT(*) AS run_count,
               SUM(CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= started_at
                        THEN 1 ELSE 0 END) AS duration_samples,
               SUM(CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= started_at
                        THEN ended_at - started_at ELSE 0 END) AS duration_total
        FROM activities
        WHERE state = 'terminal'
          AND COALESCE(ended_at, updated_at) >= ?
          AND COALESCE(ended_at, updated_at) <= ?
        GROUP BY agent_id, outcome
      `)
      .all(rangeStart, rangeEnd) as ActivityRow[];

    const byAgent = new Map<string, AgentActivityRollup>();
    const durationTotals = new Map<string, number>();

    for (const row of rows) {
      const agentId = String(row.agent_id);
      const rollup = byAgent.get(agentId) ?? emptyRollup();
      const runCount = Number(row.run_count ?? 0);
      rollup.completed += runCount;
      switch (row.outcome as ActivityOutcome) {
        case "succeeded": rollup.succeeded += runCount; break;
        case "failed": rollup.failed += runCount; break;
        case "cancelled": rollup.cancelled += runCount; break;
        case "timed_out": rollup.timedOut += runCount; break;
        case "blocked": rollup.blocked += runCount; break;
        case "unknown": rollup.unknown += runCount; break;
        case "none": break;
        default: {
          const exhaustive: never = row.outcome as never;
          throw new Error(`Unhandled activity outcome: ${String(exhaustive)}`);
        }
      }
      rollup.durationSampleCount += Number(row.duration_samples ?? 0);
      durationTotals.set(agentId, (durationTotals.get(agentId) ?? 0) + Number(row.duration_total ?? 0));
      byAgent.set(agentId, rollup);
    }

    for (const [agentId, rollup] of byAgent) {
      if (rollup.completed > 0) rollup.successRate = rollup.succeeded / rollup.completed;
      if (rollup.durationSampleCount > 0) {
        rollup.avgDurationMs = Math.round((durationTotals.get(agentId) ?? 0) / rollup.durationSampleCount);
      }
    }
    return byAgent;
  }

  getAgentOverview(agentId: string, rangeEnd = Date.now()): AgentOverview | undefined {
    return this.listAgentOverviews(rangeEnd).find((agent) => agent.id === agentId);
  }

  /** Activity timeline for one session, newest first. */
  listSessionActivities(sessionKey: string, limit = 200): StoredActivity[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM activities
        WHERE session_ref = ? OR session_key = ?
        ORDER BY last_observed_at DESC, id ASC
        LIMIT ?
      `)
      .all(sessionKey, sessionKey, limit) as ActivityRow[];
    return rows.map(rowToStored);
  }

  /**
   * Promotes claimed `session_key` values to confirmed `session_ref` foreign keys
   * once the matching Session row exists. Activities whose session has not been
   * observed yet keep a null ref, which is a legitimate state rather than an error.
   */
  linkActivitySessions(): number {
    const result = this.db
      .prepare(`
        UPDATE activities
        SET session_ref = session_key
        WHERE session_ref IS NULL
          AND session_key IS NOT NULL
          AND session_key IN (SELECT session_key FROM sessions)
      `)
      .run();
    return Number(result.changes);
  }

  prune(cutoff: number): number {
    const result = this.db
      .prepare("DELETE FROM activities WHERE catalog = 'terminal_history' AND updated_at < ?")
      .run(cutoff);
    this.db.prepare("DELETE FROM observations WHERE activity_id NOT IN (SELECT id FROM activities)").run();
    return Number(result.changes);
  }

  /**
   * Session archives outlive terminal Activity on purpose, so only archived
   * sessions age out. Foreign keys are declared but not enforced, so dangling
   * refs are cleared explicitly.
   */
  pruneSessions(cutoff: number): number {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE archived = 1 AND last_activity_at < ?")
      .run(cutoff);
    if (Number(result.changes) > 0) {
      this.db
        .prepare(`
          UPDATE activities SET session_ref = NULL
          WHERE session_ref IS NOT NULL
            AND session_ref NOT IN (SELECT session_key FROM sessions)
        `)
        .run();
    }
    return Number(result.changes);
  }

  private listSettledInRange(rangeStart: number, rangeEnd: number): StoredActivity[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM activities
        WHERE catalog = 'terminal_history'
          AND state = 'terminal'
          AND COALESCE(ended_at, updated_at) >= ?
          AND COALESCE(ended_at, updated_at) <= ?
        ORDER BY COALESCE(ended_at, updated_at) DESC, updated_at DESC, id ASC
      `)
      .all(rangeStart, rangeEnd) as ActivityRow[];
    return rows.map(rowToStored);
  }

  private bumpRevision(): void {
    this.currentRevision += 1;
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(this.currentRevision));
  }

  private emit(ids: string[], reasons: string[], topics: ChangeTopic[] = ["activities"]): RepositoryChange {
    const change = { epoch: this.epoch, revision: this.currentRevision, topics, ids, reasons };
    for (const listener of this.listeners) listener(change);
    return change;
  }
}
