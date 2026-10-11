import type { ActivityItem, ActivityOutcome, AgentSummary, CollectorStatus } from "../../../src/contracts";
import { calendarDay } from "./format";
import { displayedAgent } from "./flow-board-model";

export const ARCHIVE_PAGE_SIZE = 24;
export const ARCHIVE_RESULTS: readonly ActivityOutcome[] = ["succeeded", "failed", "timed_out", "blocked", "cancelled", "unknown", "none"];
export type ArchiveFilters = { query: string; outcome: "all" | ActivityOutcome; agent: string };

const RESULTS: Record<ActivityOutcome, { label: string; symbol: string }> = {
  succeeded: { label: "Succeeded", symbol: "✓" },
  failed: { label: "Failed", symbol: "×" },
  timed_out: { label: "Timed out", symbol: "◷" },
  blocked: { label: "Blocked", symbol: "Ⅱ" },
  cancelled: { label: "Cancelled", symbol: "−" },
  unknown: { label: "Unknown", symbol: "?" },
  none: { label: "Unreported", symbol: "—" },
};

export function archiveResult(outcome: ActivityOutcome) { return RESULTS[outcome]; }
export function archiveTimestamp(item: ActivityItem): number { return item.endedAt ?? item.updatedAt; }
export function archiveAgentKey(hostId: string, agentId: string): string { return JSON.stringify([hostId, agentId]); }

export function archiveHostLabels(status?: CollectorStatus): Map<string, string> {
  const labels = new Map<string, string>();
  if (status) {
    labels.set(status.host.id, status.host.label);
    for (const host of status.hosts ?? []) labels.set(host.id, host.label);
  }
  const occurrences = new Map<string, number>();
  for (const label of labels.values()) occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  for (const [id, label] of labels) {
    if ((occurrences.get(label) ?? 0) > 1) labels.set(id, `${label} · ${id}`);
  }
  return labels;
}

export function archiveAgentName(item: Pick<ActivityItem, "hostId" | "agentId">, agents?: AgentSummary[]): string {
  return agents?.find((agent) => agent.id === item.agentId && agent.hostId === item.hostId)?.displayName
    || displayedAgent(item.hostId, item.agentId);
}

export function archiveAgentChoices(items: ActivityItem[], agents?: AgentSummary[], hostLabels = new Map<string, string>()): Array<{ value: string; label: string; agentLabel: string }> {
  const identities = new Map<string, { hostId: string; agentId: string; name: string }>();
  for (const item of items) identities.set(archiveAgentKey(item.hostId, item.agentId), { hostId: item.hostId, agentId: item.agentId, name: archiveAgentName(item, agents) });
  const nameCounts = new Map<string, number>();
  for (const identity of identities.values()) {
    const nameKey = JSON.stringify([identity.hostId, identity.name]);
    nameCounts.set(nameKey, (nameCounts.get(nameKey) ?? 0) + 1);
  }
  const multiHost = new Set(items.map((item) => item.hostId)).size > 1;
  return [...identities].map(([value, identity]) => {
    const duplicate = (nameCounts.get(JSON.stringify([identity.hostId, identity.name])) ?? 0) > 1;
    const agentLabel = duplicate ? `${identity.name} · ${displayedAgent(identity.hostId, identity.agentId)}` : identity.name;
    return { value, agentLabel, label: multiHost ? `${agentLabel} · ${hostLabels.get(identity.hostId) || identity.hostId}` : agentLabel };
  }).sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
}

/** Filters only terminal rows in the current snapshot; this is not a database history query. */
export function filterArchive(items: ActivityItem[], filters: ArchiveFilters, agents?: AgentSummary[], hostLabels = new Map<string, string>()): ActivityItem[] {
  const needle = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => item.state === "terminal"
    && (filters.outcome === "all" || item.outcome === filters.outcome)
    && (!filters.agent || archiveAgentKey(item.hostId, item.agentId) === filters.agent)
    && (!needle || `${item.title} ${archiveAgentName(item, agents)} ${item.agentId} ${item.hostId} ${hostLabels.get(item.hostId) ?? ""}`.toLocaleLowerCase().includes(needle)))
    .sort((left, right) => archiveTimestamp(right) - archiveTimestamp(left) || JSON.stringify([left.hostId, left.id]).localeCompare(JSON.stringify([right.hostId, right.id])));
}

export function groupArchiveByDay(items: ActivityItem[], now = Date.now()): Array<{ key: string; label: string; items: ActivityItem[] }> {
  const today = calendarDay(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const previousDay = calendarDay(yesterday.getTime());
  const groups = new Map<string, { key: string; label: string; items: ActivityItem[] }>();
  for (const item of items) {
    const timestamp = archiveTimestamp(item);
    const key = calendarDay(timestamp);
    const label = key === today ? "Today" : key === previousDay ? "Yesterday" : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(timestamp);
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Zero is a valid instant and must not be treated as an unobserved timestamp. */
export function archiveRelativeTime(value: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - value) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function archiveExactTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(value);
}
