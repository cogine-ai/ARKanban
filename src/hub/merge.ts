import type {
  ActivityDetail,
  ActivityItem,
  ActivityRelation,
  ActivitySnapshot,
  AgentOverview,
  CollectorChange,
  CollectorStatus,
  CollectorSyncState,
  HostCoverage,
  LaneSummary,
  SessionSummary,
  SettledGroupSnapshot,
  SettledGroupSummary,
  SettledRange,
  SettledSeriesRuns,
  StageCounts,
  UpcomingSchedule,
} from "../contracts.js";
import { qualifyId, splitQualifiedId } from "../host/ids.js";

export function emptyStageCounts(): StageCounts {
  return { incoming: 0, inFlight: 0, waiting: 0, settled: 0, unresolved: 0 };
}

function addCounts(target: StageCounts, source: StageCounts): void {
  target.incoming += source.incoming;
  target.inFlight += source.inFlight;
  target.waiting += source.waiting;
  target.settled += source.settled;
  target.unresolved += source.unresolved;
}

export function qualifyActivity(hostId: string, item: ActivityItem): ActivityItem {
  return {
    ...item,
    hostId,
    id: qualifyId(hostId, item.id),
    agentId: qualifyId(hostId, item.agentId),
    ...(item.flowId ? { flowId: qualifyId(hostId, item.flowId) } : {}),
  };
}

export function qualifyRelation(hostId: string, relation: ActivityRelation): ActivityRelation {
  return {
    ...relation,
    from: qualifyId(hostId, relation.from),
    to: qualifyId(hostId, relation.to),
  };
}

export function qualifySchedule(hostId: string, item: UpcomingSchedule): UpcomingSchedule {
  return {
    ...item,
    hostId,
    id: qualifyId(hostId, item.id),
    agentId: qualifyId(hostId, item.agentId),
  };
}

export function qualifySettledGroup(hostId: string, group: SettledGroupSummary): SettledGroupSummary {
  return {
    ...group,
    hostId,
    seriesKey: qualifyId(hostId, group.seriesKey),
    agentId: qualifyId(hostId, group.agentId),
    latestActivityId: qualifyId(hostId, group.latestActivityId),
  };
}

export function qualifySession(hostId: string, session: SessionSummary): SessionSummary {
  return {
    ...session,
    hostId,
    sessionKey: qualifyId(hostId, session.sessionKey),
    agentId: qualifyId(hostId, session.agentId),
  };
}

export function qualifyAgent(hostId: string, agent: AgentOverview): AgentOverview {
  return {
    ...agent,
    hostId,
    id: qualifyId(hostId, agent.id),
  };
}

export function qualifyDetail(hostId: string, detail: ActivityDetail): ActivityDetail {
  return {
    ...detail,
    item: qualifyActivity(hostId, detail.item),
    relations: detail.relations.map((relation) => qualifyRelation(hostId, relation)),
    related: detail.related.map((item) => qualifyActivity(hostId, item)),
  };
}

export type NodeSnapshotBundle = {
  hostId: string;
  label: string;
  reachable: boolean;
  status?: CollectorStatus;
  snapshot?: ActivitySnapshot;
  settled?: SettledGroupSnapshot;
  code?: string;
  lastSeenAt?: number;
};

function mergeSyncState(states: CollectorSyncState[]): CollectorSyncState {
  if (states.length === 0) return "offline";
  if (states.every((state) => state === "live")) return "live";
  if (states.some((state) => state === "live" || state === "reconciling")) return "reconciling";
  if (states.some((state) => state === "error")) return "error";
  if (states.some((state) => state === "unauthorized")) return "unauthorized";
  if (states.some((state) => state === "incompatible")) return "incompatible";
  if (states.some((state) => state === "starting")) return "starting";
  return "offline";
}

export function mergeHostCoverage(bundles: NodeSnapshotBundle[]): HostCoverage[] {
  return bundles.map((bundle) => ({
    id: bundle.hostId,
    label: bundle.label,
    reachable: bundle.reachable,
    syncState: bundle.status?.syncState ?? "offline",
    ...(bundle.lastSeenAt ? { lastSeenAt: bundle.lastSeenAt } : {}),
    ...(bundle.code ? { code: bundle.code } : {}),
    ...(bundle.status ? { gatewayConnected: bundle.status.gateway.connected } : {}),
  }));
}

