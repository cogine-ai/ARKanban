import type {
  ActivityDetail,
  ActivityPhase,
  ActivitySnapshot,
  CollectorStatus,
  CollectorSyncState,
  SettledGroupSnapshot,
  SettledRange,
  SettledSeriesRuns,
  SourceCoverage,
  UpcomingScheduleSnapshot,
} from "../contracts.js";
import type { ResolvedCollectorConfig } from "../config.js";
import {
  agentIdFromSessionKey,
  attemptPatch,
  newAttemptActivityId,
  numberField,
  sessionAgentId,
  sessionIsActive,
  sessionKey,
  sessionRunRefs,
  sessionTitle,
  stringField,
  taskToActivity,
  type ActivityWrite,
  type RawSessionRow,
  type RawTaskSummary,
} from "../activity/projector.js";
import {
  RawGatewayClient,
  type GatewayConnectionState,
  type GatewayEventFrame,
  type GatewayHello,
} from "../gateway/adapter.js";
import {
  CollectorRepository,
  settledRangeDuration,
  type RepositoryChange,
  type StoredActivity,
} from "../storage/repository.js";
import {
  DUE_GRACE_MINUTES,
  scheduleAgentIds,
  selectUpcomingSchedules,
  UPCOMING_WINDOW_MINUTES,
} from "./upcoming-schedules.js";
import { inferAgents, projectAgent, projectSession } from "../activity/session-projector.js";
import { CapabilityRegistry, type CapabilityState } from "./capability-probe.js";
import {
  classifyHistoryFailure,
  TRANSCRIPT_SYNC_MS,
  TranscriptSynchronizer,
  type TranscriptSyncOutcome,
} from "./transcript-sync.js";
import { FieldInventory, type FieldInventoryReport } from "./field-inventory.js";

const REQUIRED_METHODS = ["tasks.list", "sessions.list", "sessions.subscribe"] as const;
const SCHEDULE_RECONCILE_MS = 60_000;
const CRON_PAGE_LIMIT = 200;
const AGENT_RECONCILE_MS = 300_000;

type StatusListener = (status: CollectorStatus) => void;
type ChangeListener = (change: RepositoryChange) => void;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : [];
}

function source(name: SourceCoverage["source"]): SourceCoverage {
  return { source: name, state: "offline" };
}

function nowOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function lifecycleOutcome(data: Record<string, unknown>): "failed" | "cancelled" | "timed_out" | "unknown" {
  if (data.aborted === true) return "cancelled";
  const reason = stringField(data, "stopReason")?.toLowerCase() ?? "";
  const error = stringField(data, "error")?.toLowerCase() ?? "";
  if (reason.includes("timeout") || error.includes("timed out") || error.includes("timeout")) return "timed_out";
  if (error) return "failed";
  return "unknown";
}

function phaseForStream(stream: string, data: Record<string, unknown>): ActivityPhase {
  if (stream === "tool") {
    const name = stringField(data, "name")?.toLowerCase() ?? "";
    return name.includes("approval") ? "waiting_approval" : "tool";
  }
  if (stream === "thinking" || stream === "reasoning" || stream === "planning") return "planning";
  if (stream === "assistant" || stream === "model" || stream === "text") return "model";
  if (stream === "lifecycle" && stringField(data, "phase") === "start") return "starting";
  return "unknown";
}

export class CollectorRuntime {
  readonly repository: CollectorRepository;
  readonly startedAt = Date.now();
  private readonly gateway: RawGatewayClient;
  private readonly sources = new Map<SourceCoverage["source"], SourceCoverage>([
    ["tasks", source("tasks")],
    ["sessions", source("sessions")],
    ["events", source("events")],
  ]);
  private readonly statusListeners = new Set<StatusListener>();
  private readonly changeListeners = new Set<ChangeListener>();
  private taskTimer?: NodeJS.Timeout;
  private sessionTimer?: NodeJS.Timeout;
  private scheduleTimer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;
  private agentTimer?: NodeJS.Timeout;
  private transcriptTimer?: NodeJS.Timeout;
  private taskSyncing = false;
  private sessionSyncing = false;
  private scheduleSyncing = false;
  private agentSyncing = false;
  private transcriptSyncing = false;
  private readonly capabilities = new CapabilityRegistry();
  private readonly sessionFields = new FieldInventory("sessions.list");
  private readonly agentFields = new FieldInventory("agents.list");
  private readonly messageFields = new FieldInventory("chat.history");
  private readonly transcripts: TranscriptSynchronizer;
  private transcriptStatus: TranscriptSyncOutcome | undefined;
  private sessionArchiveError?: string;
  private syncState: CollectorSyncState = "starting";
  private syncReasons: string[] = ["collector_starting"];
  private gatewayHello?: GatewayHello;
  private connectedAt?: number;
  private disconnectedAt?: number;
  private lastGatewayEventAt?: number;
  private lastAuthoritativeSnapshotAt?: number;
  private defaultAgentId?: string;
  private schedule: UpcomingScheduleSnapshot = {
    revision: 0,
    state: "offline",
    schedulerEnabled: false,
    windowMinutes: UPCOMING_WINDOW_MINUTES,
    dueGraceMinutes: DUE_GRACE_MINUTES,
    items: [],
  };
  private stopped = true;

