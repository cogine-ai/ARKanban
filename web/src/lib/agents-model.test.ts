import { describe, expect, it } from "vitest";
import type { ActivityItem, ActivitySnapshot, AgentOverview, CollectorStatus } from "../../../src/contracts";
import { agentIdentity, countsForAgent, isAgentObservable, liveCountsByAgent, matchesAgentFilter, matchesAgentSearch, schedulesForAgent, sortAgents } from "./agents-model";

function activity(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", agentId: "writer", kind: "task", origin: "task_ledger", catalog: "operational", state: "active", outcome: "none", phase: "model", attention: "none", stage: "in_flight", freshness: "live", title: id, createdAt: 1, updatedAt: 10, lastObservedAt: 10, evidence: [], ...patch };
}
function agent(id: string, patch: Partial<AgentOverview> = {}): AgentOverview {
  return { id, hostId: "desk", displayName: id, ...patch } as AgentOverview;
}
function snapshot(items: ActivityItem[]): ActivitySnapshot {
  return {
    apiVersion: 1, epoch: "test", revision: 1, generatedAt: 100, items,
    sync: { state: "live", reasons: [] }, summary: { incoming: 0, inFlight: 0, waiting: 0, settled: 0, unresolved: 0 }, lanes: [], relations: [],
    schedule: { revision: 1, state: "live", schedulerEnabled: true, windowMinutes: 60, dueGraceMinutes: 3, items: [{ id: "cron", hostId: "remote", agentId: "writer", jobId: "daily", title: "Daily", nextRunAt: 200, scheduleKind: "cron" }] },
  };
}
function status(patch: Partial<CollectorStatus> = {}): CollectorStatus {
  return { host: { id: "desk", label: "Desktop", role: "node" }, gateway: { connected: true }, syncState: "live", syncReasons: [], sources: (["tasks", "sessions", "events"] as const).map((source) => ({ source, state: "live" as const })), ...patch } as CollectorStatus;
}

