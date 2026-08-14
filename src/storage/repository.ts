import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  ActivityDetail,
  ActivityItem,
  ActivityRelation,
  EvidenceState,
  LaneSummary,
  ObservationView,
  SettledGroupSnapshot,
  SettledGroupSummary,
  SettledOutcomeCounts,
  SettledPriorityTier,
  SettledRange,
  SettledSeriesRuns,
  StageCounts,
} from "../contracts.js";
import type { ActivityWrite } from "../activity/projector.js";

export type RepositoryChange = {
  epoch: string;
  revision: number;
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

type ActivityRow = Record<string, unknown>;

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        catalog TEXT NOT NULL,
        task_id TEXT,
        run_ref TEXT,
        session_key TEXT,
        parent_task_id TEXT,
        flow_id TEXT,
        agent_id TEXT NOT NULL,
        runtime TEXT,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT NOT NULL,
        phase TEXT NOT NULL,
        attention TEXT NOT NULL,
        stage TEXT NOT NULL,
        freshness TEXT NOT NULL,
        progress_summary TEXT,
        last_tool_name TEXT,
        created_at INTEGER,
        started_at INTEGER,
        ended_at INTEGER,
        updated_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activities_run_ref ON activities(run_ref);
      CREATE INDEX IF NOT EXISTS idx_activities_session_key ON activities(session_key);
      CREATE INDEX IF NOT EXISTS idx_activities_updated_at ON activities(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activities_terminal_at
        ON activities(catalog, COALESCE(ended_at, updated_at) DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        phase TEXT,
        status TEXT,
        tool_name TEXT,
        occurred_at INTEGER NOT NULL,
        FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_activity ON observations(activity_id, occurred_at DESC);
    `);
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

  prune(cutoff: number): number {
    const result = this.db
      .prepare("DELETE FROM activities WHERE catalog = 'terminal_history' AND updated_at < ?")
      .run(cutoff);
    this.db.prepare("DELETE FROM observations WHERE activity_id NOT IN (SELECT id FROM activities)").run();
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

  private emit(ids: string[], reasons: string[]): RepositoryChange {
    const change = { epoch: this.epoch, revision: this.currentRevision, ids, reasons };
    for (const listener of this.listeners) listener(change);
    return change;
  }
}