  constructor(readonly config: ResolvedCollectorConfig) {
    this.repository = new CollectorRepository(config.storage.path);
    this.repository.subscribe((change) => {
      this.emitChange(change);
    });
    this.gateway = new RawGatewayClient({
      url: config.gateway.url,
      token: config.gateway.token,
      onState: (state) => void this.handleGatewayState(state),
      onEvent: (event) => this.handleGatewayEvent(event),
      onGap: (gap) => this.handleGap(gap),
    });
    this.transcripts = new TranscriptSynchronizer({
      archive: this.repository.transcripts,
      request: async (method, params) => this.gateway.request(method, params),
      maxBytes: config.storage.transcriptMaxBytes,
      enabled: config.storage.transcriptSync === "enabled",
      inventory: this.messageFields,
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.taskTimer = setInterval(() => void this.syncTasks("task_interval"), this.config.reconcile.tasksMs);
    this.sessionTimer = setInterval(() => void this.syncSessions("session_interval"), this.config.reconcile.sessionsMs);
    this.scheduleTimer = setInterval(() => void this.syncSchedules("schedule_interval"), SCHEDULE_RECONCILE_MS);
    this.pruneTimer = setInterval(() => this.prune(), 6 * 60 * 60 * 1_000);
    // Deliberately not sharing the 8s session tick: a slow roster call must not
    // be able to delay session reconciliation.
    this.agentTimer = setInterval(() => void this.syncAgents("agent_interval"), AGENT_RECONCILE_MS);
    this.transcriptTimer = setInterval(() => void this.syncTranscripts(), TRANSCRIPT_SYNC_MS);
    this.gateway.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.taskTimer) clearInterval(this.taskTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.agentTimer) clearInterval(this.agentTimer);
    if (this.transcriptTimer) clearInterval(this.transcriptTimer);
    this.gateway.stop();
    this.repository.close();
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  subscribeChanges(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  getStatus(): CollectorStatus {
    const scopes = this.gatewayHello?.auth?.scopes ?? [];
    return {
      apiVersion: 1,
      process: {
        version: "0.1.0",
        startedAt: this.startedAt,
        ready: this.syncState === "live" || this.syncState === "reconciling",
      },
      epoch: this.repository.epoch,
      revision: this.repository.revision,
      syncState: this.syncState,
      syncReasons: [...this.syncReasons],
      gateway: {
        name: this.config.gateway.name,
        endpoint: this.config.gateway.url,
        connected: this.gateway.isConnected,
        ...(this.gatewayHello?.server.version ? { serverVersion: this.gatewayHello.server.version } : {}),
        ...(this.gatewayHello?.protocol ? { protocolVersion: this.gatewayHello.protocol } : {}),
        ...(this.connectedAt ? { connectedAt: this.connectedAt } : {}),
        ...(this.disconnectedAt ? { disconnectedAt: this.disconnectedAt } : {}),
        grantedScopes: scopes,
      },
      sources: [...this.sources.values()].map((coverage) => ({ ...coverage })),
    };
  }

  getSnapshot(): ActivitySnapshot {
    const projection = this.repository.snapshotViews(this.config.ui.recentLimit);
    return {
      apiVersion: 1,
      epoch: this.repository.epoch,
      revision: this.repository.revision,
      generatedAt: Date.now(),
      sync: {
        state: this.syncState,
        reasons: [...this.syncReasons],
        ...(this.lastGatewayEventAt ? { lastGatewayEventAt: this.lastGatewayEventAt } : {}),
        ...(this.lastAuthoritativeSnapshotAt ? { lastAuthoritativeSnapshotAt: this.lastAuthoritativeSnapshotAt } : {}),
      },
      ...projection,
      schedule: {
        ...this.schedule,
        items: this.schedule.items.map((item) => ({ ...item })),
      },
    };
  }

  getDetail(id: string): ActivityDetail | undefined {
    return this.repository.detail(id);
  }

  getSettledGroups(range: SettledRange, rangeEnd = Date.now()): SettledGroupSnapshot {
    return this.repository.settledGroups(range, rangeEnd, this.hasCompleteSettledRange(range));
  }

  getSettledSeriesRuns(seriesKey: string, range: SettledRange, rangeEnd = Date.now()): SettledSeriesRuns | undefined {
    return this.repository.settledSeriesRuns(seriesKey, range, rangeEnd, this.hasCompleteSettledRange(range));
  }

  async checkConnection(timeoutMs = 10_000): Promise<GatewayHello> {
    if (this.stopped) this.start();
    return await this.gateway.waitUntilConnected(timeoutMs);
  }

  private hasCompleteSettledRange(range: SettledRange): boolean {
    return this.config.storage.terminalRetentionDays * 24 * 60 * 60 * 1_000 >= settledRangeDuration(range);
  }

  private async handleGatewayState(state: GatewayConnectionState): Promise<void> {
    if (state.state === "connecting") {
      this.syncState = "starting";
      this.syncReasons = ["gateway_connecting"];
      this.updateAllOffline("connecting");
    } else if (state.state === "connected") {
      this.gatewayHello = state.hello;
      this.defaultAgentId = undefined;
      // A reconnect may land on a different Gateway build, so probe verdicts and
      // field observations from the previous connection are discarded.
      this.capabilities.newGeneration();
      this.sessionFields.reset();
      this.agentFields.reset();
      this.connectedAt = state.connectedAt;
      this.syncState = "reconciling";
      this.syncReasons = ["initial_snapshot"];
      this.setSource("events", { state: "reconciling" });
      const methods = new Set(state.hello.features.methods);
      this.setSource("tasks", { state: methods.has("tasks.list") ? "reconciling" : "unavailable", ...(!methods.has("tasks.list") ? { code: "tasks_list_missing" } : {}) });
      this.setSource("sessions", { state: methods.has("sessions.list") ? "reconciling" : "unavailable", ...(!methods.has("sessions.list") ? { code: "sessions_list_missing" } : {}) });
      if (methods.has("sessions.subscribe")) {
        try {
          await this.gateway.request("sessions.subscribe", {});
          this.setSource("events", { state: "live", code: undefined });
        } catch (error) {
          this.setSource("events", { state: "error", code: error instanceof Error ? error.message : String(error) });
        }
      } else {
        this.setSource("events", { state: "unavailable", code: "sessions_subscribe_missing" });
      }
      await Promise.all([this.syncTasks("gateway_connected"), this.syncSessions("gateway_connected"), this.syncSchedules("gateway_connected")]);
      // Roster and capability probing trail the required sources so they can
      // never delay the first authoritative snapshot.
      await Promise.all([this.syncAgents("gateway_connected"), this.probeCapabilities()]);
      this.deriveSyncState();
    } else if (state.state === "unauthorized") {
      this.syncState = "unauthorized";
      this.syncReasons = ["gateway_unauthorized"];
      this.disconnectedAt = state.at;
      this.updateAllOffline("unauthorized");
      this.updateSchedule({ state: "offline", schedulerEnabled: false, items: [] }, "schedule_unauthorized");
    } else if (state.state === "incompatible") {
      this.syncState = "incompatible";
      this.syncReasons = ["gateway_protocol_incompatible"];
      this.disconnectedAt = state.at;
      this.updateAllOffline("incompatible");
      this.updateSchedule({ state: "offline", schedulerEnabled: false, items: [] }, "schedule_incompatible");
    } else if (state.state === "error") {
      if (!this.gateway.isConnected) {
        this.syncState = "error";
        this.syncReasons = ["gateway_error"];
      }
    } else {
      this.disconnectedAt = state.at;
      if (this.syncState !== "unauthorized" && this.syncState !== "incompatible") {
        this.syncState = "offline";
        this.syncReasons = ["gateway_disconnected"];
        this.updateAllOffline("disconnected");
        this.updateSchedule({ state: "offline", schedulerEnabled: false, items: [] }, "schedule_disconnected");
      }
    }
    this.emitStatus();
  }

  private async syncTasks(reason: string): Promise<void> {
    if (this.taskSyncing || !this.gateway.isConnected || this.sources.get("tasks")?.state === "unavailable") return;
    this.taskSyncing = true;
    this.setSource("tasks", { state: "reconciling" });
    this.deriveSyncState();
    try {
      const tasks: RawTaskSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = record(await this.gateway.request("tasks.list", { limit: 500, ...(cursor ? { cursor } : {}) }));
        tasks.push(...arrayRecords(result.tasks));
        const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      const now = Date.now();
      const writes = tasks.map((task) => taskToActivity(task, now)).filter((item): item is ActivityWrite => item !== null);
      this.repository.upsertMany(writes, [reason]);
      this.repository.markMissingTasks(new Set(writes.map((write) => write.sourceKey)), now);
      this.lastAuthoritativeSnapshotAt = now;
      this.setSource("tasks", { state: "live", lastSnapshotAt: now, code: undefined });
    } catch (error) {
      this.setSource("tasks", { state: "error", code: error instanceof Error ? error.message : String(error) });
    } finally {
      this.taskSyncing = false;
      this.deriveSyncState();
      this.emitStatus();
    }
  }

  private async syncSessions(reason: string): Promise<void> {
    if (this.sessionSyncing || !this.gateway.isConnected || this.sources.get("sessions")?.state === "unavailable") return;
    this.sessionSyncing = true;
    this.setSource("sessions", { state: "reconciling" });
    this.deriveSyncState();
    try {
      const sessions: RawSessionRow[] = [];
      let offset = 0;
      for (let page = 0; page < 20; page += 1) {
        const result = record(
          await this.gateway.request("sessions.list", {
            limit: 500,
            offset,
            includeGlobal: true,
            includeUnknown: true,
            includeDerivedTitles: false,
            includeLastMessage: false,
          }),
        );
        const rows = arrayRecords(result.sessions);
        sessions.push(...rows);
        const nextOffset = typeof result.nextOffset === "number" ? result.nextOffset : offset + rows.length;
        if (result.hasMore !== true || rows.length === 0 || nextOffset <= offset) break;
        offset = nextOffset;
      }
      const now = Date.now();
      // The session archive must record every row, including archived and idle
      // ones that the Activity projection below deliberately skips. Failing here
      // must not cost us the Live Flow projection, so it gets its own boundary.
      this.archiveSessions(sessions, now);

      const writes: ActivityWrite[] = [];
      const activeSourceKeys = new Set<string>();
      for (const session of sessions) {
        if (!sessionIsActive(session) && stringField(session, "status") !== "running") continue;
        const key = sessionKey(session);
        if (!key) continue;
        const runRefs = sessionRunRefs(session);
        if (runRefs.length === 0) {
          const openAttempts = this.repository.findOpenAttemptsBySessionKey(key);
          if (openAttempts.length > 1) {
            for (const attempt of openAttempts) activeSourceKeys.add(attempt.sourceKey);
            continue;
          }
        }
        const refs: Array<string | undefined> = runRefs.length > 0 ? runRefs : [undefined];
        for (const runRef of refs) {
          const sourceKey = runRef
            ? `attempt:run:${runRef}`
            : `attempt:session:${key}:${numberField(session, "startedAt") ?? "active"}`;
          const existing = this.repository.findOpenAttempt({ ...(runRef ? { runRef } : {}), sessionKey: key }) ?? this.repository.findBySourceKey(sourceKey);
          const id = existing?.id ?? newAttemptActivityId();
          activeSourceKeys.add(sourceKey);
          writes.push(
            attemptPatch({
              id,
              sourceKey,
              origin: runRef ? "online" : "session_segment",
              agentId: sessionAgentId(session),
              title: sessionTitle(session),
              now,
              ...(runRef ? { runRef } : {}),
              sessionKey: key,
              state: "active",
              phase: "unknown",
              ...(numberField(session, "startedAt") !== undefined ? { startedAt: numberField(session, "startedAt") } : {}),
              source: "session",
              eventKind: "session_snapshot",
              ...(stringField(session, "status") ? { status: stringField(session, "status") } : {}),
            }),
          );
        }
      }
      this.repository.upsertMany(writes, [reason]);
      this.repository.closeSessionAttempts(activeSourceKeys, now);
      this.lastAuthoritativeSnapshotAt = now;
      this.setSource("sessions", { state: "live", lastSnapshotAt: now, code: undefined });
    } catch (error) {
      this.setSource("sessions", { state: "error", code: error instanceof Error ? error.message : String(error) });
    } finally {
      this.sessionSyncing = false;
      this.deriveSyncState();
      this.emitStatus();
    }
  }

  /**
   * Persists the session archive from a `sessions.list` page set.
   *
   * Isolated from the Activity projection on purpose: the archive is a secondary
   * product, and a failure here must leave Live Flow untouched rather than fail
   * the whole session sync.
   */
  private archiveSessions(rows: Record<string, unknown>[], now: number): void {
    try {
      const writes = rows.flatMap((row) => {
        const projected = projectSession(row, now, this.sessionFields);
        return projected ? [projected] : [];
      });
      if (writes.length === 0) return;
      this.repository.upsertSessions(writes);
      this.repository.linkActivitySessions();
      // Sessions carry agent ids even when agents.list is unavailable, so the
      // roster stays populated either way. `observed` entries never overwrite
      // authoritative ones.
      this.repository.upsertAgents(inferAgents(writes.map((write) => write.agentId), now));
      this.sessionArchiveError = undefined;
    } catch (error) {
      // Recorded as a diagnostic rather than through setSource: source states feed
      // deriveSyncState, and the archive is not allowed to change sync state.
      this.sessionArchiveError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Refreshes the Agent roster. Runs on its own timer and swallows its own
   * failures: an absent roster degrades Agent metadata to what sessions imply,
   * which is a coverage question rather than a sync-state one.
   */
  private async syncAgents(reason: string): Promise<void> {
    if (this.agentSyncing || !this.gateway.isConnected) return;
    if (!new Set(this.gatewayHello?.features.methods ?? []).has("agents.list")) return;
    this.agentSyncing = true;
    try {
      const response = record(await this.gateway.request("agents.list", {}));
      this.defaultAgentId ??= stringField(response, "defaultId");
      const now = Date.now();
      const writes = arrayRecords(response.agents).flatMap((row) => {
        const projected = projectAgent(row, now, this.agentFields);
        return projected ? [projected] : [];
      });
      if (writes.length > 0) this.repository.upsertAgents(writes);
    } catch {
      // Roster stays at whatever sessions already implied; see inferAgents.
    } finally {
      this.agentSyncing = false;
    }
  }

  /**
   * Pulls session transcripts into the local archive.
   *
   * Runs behind the primary sources in every sense: its own timer, its own
   * request budget, and a hard gate on the primary sync being healthy. The
   * outcome never touches `CollectorSyncState` — a transcript that is behind is
   * a coverage fact, not a reason to call the collector degraded.
   */
  private async syncTranscripts(): Promise<void> {
    if (this.transcriptSyncing) return;
    this.transcriptSyncing = true;
    try {
      this.transcriptStatus = await this.transcripts.runOnce({
        now: Date.now(),
        connected: this.gateway.isConnected,
        available: new Set(this.gatewayHello?.features.methods ?? []).has("chat.history"),
        primaryHealthy: this.sources.get("sessions")?.state === "live",
      });
    } catch (error) {
      // Closed-set code only: invariant 2 keeps transcript text out of logs.
      this.transcriptStatus = {
        requests: 0,
        inserted: 0,
        sessions: 0,
        capacity: "ok",
        evictedSessions: 0,
        errorCode: classifyHistoryFailure(error),
      };
    } finally {
      this.transcriptSyncing = false;
    }
  }

  /** Counts and watermarks only; never message text. */
  getTranscriptStatus(): TranscriptSyncOutcome | undefined {
    return this.transcriptStatus;
  }

  /**
   * One read-only probe per non-discoverable method, bound to the current
   * connection generation.
   */
  private async probeCapabilities(): Promise<void> {
    if (!this.gateway.isConnected) return;
    try {
      await this.capabilities.probeAll(async (method, params) => this.gateway.request(method, params));
    } catch {
      // probeAll already classifies per-method outcomes; a throw here would only
      // come from the caller itself and must not affect sync state.
    }
  }

  /** Field-mapping diagnostics for validating the projectors against a real Gateway. */
  getFieldReports(): FieldInventoryReport[] {
    return [this.sessionFields.report(), this.agentFields.report(), this.messageFields.report()];
  }

  getCapabilities(): Record<string, CapabilityState> {
    return this.capabilities.snapshot();
  }

  getArchiveDiagnostics(): { sessionArchiveError?: string } {
    return this.sessionArchiveError ? { sessionArchiveError: this.sessionArchiveError } : {};
  }

  private async syncSchedules(reason: string): Promise<void> {
    if (this.scheduleSyncing || !this.gateway.isConnected) return;
    const methods = new Set(this.gatewayHello?.features.methods ?? []);
    if (!methods.has("cron.status") || !methods.has("cron.list")) {
      this.updateSchedule({ state: "unavailable", schedulerEnabled: false, items: [] }, "schedule_methods_unavailable");
      return;
    }

    this.scheduleSyncing = true;
    try {
      const status = record(await this.gateway.request("cron.status", {}));
      const schedulerEnabled = status.enabled === true;
      const jobs: Record<string, unknown>[] = [];
      if (schedulerEnabled) {
        let offset = 0;
        for (let page = 0; page < 20; page += 1) {
          const result = record(await this.gateway.request("cron.list", { includeDisabled: true, limit: CRON_PAGE_LIMIT, offset }));
          const rows = arrayRecords(result.jobs);
          jobs.push(...rows);
          const nextOffset = typeof result.nextOffset === "number" ? result.nextOffset : offset + rows.length;
          if (result.hasMore !== true || rows.length === 0 || nextOffset <= offset) break;
          offset = nextOffset;
        }
      }

      if (!this.defaultAgentId && methods.has("agents.list")) {
        try {
          const agents = record(await this.gateway.request("agents.list", {}));
          this.defaultAgentId = stringField(agents, "defaultId");
        } catch {
          // Explicitly attributed jobs remain useful; unresolved jobs make the snapshot partial.
        }
      }

      const now = Date.now();
      const selected = selectUpcomingSchedules(jobs, { now, ...(this.defaultAgentId ? { defaultAgentId: this.defaultAgentId } : {}) });
      // A cron job proves its agent exists even when the roster call omits it,
      // and without this its schedule would render against no Agent card.
      this.repository.upsertAgents(inferAgents(scheduleAgentIds(jobs, this.defaultAgentId), now));
      this.updateSchedule(
        {
          state: selected.omittedAgentCount > 0 ? "partial" : "live",
          schedulerEnabled,
          lastSnapshotAt: now,
          items: selected.items,
        },
        `schedule_${reason}`,
      );
    } catch {
      this.updateSchedule({ state: "error", schedulerEnabled: false, items: [] }, "schedule_sync_error");
    } finally {
      this.scheduleSyncing = false;
    }
  }

  private async handleGatewayEvent(event: GatewayEventFrame): Promise<void> {
    const now = Date.now();
    this.lastGatewayEventAt = now;
    this.setSource("events", { state: "live", lastEventAt: now, code: undefined });
    if (event.event === "task") {
      const payload = record(event.payload);
      if (payload.action === "upserted") {
        const write = taskToActivity(record(payload.task), now);
        if (write) this.repository.upsertMany([write], ["task_event"]);
      } else {
        void this.syncTasks("task_event_reconcile");
      }
    } else if (event.event === "agent" || event.event === "session.tool") {
      this.projectRuntimeEvent(record(event.payload), event.event);
    } else if (event.event === "sessions.changed") {
      const payload = record(event.payload);
      this.projectSessionChanged(payload);
      const phase = stringField(payload, "phase");
      if (!phase || phase === "message") void this.syncSessions("sessions_changed_reconcile");
    } else if (event.event.includes("approval")) {
      this.projectApprovalEvent(record(event.payload), event.event);
    }
    this.deriveSyncState();
    this.emitStatus();
  }

  private projectSessionChanged(payload: Record<string, unknown>): void {
    const key = stringField(payload, "sessionKey") ?? stringField(payload, "key");
    const runRefs = sessionRunRefs(payload);
    const directRunRef = stringField(payload, "runId") ?? stringField(payload, "clientRunId");
    const runRef = directRunRef ?? runRefs[0];
    const phase = stringField(payload, "phase");
    const active = payload.hasActiveRun === true || phase === "start" || stringField(payload, "status") === "running";
    const terminal = phase === "end" || phase === "error" || (!active && (payload.hasActiveRun === false || ["done", "failed", "killed", "timeout"].includes(stringField(payload, "status") ?? "")));
    if (!active && !terminal) return;
    const existing = this.repository.findOpenAttempt({ ...(runRef ? { runRef } : {}), ...(key ? { sessionKey: key } : {}) })
      ?? (runRef ? this.repository.findBySourceKey(`attempt:run:${runRef}`) : undefined);
    const now = nowOr(payload.ts, Date.now());
    const data = record(payload.data);
    const sourceKey = existing?.sourceKey ?? (runRef ? `attempt:run:${runRef}` : `attempt:session:${key ?? "unknown"}:${now}`);
    const status = stringField(payload, "status") ?? phase;
    let outcome: "none" | "failed" | "cancelled" | "timed_out" | "unknown" = "none";
    if (terminal) {
      const sessionStatus = stringField(payload, "status");
      outcome = sessionStatus === "failed" ? "failed" : sessionStatus === "killed" ? "cancelled" : sessionStatus === "timeout" ? "timed_out" : lifecycleOutcome({ ...data, ...(phase === "error" ? { error: stringField(payload, "lastRunError") ?? "session error" } : {}) });
    }
    const write = attemptPatch({
      id: existing?.id ?? newAttemptActivityId(),
      sourceKey,
      origin: runRef ? "online" : "session_segment",
      agentId: stringField(payload, "agentId") ?? agentIdFromSessionKey(key) ?? existing?.agentId ?? "Unattributed",
      title: stringField(payload, "label") ?? stringField(payload, "displayName") ?? existing?.title ?? "Interactive run",
      now,
      ...(runRef ? { runRef } : existing?.runRef ? { runRef: existing.runRef } : {}),
      ...(key ? { sessionKey: key } : existing?.sessionKey ? { sessionKey: existing.sessionKey } : {}),
      state: terminal ? "terminal" : "active",
      outcome,
      phase: terminal ? "none" : "starting",
      attention: terminal && outcome === "failed" ? "error" : "none",
      ...(numberField(payload, "startedAt") !== undefined ? { startedAt: numberField(payload, "startedAt") } : {}),
      ...(terminal ? { endedAt: numberField(payload, "endedAt") ?? now } : {}),
      source: "events",
      eventKind: `sessions.changed:${phase ?? "update"}`,
      ...(status ? { status } : {}),
    });
    this.repository.upsertMany([write], ["sessions_changed_event"]);
  }

  private projectRuntimeEvent(payload: Record<string, unknown>, eventName: string): void {
    const data = record(payload.data);
    const runRef = stringField(payload, "runId");
    const key = stringField(payload, "sessionKey");
    if (!runRef && !key) return;
    const existing = this.repository.findOpenAttempt({ ...(runRef ? { runRef } : {}), ...(key ? { sessionKey: key } : {}) })
      ?? (runRef ? this.repository.findBySourceKey(`attempt:run:${runRef}`) : undefined);
    const stream = stringField(payload, "stream") ?? (eventName === "session.tool" ? "tool" : "unknown");
    const lifecyclePhase = stringField(data, "phase");
    const terminal = stream === "lifecycle" && (lifecyclePhase === "end" || lifecyclePhase === "error");
    const now = nowOr(payload.ts, Date.now());
    const outcome = terminal ? lifecycleOutcome(data) : "none";
    const sourceKey = existing?.sourceKey ?? (runRef ? `attempt:run:${runRef}` : `attempt:session:${key}:${numberField(data, "startedAt") ?? now}`);
    const toolName = stream === "tool" ? stringField(data, "name") : undefined;
    const projectedPhase = terminal ? "none" : phaseForStream(stream, data);
    const write = attemptPatch({
      id: existing?.id ?? newAttemptActivityId(),
      sourceKey,
      origin: runRef ? "online" : "session_segment",
      agentId: stringField(payload, "agentId") ?? agentIdFromSessionKey(key) ?? existing?.agentId ?? "Unattributed",
      title: existing?.title ?? (runRef ? `OpenClaw run ${runRef.slice(0, 8)}` : "Interactive run"),
      now,
      ...(runRef ? { runRef } : existing?.runRef ? { runRef: existing.runRef } : {}),
      ...(key ? { sessionKey: key } : existing?.sessionKey ? { sessionKey: existing.sessionKey } : {}),
      state: terminal ? "terminal" : "active",
      outcome,
      phase: projectedPhase,
      attention: terminal && (outcome === "failed" || outcome === "timed_out") ? "error" : projectedPhase === "waiting_approval" ? "waiting" : "none",
      ...(toolName ? { lastToolName: toolName } : {}),
      ...(numberField(data, "startedAt") !== undefined ? { startedAt: numberField(data, "startedAt") } : {}),
      ...(terminal ? { endedAt: numberField(data, "endedAt") ?? now } : {}),
      source: "events",
      eventKind: `${eventName}:${stream}:${lifecyclePhase ?? "update"}`,
      ...(lifecyclePhase ? { status: lifecyclePhase } : {}),
    });
    this.repository.upsertMany([write], ["runtime_event"]);
  }

  private projectApprovalEvent(payload: Record<string, unknown>, eventName: string): void {
    const runRef = stringField(payload, "runId");
    const key = stringField(payload, "sessionKey");
    const existing = this.repository.findOpenAttempt({ ...(runRef ? { runRef } : {}), ...(key ? { sessionKey: key } : {}) });
    if (!existing) return;
    const now = Date.now();
    this.repository.upsertMany(
      [
        attemptPatch({
          id: existing.id,
          sourceKey: existing.sourceKey,
          origin: existing.origin === "online" ? "online" : "session_segment",
          agentId: existing.agentId,
          title: existing.title,
          now,
          ...(existing.runRef ? { runRef: existing.runRef } : {}),
          ...(existing.sessionKey ? { sessionKey: existing.sessionKey } : {}),
          state: "active",
          phase: eventName.includes("resolved") ? "unknown" : "waiting_approval",
          attention: eventName.includes("resolved") ? "none" : "waiting",
          source: "events",
          eventKind: eventName,
        }),
      ],
      ["approval_event"],
    );
  }

  private handleGap(gap: { expected: number; received: number }): void {
    this.syncState = "reconciling";
    this.syncReasons = [`event_gap:${gap.expected}-${gap.received}`];
    this.setSource("events", { state: "reconciling", code: "sequence_gap" });
    void Promise.all([this.syncTasks("event_gap"), this.syncSessions("event_gap")]);
    this.emitStatus();
  }

  private setSource(name: SourceCoverage["source"], patch: Partial<SourceCoverage>): void {
    const current = this.sources.get(name) ?? source(name);
    const next = { ...current, ...patch, source: name };
    if (patch.code === undefined) delete next.code;
    this.sources.set(name, next);
  }

  private updateAllOffline(code: string): void {
    for (const name of ["tasks", "sessions", "events"] as const) this.setSource(name, { state: "offline", code });
  }

  private deriveSyncState(): void {
    if (["unauthorized", "incompatible", "offline", "error"].includes(this.syncState) && !this.gateway.isConnected) return;
    const states = [...this.sources.values()].map((coverage) => coverage.state);
    if (states.includes("reconciling") || states.includes("connecting")) {
      this.syncState = "reconciling";
      this.syncReasons = ["source_reconciling"];
    } else if (states.includes("error")) {
      this.syncState = "error";
      this.syncReasons = ["source_error"];
    } else if (this.gateway.isConnected && states.every((state) => state === "live" || state === "unavailable")) {
      this.syncState = "live";
      this.syncReasons = states.includes("unavailable") ? ["live_with_unavailable_source"] : [];
    }
  }

  private emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) listener(status);
  }

  private emitChange(change: RepositoryChange): void {
    for (const listener of this.changeListeners) listener(change);
  }

  private updateSchedule(
    patch: Partial<Omit<UpcomingScheduleSnapshot, "revision" | "windowMinutes" | "dueGraceMinutes">>,
    reason: string,
  ): void {
    const next: UpcomingScheduleSnapshot = {
      ...this.schedule,
      ...patch,
      revision: this.schedule.revision,
      windowMinutes: UPCOMING_WINDOW_MINUTES,
      dueGraceMinutes: DUE_GRACE_MINUTES,
    };
    const changed = JSON.stringify({
      state: this.schedule.state,
      schedulerEnabled: this.schedule.schedulerEnabled,
      items: this.schedule.items,
    }) !== JSON.stringify({
      state: next.state,
      schedulerEnabled: next.schedulerEnabled,
      items: next.items,
    });
    if (!changed) {
      this.schedule = next;
      return;
    }

    this.schedule = { ...next, revision: this.schedule.revision + 1 };
    this.emitChange({
      epoch: this.repository.epoch,
      revision: this.repository.revision,
      // The upcoming-schedule forecast is rendered by the activities surface.
      topics: ["activities"],
      ids: [],
      reasons: [reason],
    });
  }

  private prune(): void {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1_000;
    this.repository.prune(now - this.config.storage.terminalRetentionDays * day);
    this.repository.pruneSessions(now - this.config.storage.sessionRetentionDays * day);
    // Transcripts have two gates: age here, and the size ceiling the sync loop
    // enforces. Age runs first so eviction only ever has to handle real growth.
    this.repository.transcripts.pruneOlderThan(now - this.config.storage.transcriptRetentionDays * day);
    this.repository.transcripts.evictOldestSessions(this.config.storage.transcriptMaxBytes);
  }
}