describe("Agent roster signals", () => {
  it("keeps identical names on different machines separate and excludes terminal attention", () => {
    const counts = liveCountsByAgent(snapshot([
      activity("local"), activity("remote", { hostId: "remote", attention: "waiting" }),
      activity("done", { state: "terminal", attention: "blocked" }),
      activity("queued", { state: "queued", attention: "partial" }),
    ]));
    expect(counts.get(agentIdentity("desk", "writer"))).toMatchObject({ running: 1, attention: 1, schedules: [] });
    expect(counts.get(agentIdentity("remote", "writer"))).toMatchObject({ running: 1, attention: 1 });
    expect(counts.get(agentIdentity("remote", "writer"))?.schedules).toHaveLength(1);
    expect(agentIdentity("a:b", "c")).not.toBe(agentIdentity("a", "b:c"));
  });

  it("does not turn missing snapshots or an unreachable Hub node into idle", () => {
    const entry = agent("writer");
    expect(countsForAgent(entry, new Map(), undefined, undefined)).toBeUndefined();
    expect(countsForAgent(entry, new Map(), snapshot([]), status({ hosts: [{ id: "desk", label: "Desktop", reachable: false, syncState: "offline", gatewayConnected: false }] }))).toBeUndefined();
    expect(matchesAgentFilter("idle", undefined)).toBe(false);
    expect(matchesAgentFilter("running", undefined)).toBe(false);
    expect(matchesAgentFilter("all", undefined)).toBe(true);
    expect(countsForAgent(entry, new Map(), snapshot([]), undefined)).toBeUndefined();
    expect(countsForAgent(entry, new Map(), snapshot([]), status())).toEqual({ running: 0, attention: 0, schedules: [] });
  });

  it("separates run state from active session counts and allows attention while running", () => {
    const quiet = countsForAgent(agent("writer", { activeSessionCount: 9 }), new Map(), snapshot([]), status());
    expect(matchesAgentFilter("running", quiet)).toBe(false);
    expect(matchesAgentFilter("idle", quiet)).toBe(true);
    const running = { running: 2, attention: 1, schedules: [] };
    expect(matchesAgentFilter("running", running)).toBe(true);
    expect(matchesAgentFilter("attention", running)).toBe(true);
    expect(matchesAgentFilter("idle", running)).toBe(false);
  });

  it("withholds retained running signals when the node's Gateway or synchronization is offline", () => {
    const entry = agent("writer");
    const counts = liveCountsByAgent(snapshot([activity("retained-run")]));
    expect(countsForAgent(entry, counts, snapshot([]), status({ syncState: "offline" }))).toBeUndefined();
    expect(countsForAgent(entry, counts, snapshot([]), status({ gateway: { connected: false } as CollectorStatus["gateway"] }))).toBeUndefined();
    expect(countsForAgent(entry, counts, snapshot([]), status({ syncState: "reconciling" }))).toBeUndefined();
    expect(isAgentObservable(agent("writer", { hostId: "unrecognized" }), status())).toBe(false);
  });

  it("checks a Hub node's own live coverage instead of the Hub's aggregate live state", () => {
    const counts = liveCountsByAgent(snapshot([activity("old-run")]));
    const hub = status({ host: { id: "hub", label: "Hub", role: "hub" }, hosts: [
      { id: "desk", label: "Desktop", reachable: true, syncState: "offline", gatewayConnected: false },
      { id: "remote", label: "Remote", reachable: true, syncState: "live", gatewayConnected: true },
    ] });
    expect(countsForAgent(agent("writer"), counts, snapshot([]), hub)).toBeUndefined();
    expect(isAgentObservable(agent("writer", { hostId: "remote" }), hub)).toBe(true);
    expect(isAgentObservable(agent("writer", { hostId: "missing" }), hub)).toBe(false);
  });

  it("does not claim idle or retained running when every activity source is unavailable", () => {
    const entry = agent("writer");
    const unavailable = status({ syncReasons: ["live_with_unavailable_source"], sources: [
      { source: "tasks", state: "unavailable" }, { source: "sessions", state: "unavailable" }, { source: "events", state: "unavailable" },
    ] });
    const retained = snapshot([activity("earlier-run")]);
    const counts = liveCountsByAgent(retained);
    expect(countsForAgent(entry, new Map(), snapshot([]), unavailable)).toBeUndefined();
    expect(countsForAgent(entry, counts, retained, unavailable)).toBeUndefined();
    expect(matchesAgentFilter("idle", countsForAgent(entry, counts, retained, unavailable))).toBe(false);
    expect(matchesAgentFilter("running", countsForAgent(entry, counts, retained, unavailable))).toBe(false);
    expect(countsForAgent(entry, counts, retained, status({ sources: [] }))).toBeUndefined();
    expect(countsForAgent(entry, counts, retained, status({ sources: [{ source: "sessions", state: "live" }, { source: "tasks", state: "unavailable" }, { source: "events", state: "unavailable" }] }))?.running).toBe(1);
  });

  it("scopes Hub source uncertainty to the owner while retaining separately observed Cron", () => {
    const partial = snapshot([activity("earlier-run", { agentId: "desk::writer" })]);
    partial.sync.reasons = ["desk:live_with_unavailable_source"];
    partial.schedule = { state: "live", schedulerEnabled: true, revision: 1, windowMinutes: 60, dueGraceMinutes: 3, items: [
      { id: "desk::job", jobId: "job", agentId: "desk::writer", hostId: "desk", title: "Daily", nextRunAt: 200, scheduleKind: "cron" },
    ] };
    const hub = status({ host: { id: "hub", label: "Hub", role: "hub" }, sources: [], syncReasons: ["live_with_unavailable_source"], hosts: [
      { id: "desk", label: "Desktop", reachable: true, syncState: "live", gatewayConnected: true },
      { id: "remote", label: "Remote", reachable: true, syncState: "live", gatewayConnected: true },
    ] });
    const counts = liveCountsByAgent(partial);
    const owner = agent("desk::writer");
    expect(countsForAgent(owner, counts, partial, hub)).toBeUndefined();
    expect(countsForAgent(agent("remote::writer", { hostId: "remote" }), counts, partial, hub)).toEqual({ running: 0, attention: 0, schedules: [] });
    expect(schedulesForAgent(owner, partial, hub)).toEqual(partial.schedule.items);
    expect(schedulesForAgent(agent("remote::writer", { hostId: "remote" }), partial, hub)).toBeUndefined();
  });

  it("uses the local activity sources when role is both, which currently runs a single Collector", () => {
    const local = agent("writer");
    const observed = snapshot([]);
    const both = status({ host: { id: "desk", label: "Desktop", role: "both" }, sources: [
      { source: "tasks", state: "unavailable" }, { source: "sessions", state: "unavailable" }, { source: "events", state: "unavailable" },
    ] });
    expect(countsForAgent(local, new Map(), observed, both)).toBeUndefined();
    both.sources = [{ source: "sessions", state: "live" }];
    expect(countsForAgent(local, new Map(), observed, both)).toEqual({ running: 0, attention: 0, schedules: [] });
    expect(countsForAgent(agent("remote::writer", { hostId: "remote" }), new Map(), observed, both)).toBeUndefined();
  });

  it("keeps local Cron coverage independent and rejects forecasts from an unavailable owner", () => {
    const entry = agent("writer", { hostId: "remote" });
    const forecast = snapshot([]);
    forecast.schedule.state = "live";
    const sourceUnavailable = status({ host: { id: "remote", label: "Remote", role: "node" }, sources: [
      { source: "tasks", state: "unavailable" }, { source: "sessions", state: "unavailable" }, { source: "events", state: "unavailable" },
    ] });
    expect(schedulesForAgent(entry, forecast, sourceUnavailable)).toEqual(forecast.schedule.items);
    expect(schedulesForAgent(entry, forecast, { ...sourceUnavailable, gateway: { connected: false } as CollectorStatus["gateway"] })).toBeUndefined();
    forecast.schedule.state = "error";
    expect(schedulesForAgent(entry, forecast, sourceUnavailable)).toBeUndefined();
  });

  it("finds names, exact identities, machine and runtime without guessing agent kind", () => {
    const entry = agent("desk::writer", { displayName: "日报助手", hostId: "Desk West", runtime: "OpenClaw", model: "Example Model", kind: "unknown" });
    expect(matchesAgentSearch(entry, " 日报 ")).toBe(true);
    expect(matchesAgentSearch(entry, "desk::writer")).toBe(true);
    expect(matchesAgentSearch(entry, "WEST")).toBe(true);
    expect(matchesAgentSearch(entry, "example model")).toBe(true);
    expect(matchesAgentSearch(entry, "system")).toBe(false);
  });

  it("orders attention then real running without mutating roster or promoting active sessions", () => {
    const entries = [agent("quiet", { activeSessionCount: 100 }), agent("busy"), agent("blocked")];
    const live = new Map([
      [agentIdentity("desk", "busy"), { running: 2, attention: 0, schedules: [] }],
      [agentIdentity("desk", "blocked"), { running: 0, attention: 1, schedules: [] }],
    ]);
    expect(sortAgents(entries, live).map((entry) => entry.id)).toEqual(["blocked", "busy", "quiet"]);
    expect(entries.map((entry) => entry.id)).toEqual(["quiet", "busy", "blocked"]);
  });
});
