import type { ActivitySnapshot, AgentOverview, CollectorStatus, UpcomingSchedule } from "../../../src/contracts";

export type AgentFilter = "all" | "running" | "attention" | "idle";
export type AgentLiveCounts = { running: number; attention: number; schedules: UpcomingSchedule[] };
export const EMPTY_AGENT_LIVE: AgentLiveCounts = { running: 0, attention: 0, schedules: [] };

/** Match the owner as well as the name: two collectors may publish the same agent ID. */
export function agentIdentity(hostId: string, agentId: string): string {
  return JSON.stringify([hostId, agentId]);
}

export function liveCountsByAgent(snapshot: ActivitySnapshot | undefined): Map<string, AgentLiveCounts> {
  const byAgent = new Map<string, AgentLiveCounts>();
  const of = (hostId: string, agentId: string): AgentLiveCounts => {
    const key = agentIdentity(hostId, agentId);
    const existing = byAgent.get(key) ?? { running: 0, attention: 0, schedules: [] };
    byAgent.set(key, existing);
    return existing;
  };
  for (const item of snapshot?.items ?? []) {
    if (item.state === "terminal") continue;
    const counts = of(item.hostId, item.agentId);
    if (item.state === "active") counts.running += 1;
    if (item.attention !== "none") counts.attention += 1;
  }
  for (const schedule of snapshot?.schedule.items ?? []) of(schedule.hostId, schedule.agentId).schedules.push(schedule);
  return byAgent;
}

export function matchesAgentFilter(filter: AgentFilter, counts: AgentLiveCounts | undefined): boolean {
  if (filter === "all") return true;
  if (!counts) return false;
  if (filter === "running") return counts.running > 0;
  if (filter === "attention") return counts.attention > 0;
  return counts.running === 0 && counts.attention === 0;
}

/** A retained active row is evidence of an earlier run, not proof it is still running. */
export function isAgentObservable(agent: Pick<AgentOverview, "hostId">, status: CollectorStatus | undefined): boolean {
  if (!status) return false;
  const owner = status.hosts?.find((host) => host.id === agent.hostId);
  if (owner) return owner.reachable && owner.syncState === "live" && owner.gatewayConnected === true;
  return status.host.role !== "hub" && status.host.id === agent.hostId && status.syncState === "live" && status.gateway.connected;
}

export function countsForAgent(agent: Pick<AgentOverview, "id" | "hostId">, counts: Map<string, AgentLiveCounts>, snapshot: ActivitySnapshot | undefined, status: CollectorStatus | undefined): AgentLiveCounts | undefined {
  if (!snapshot || !isAgentObservable(agent, status)) return undefined;
  if (status?.host.role === "hub") {
    // Hub snapshots retain the owning node's reason, but not its source list.
    // This reason means at least one unavailable source, so complete activity
    // coverage cannot be assumed. It must not affect other nodes' agents.
    if (snapshot.sync.reasons.includes(`${agent.hostId}:live_with_unavailable_source`)) return undefined;
  } else if (!status?.sources.some((source) => source.state === "live")) {
    // A connected Gateway may expose only roster/cron methods. Neither an empty
    // activity snapshot nor an earlier active row then proves the agent's state.
    return undefined;
  }
  return counts.get(agentIdentity(agent.hostId, agent.id)) ?? EMPTY_AGENT_LIVE;
}

/** Cron coverage is independent of the task, session and event sources. */
export function schedulesForAgent(agent: Pick<AgentOverview, "id" | "hostId">, snapshot: ActivitySnapshot | undefined, status: CollectorStatus | undefined): UpcomingSchedule[] | undefined {
  if (!snapshot || !isAgentObservable(agent, status) || !["live", "partial"].includes(snapshot.schedule.state)) return undefined;
  const schedules = snapshot.schedule.items.filter((schedule) => schedule.hostId === agent.hostId && schedule.agentId === agent.id);
  // Aggregate Cron state cannot establish that an individual node has no jobs.
  if (schedules.length === 0 && status?.host.role === "hub") return undefined;
  return schedules;
}

export function matchesAgentSearch(agent: AgentOverview, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || [agent.displayName, agent.id, agent.hostId, agent.model, agent.runtime]
    .some((value) => value?.toLocaleLowerCase().includes(needle));
}

export function sortAgents(agents: AgentOverview[], live: Map<string, AgentLiveCounts>): AgentOverview[] {
  const counts = (agent: AgentOverview) => live.get(agentIdentity(agent.hostId, agent.id)) ?? EMPTY_AGENT_LIVE;
  return [...agents].sort((left, right) => (
    counts(right).attention - counts(left).attention
    || counts(right).running - counts(left).running
    || (right.lastSessionActivityAt ?? right.lastActivityAt ?? 0) - (left.lastSessionActivityAt ?? left.lastActivityAt ?? 0)
    || left.displayName.localeCompare(right.displayName)
    || agentIdentity(left.hostId, left.id).localeCompare(agentIdentity(right.hostId, right.id))
  ));
}