export function mergeStatus(
  hubHost: { id: string; label: string; role: CollectorStatus["host"]["role"] },
  startedAt: number,
  bundles: NodeSnapshotBundle[],
): CollectorStatus {
  const hosts = mergeHostCoverage(bundles);
  const liveStatuses = bundles.flatMap((bundle) => (bundle.status ? [bundle.status] : []));
  const syncState = mergeSyncState(liveStatuses.map((status) => status.syncState));
  const reasons = [
    ...new Set([
      ...liveStatuses.flatMap((status) => status.syncReasons),
      ...bundles.filter((bundle) => !bundle.reachable).map((bundle) => `host_unreachable:${bundle.hostId}`),
    ]),
  ];
  return {
    apiVersion: 1,
    process: {
      version: "0.1.0",
      startedAt,
      ready: hosts.some((host) => host.reachable && (host.syncState === "live" || host.syncState === "reconciling")),
    },
    host: hubHost,
    hosts,
    epoch: `hub:${hubHost.id}`,
    revision: liveStatuses.reduce((sum, status) => sum + status.revision, 0),
    syncState,
    syncReasons: reasons,
    gateway: {
      name: hubHost.label,
      endpoint: "hub://fan-in",
      connected: hosts.some((host) => host.gatewayConnected),
      grantedScopes: [],
    },
    sources: [],
  };
}

export function mergeSnapshots(bundles: NodeSnapshotBundle[]): ActivitySnapshot {
  const items: ActivityItem[] = [];
  const relations: ActivityRelation[] = [];
  const scheduleItems: UpcomingSchedule[] = [];
  const summary = emptyStageCounts();
  const laneMap = new Map<string, ActivityItem[]>();
  let revision = 0;
  const reasons: string[] = [];
  const states: CollectorSyncState[] = [];
  let lastGatewayEventAt: number | undefined;
  let lastAuthoritativeSnapshotAt: number | undefined;
  let scheduleState: ActivitySnapshot["schedule"]["state"] = "unavailable";
  let schedulerEnabled = false;
  let scheduleRevision = 0;
  let scheduleLastSnapshotAt: number | undefined;

  for (const bundle of bundles) {
    if (!bundle.reachable || !bundle.snapshot) {
      reasons.push(`host_unreachable:${bundle.hostId}`);
      continue;
    }
    const snapshot = bundle.snapshot;
    revision += snapshot.revision;
    states.push(snapshot.sync.state);
    reasons.push(...snapshot.sync.reasons.map((reason) => `${bundle.hostId}:${reason}`));
    if (snapshot.sync.lastGatewayEventAt !== undefined) {
      lastGatewayEventAt = Math.max(lastGatewayEventAt ?? 0, snapshot.sync.lastGatewayEventAt);
    }
    if (snapshot.sync.lastAuthoritativeSnapshotAt !== undefined) {
      lastAuthoritativeSnapshotAt = Math.max(
        lastAuthoritativeSnapshotAt ?? 0,
        snapshot.sync.lastAuthoritativeSnapshotAt,
      );
    }
    addCounts(summary, snapshot.summary);
    for (const item of snapshot.items) {
      const qualified = qualifyActivity(bundle.hostId, item);
      items.push(qualified);
      const lane = laneMap.get(qualified.agentId) ?? [];
      lane.push(qualified);
      laneMap.set(qualified.agentId, lane);
    }
    relations.push(...snapshot.relations.map((relation) => qualifyRelation(bundle.hostId, relation)));
    scheduleItems.push(...snapshot.schedule.items.map((item) => qualifySchedule(bundle.hostId, item)));
    scheduleRevision += snapshot.schedule.revision;
    schedulerEnabled = schedulerEnabled || snapshot.schedule.schedulerEnabled;
    if (snapshot.schedule.state === "live") scheduleState = "live";
    else if (scheduleState !== "live" && snapshot.schedule.state === "partial") scheduleState = "partial";
    else if (scheduleState === "unavailable" && snapshot.schedule.state !== "unavailable") {
      scheduleState = snapshot.schedule.state;
    }
    if (snapshot.schedule.lastSnapshotAt !== undefined) {
      scheduleLastSnapshotAt = Math.max(scheduleLastSnapshotAt ?? 0, snapshot.schedule.lastSnapshotAt);
    }
  }

  const lanes: LaneSummary[] = [...laneMap.entries()]
    .map(([key, laneItems]) => ({
      key,
      label: key,
      counts: countStages(laneItems),
      attention: laneItems.filter((item) => item.attention !== "none").length,
    }))
    .sort((a, b) => b.attention - a.attention || a.label.localeCompare(b.label));

  scheduleItems.sort(
    (left, right) => left.nextRunAt - right.nextRunAt || left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );

  return {
    apiVersion: 1,
    epoch: "hub",
    revision,
    generatedAt: Date.now(),
    sync: {
      state: mergeSyncState(states),
      reasons: [...new Set(reasons)],
      ...(lastGatewayEventAt !== undefined ? { lastGatewayEventAt } : {}),
      ...(lastAuthoritativeSnapshotAt !== undefined ? { lastAuthoritativeSnapshotAt } : {}),
    },
    summary,
    lanes,
    items,
    relations,
    schedule: {
      revision: scheduleRevision,
      state: scheduleState,
      schedulerEnabled,
      windowMinutes: 60,
      dueGraceMinutes: 3,
      ...(scheduleLastSnapshotAt !== undefined ? { lastSnapshotAt: scheduleLastSnapshotAt } : {}),
      items: scheduleItems,
    },
  };
}

