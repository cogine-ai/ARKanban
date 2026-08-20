import type {
  ActivityDetail,
  ActivitySnapshot,
  AgentOverview,
  AgentRollupWindow,
  CollectorStatus,
  SettledGroupSnapshot,
  SettledRange,
  SettledSeriesRuns,
  UsageTotals,
} from "../contracts.js";
import type { ResolvedCollectorConfig } from "../config.js";
import type { RepositoryChange } from "../storage/repository.js";
import type { AgentCostEntry } from "../activity/usage-projector.js";
import type { CostSpan } from "../collector/usage-sync.js";
import type { CapabilityState } from "../collector/capability-probe.js";
import type { FieldInventoryReport } from "../collector/field-inventory.js";
import type { AuditSyncOutcome } from "../collector/audit-sync.js";
import type { TranscriptSyncOutcome } from "../collector/transcript-sync.js";
import type { SignalRecomputeStatus } from "../collector/runtime.js";
import { qualifyId } from "../host/ids.js";
import {
  mergeSettledGroups,
  mergeSnapshots,
  mergeStatus,
  qualifyAgent,
  qualifyDetail,
  qualifySettledGroup,
  resolveOwner,
  type NodeSnapshotBundle,
} from "./merge.js";
import { NodeClient } from "./node-client.js";

type StatusListener = (status: CollectorStatus) => void;
type ChangeListener = (change: RepositoryChange) => void;

const REFRESH_MS = 5_000;
const SSE_RETRY_MIN_MS = 1_000;
const SSE_RETRY_MAX_MS = 30_000;

/**
 * Fan-in surface for multi-host boards.
 *
 * Does not open Gateway connections. Pulls already-projected observation APIs
 * from collector nodes and qualifies every id with `hostId::`.
 */
export class HubRuntime {
  readonly kind = "hub" as const;
  readonly config: ResolvedCollectorConfig;
  /**
   * Hub has no local SQLite. Routes that need repository methods go through
   * this stub and should prefer hub-specific handlers.
   */
  readonly repository: HubRepositoryStub;
  private readonly clients: NodeClient[];
  private readonly startedAt = Date.now();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly sseUnsubscribers = new Map<string, () => void>();
  private readonly sseRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sseRetryMs = new Map<string, number>();
  private bundles = new Map<string, NodeSnapshotBundle>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastSettledRange: SettledRange = "7d";
  private revision = 0;
  private stopped = true;

