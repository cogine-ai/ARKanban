import type { ActivityItem, SettledGroupSnapshot, SettledGroupSummary, UpcomingSchedule } from "../../../src/contracts";
import type { KindFilter } from "./board";

export type CurrentLane = { key: string; hostId: string; agentId: string; running: ActivityItem[]; queued: ActivityItem[] };
export type HistoryLane = { key: string; hostId: string; agentId: string; groups: SettledGroupSummary[] };

export function laneIdentity(hostId: string, agentId: string): string {
  return JSON.stringify([hostId, agentId]);
}

export function activityIdentity(item: ActivityItem): string {
  return JSON.stringify([item.hostId, item.id]);
}

/** Hub identities remain qualified for requests; labels omit the owning host prefix. */
export function displayedAgent(hostId: string, agentId: string): string {
  const prefix = `${hostId}::`;
  return agentId.startsWith(prefix) ? agentId.slice(prefix.length) : agentId;
}

export function isUnconfirmed(item: ActivityItem): boolean {
  return item.state === "unknown" || item.stage === "unresolved"
    || item.freshness === "stale" || item.attention === "stale" || item.attention === "partial";
}

export function isAwaitingApproval(item: ActivityItem): boolean {
  return item.state === "active" && !isUnconfirmed(item)
    && (item.phase === "waiting_approval" || item.attention === "waiting");
}

function matchesKind(kind: KindFilter, item: { kind: ActivityItem["kind"] }): boolean {
  return kind === "all" || item.kind === kind;
}

function matchesQuery(query: string, item: { title: string; hostId: string; agentId: string; lastToolName?: string }): boolean {
  return !query || `${item.title} ${item.hostId} ${item.agentId} ${item.lastToolName ?? ""}`.toLowerCase().includes(query);
}

/** Queue admission and identity remain stable when events update an activity. */
function compareActivity(left: ActivityItem, right: ActivityItem): number {
  return (left.createdAt ?? 0) - (right.createdAt ?? 0)
    || activityIdentity(left).localeCompare(activityIdentity(right));
}

export function buildFlowBoardModel(items: ActivityItem[], schedules: UpcomingSchedule[], settled: SettledGroupSnapshot | undefined, kind: KindFilter, query: string) {
  const lowered = query.trim().toLowerCase();
  const laneMap = new Map<string, CurrentLane>();
  const historyMap = new Map<string, HistoryLane>();
  const attention: ActivityItem[] = [];
  const unconfirmed: ActivityItem[] = [];
  const seen = new Set<string>();
  let operationalCount = 0;
  for (const item of items) {
    if (item.state === "terminal" || item.stage === "settled" || item.catalog === "terminal_history") continue;
    if (!matchesKind(kind, item) || !matchesQuery(lowered, item)) continue;
    const identity = activityIdentity(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    operationalCount += 1;
    if (isUnconfirmed(item)) { unconfirmed.push(item); continue; }
    if (isAwaitingApproval(item)) attention.push(item);
    const key = laneIdentity(item.hostId, item.agentId);
    const lane = laneMap.get(key) ?? { key, hostId: item.hostId, agentId: item.agentId, running: [], queued: [] };
    if (item.state === "queued") lane.queued.push(item);
    else lane.running.push(item);
    laneMap.set(key, lane);
  }
  for (const groups of Object.values(settled?.groupsByAgent ?? {})) {
    for (const group of groups) {
      if (!matchesKind(kind, group) || !matchesQuery(lowered, group)) continue;
      const key = laneIdentity(group.hostId, group.agentId);
      const lane = historyMap.get(key) ?? { key, hostId: group.hostId, agentId: group.agentId, groups: [] };
      lane.groups.push(group);
      historyMap.set(key, lane);
    }
  }
  // Attention and workload do not reorder Agent lanes as events arrive.
  const lanes = [...laneMap.values()].sort((left, right) => left.key.localeCompare(right.key));
  for (const lane of lanes) { lane.running.sort(compareActivity); lane.queued.sort(compareActivity); }
  const history = [...historyMap.values()].sort((left, right) => left.key.localeCompare(right.key));
  const outcomes = { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, blocked: 0, unknown: 0 };
  let seriesCount = 0;
  let runCount = 0;
  for (const lane of history) {
    seriesCount += lane.groups.length;
    for (const group of lane.groups) {
      runCount += group.runCount;
      outcomes.succeeded += group.succeededCount;
      outcomes.failed += group.failedCount;
      outcomes.timedOut += group.timedOutCount;
      outcomes.cancelled += group.cancelledCount;
      outcomes.blocked += group.blockedCount;
      outcomes.unknown += group.unknownCount;
    }
  }
  return {
    lanes, attention: attention.sort(compareActivity), unconfirmed: unconfirmed.sort(compareActivity), history,
    schedules: kind === "all" ? schedules.filter((schedule) => matchesQuery(lowered, schedule))
      .sort((left, right) => left.nextRunAt - right.nextRunAt || left.id.localeCompare(right.id)) : [],
    operationalCount, seriesCount, runCount, outcomes,
  };
}

/** Capacity limits named objects, never the size of an object. */
export function currentPreview(items: ActivityItem[], capacity: number, selectedId?: string) {
  const visible = items.slice(0, capacity);
  const selected = selectedId ? items.find((item) => item.id === selectedId) : undefined;
  if (selected && !visible.includes(selected) && visible.length > 0) visible[visible.length - 1] = selected;
  return { visible, hiddenCount: items.length - visible.length };
}

export function pageOf<T>(items: T[], requestedPage: number, pageSize: number = 20) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  return { entries: items.slice(page * pageSize, (page + 1) * pageSize), page, pageCount };
}