function countStages(items: ActivityItem[]): StageCounts {
  const counts = emptyStageCounts();
  for (const item of items) {
    switch (item.stage) {
      case "incoming":
        counts.incoming += 1;
        break;
      case "in_flight":
        counts.inFlight += 1;
        break;
      case "waiting":
        counts.waiting += 1;
        break;
      case "settled":
        counts.settled += 1;
        break;
      case "unresolved":
        counts.unresolved += 1;
        break;
      default: {
        const _exhaustive: never = item.stage;
        void _exhaustive;
        counts.unresolved += 1;
      }
    }
  }
  return counts;
}

export function mergeSettledGroups(
  range: SettledRange,
  rangeEnd: number,
  bundles: NodeSnapshotBundle[],
): SettledGroupSnapshot {
  const groupsByAgent: Record<string, SettledGroupSummary[]> = Object.create(null);
  const outcomeCounts = {
    none: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timed_out: 0,
    blocked: 0,
    unknown: 0,
  };
  let totalSeries = 0;
  let totalRuns = 0;
  let revision = 0;
  let complete = true;
  let rangeStart = rangeEnd;

  for (const bundle of bundles) {
    if (!bundle.reachable || !bundle.settled || bundle.settled.range !== range) {
      complete = false;
      continue;
    }
    const settled = bundle.settled;
    revision += settled.revision;
    complete = complete && settled.complete;
    rangeStart = Math.min(rangeStart, settled.rangeStart);
    totalSeries += settled.totalSeries;
    totalRuns += settled.totalRuns;
    for (const [outcome, count] of Object.entries(settled.outcomeCounts) as Array<
      [keyof typeof outcomeCounts, number]
    >) {
      outcomeCounts[outcome] += count;
    }
    for (const groups of Object.values(settled.groupsByAgent)) {
      for (const group of groups) {
        const qualified = qualifySettledGroup(bundle.hostId, group);
        const list = groupsByAgent[qualified.agentId] ?? [];
        list.push(qualified);
        groupsByAgent[qualified.agentId] = list;
      }
    }
  }

  return {
    apiVersion: 1,
    epoch: "hub",
    revision,
    generatedAt: Date.now(),
    range,
    rangeStart,
    rangeEnd,
    complete,
    totalSeries,
    totalRuns,
    outcomeCounts,
    groupsByAgent,
  };
}

export function resolveOwner(qualified: string): { hostId: string; localId: string } | undefined {
  return splitQualifiedId(qualified);
}

export type HubChange = CollectorChange;