  constructor(config: ResolvedCollectorConfig) {
    this.config = config;
    this.clients = config.hub.nodes.map(
      (node) =>
        new NodeClient({
          id: node.id,
          label: node.label ?? node.id,
          url: node.url,
          token: node.token,
        }),
    );
    for (const client of this.clients) {
      this.bundles.set(client.id, {
        hostId: client.id,
        label: client.label,
        reachable: false,
        code: "not_started",
      });
    }
    this.repository = new HubRepositoryStub(this);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refreshAll("start");
    this.refreshTimer = setInterval(() => void this.refreshAll("interval"), REFRESH_MS);
    for (const client of this.clients) this.attachEvents(client);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const timer of this.sseRetryTimers.values()) clearTimeout(timer);
    this.sseRetryTimers.clear();
    for (const unsubscribe of this.sseUnsubscribers.values()) unsubscribe();
    this.sseUnsubscribers.clear();
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
    return mergeStatus(
      { id: this.config.host.id, label: this.config.host.label, role: this.config.role },
      this.startedAt,
      [...this.bundles.values()],
    );
  }

  getSnapshot(): ActivitySnapshot {
    const snapshot = mergeSnapshots([...this.bundles.values()]);
    return { ...snapshot, epoch: `hub:${this.config.host.id}`, revision: this.revision };
  }

  async getSettledGroups(range: SettledRange, rangeEnd = Date.now()): Promise<SettledGroupSnapshot> {
    this.lastSettledRange = range;
    const cached = [...this.bundles.values()];
    const fresh = cached.every((bundle) => !bundle.reachable || bundle.settled?.range === range);
    if (!fresh) {
      await Promise.all(this.clients.map((client) => this.refreshSettled(client, range, rangeEnd)));
    }
    return mergeSettledGroups(range, rangeEnd, [...this.bundles.values()]);
  }

  async getSettledSeriesRuns(
    seriesKey: string,
    range: SettledRange,
    rangeEnd = Date.now(),
  ): Promise<SettledSeriesRuns | undefined> {
    const owner = resolveOwner(seriesKey);
    if (!owner) return undefined;
    const client = this.clients.find((candidate) => candidate.id === owner.hostId);
    if (!client) return undefined;
    try {
      const detail = await client.getSettledSeriesRuns(owner.localId, range, rangeEnd);
      const group = qualifySettledGroup(owner.hostId, detail.group);
      return {
        ...detail,
        group,
        runs: detail.runs.map((run) => ({
          ...run,
          hostId: owner.hostId,
          id: qualifyId(owner.hostId, run.id),
          agentId: qualifyId(owner.hostId, run.agentId),
        })),
      };
    } catch {
      return undefined;
    }
  }

  async getDetail(id: string): Promise<ActivityDetail | undefined> {
    const owner = resolveOwner(id);
    if (!owner) return undefined;
    const client = this.clients.find((candidate) => candidate.id === owner.hostId);
    if (!client) return undefined;
    try {
      const detail = await client.getDetail(owner.localId);
      return qualifyDetail(owner.hostId, detail);
    } catch {
      return undefined;
    }
  }

  async listAgents(): Promise<AgentOverview[]> {
    const agents: AgentOverview[] = [];
    await Promise.all(
      this.clients.map(async (client) => {
        try {
          const page = await client.getAgents();
          for (const agent of page.agents) agents.push(qualifyAgent(client.id, agent));
        } catch {
          // Partial fan-in: missing host stays visible via Connections, not this list.
        }
      }),
    );
    return agents;
  }

  getTranscriptStatus(): TranscriptSyncOutcome | undefined {
    return undefined;
  }

  getUsageStatus(): undefined {
    return undefined;
  }

  getAuditStatus(): AuditSyncOutcome | undefined {
    return undefined;
  }

  getSignalStatus(): SignalRecomputeStatus | undefined {
    return undefined;
  }

  getAgentCost(_window: AgentRollupWindow, _agentId: string): AgentCostEntry | undefined {
    return undefined;
  }

  getAgentCostSpan(_window: AgentRollupWindow): CostSpan | undefined {
    return undefined;
  }

  getFieldReports(): FieldInventoryReport[] {
    return [];
  }

  getCapabilities(): Record<string, CapabilityState> {
    return {};
  }

  getArchiveDiagnostics(): { sessionArchiveError?: string; pruneError?: string } {
    return {};
  }

  private async refreshAll(reason: string): Promise<void> {
    await Promise.all(this.clients.map((client) => this.refreshNode(client, reason)));
  }

  private async refreshNode(client: NodeClient, reason: string): Promise<void> {
    try {
      const [status, snapshot, settled] = await Promise.all([
        client.getStatus(),
        client.getSnapshot(),
        client.getSettledGroups(this.lastSettledRange, Date.now()),
      ]);
      this.bundles.set(client.id, {
        hostId: client.id,
        label: client.label,
        reachable: true,
        status,
        snapshot,
        settled,
        lastSeenAt: Date.now(),
      });
      this.revision += 1;
      this.emitStatus();
      this.emitChange(["activities", "sessions", "agents"], [reason, `host:${client.id}`]);
    } catch (error) {
      this.bundles.set(client.id, {
        hostId: client.id,
        label: client.label,
        reachable: false,
        code: error instanceof Error ? error.message : String(error),
        lastSeenAt: Date.now(),
      });
      this.emitStatus();
    }
  }

  private attachEvents(client: NodeClient): void {
    this.sseUnsubscribers.get(client.id)?.();
    const unsubscribe = client.subscribeEvents({
      onStatus: (status) => {
        this.sseRetryMs.delete(client.id);
        const previous = this.bundles.get(client.id);
        this.bundles.set(client.id, {
          hostId: client.id,
          label: client.label,
          reachable: true,
          status,
          snapshot: previous?.snapshot,
          settled: previous?.settled,
          lastSeenAt: Date.now(),
        });
        this.emitStatus();
      },
      onInvalidate: () => {
        void this.refreshNode(client, "sse_invalidate");
      },
      onError: (error) => {
        this.bundles.set(client.id, {
          hostId: client.id,
          label: client.label,
          reachable: false,
          code: error.message,
          lastSeenAt: Date.now(),
        });
        this.emitStatus();
        this.scheduleSseReconnect(client);
      },
    });
    this.sseUnsubscribers.set(client.id, unsubscribe);
  }

  private scheduleSseReconnect(client: NodeClient): void {
    if (this.stopped || this.sseRetryTimers.has(client.id)) return;
    const delay = this.sseRetryMs.get(client.id) ?? SSE_RETRY_MIN_MS;
    this.sseRetryMs.set(client.id, Math.min(delay * 2, SSE_RETRY_MAX_MS));
    this.sseRetryTimers.set(
      client.id,
      setTimeout(() => {
        this.sseRetryTimers.delete(client.id);
        if (this.stopped) return;
        this.attachEvents(client);
      }, delay),
    );
  }

  private async refreshSettled(client: NodeClient, range: SettledRange, rangeEnd: number): Promise<void> {
    const previous = this.bundles.get(client.id);
    try {
      const settled = await client.getSettledGroups(range, rangeEnd);
      this.bundles.set(client.id, {
        hostId: client.id,
        label: client.label,
        reachable: previous?.reachable ?? true,
        status: previous?.status,
        snapshot: previous?.snapshot,
        settled,
        lastSeenAt: Date.now(),
        ...(previous?.code ? { code: previous.code } : {}),
      });
    } catch {
      if (previous?.settled && previous.settled.range !== range) {
        this.bundles.set(client.id, { ...previous, settled: undefined });
      }
    }
  }

  private emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) listener(status);
  }

  private emitChange(topics: RepositoryChange["topics"], reasons: string[]): void {
    this.repository.revision = this.revision;
    const change: RepositoryChange = {
      epoch: `hub:${this.config.host.id}`,
      revision: this.revision,
      topics,
      ids: [],
      reasons,
    };
    for (const listener of this.changeListeners) listener(change);
  }
}

/**
 * Minimal repository facade so existing HTTP routes that touch
 * `runtime.repository.*` do not crash. Hub-local SQLite does not exist.
 */
class HubRepositoryStub {
  readonly epoch = "hub";
  revision = 0;
  readonly filePermissionsEnforced = true;
  readonly audit = {
    totals: () => ({ retained: 0, oldestAt: undefined as number | undefined, newestAt: undefined as number | undefined }),
  };
  readonly usage = {
    latest: () => undefined,
    summary: () => ({
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        hasCost: true,
        sessionCount: 0,
        unpricedModels: [] as string[],
      },
      byAgent: new Map<string, UsageTotals>(),
      byModel: new Map<string, UsageTotals>(),
    }),
  };
  readonly signals = {
    freshFor: () => undefined,
  };
  readonly transcripts = {
    listMessages: () => [],
    syncState: () => undefined,
    search: () => ({ mode: "fts" as const, hits: [], truncated: false }),
    totals: () => ({ messageCount: 0, contentBytes: 0 }),
  };

  constructor(private readonly hub: HubRuntime) {}

  listAgentOverviews(): AgentOverview[] {
    // Synchronous facade: HTTP agents route uses the async hub method instead.
    return [];
  }

  getAgentOverview(): undefined {
    return undefined;
  }

  listSessionsPage(): { items: never[] } {
    return { items: [] };
  }

  getSession(): undefined {
    return undefined;
  }

  listSessionActivities(): never[] {
    return [];
  }

  getUsageCoverage() {
    return "not_observed" as const;
  }
}
