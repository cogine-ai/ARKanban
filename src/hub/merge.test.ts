import { describe, expect, it } from "vitest";
import type { ActivitySnapshot, CollectorStatus, SettledGroupSnapshot, SettledRange } from "../contracts.js";
import { mergeSettledGroups, mergeSnapshots, mergeStatus, qualifyActivity } from "./merge.js";

function status(hostId: string, syncState: CollectorStatus["syncState"] = "live"): CollectorStatus {
  return {
    apiVersion: 1,
    process: { version: "0.1.0", startedAt: 1, ready: true },
    host: { id: hostId, label: hostId, role: "node" },
    epoch: "e",
    revision: 1,
    syncState,
    syncReasons: [],
    gateway: {
      name: hostId,
      endpoint: "ws://127.0.0.1:18789",
      connected: syncState === "live",
      grantedScopes: ["operator.read"],
    },
    sources: [],
  };
}

function snapshot(hostId: string, id: string): ActivitySnapshot {
  return {
    apiVersion: 1,
    epoch: "e",
    revision: 2,
    generatedAt: 1,
    sync: { state: "live", reasons: [] },
    summary: { incoming: 0, inFlight: 1, waiting: 0, settled: 0, unresolved: 0 },
    lanes: [],
    items: [
      {
        id,
        hostId,
        kind: "attempt",
        origin: "online",
        catalog: "operational",
        agentId: "main",
        state: "active",
        outcome: "none",
        phase: "model",
        attention: "none",
        stage: "in_flight",
        freshness: "live",
        title: `${hostId} run`,
        updatedAt: 1,
        lastObservedAt: 1,
        evidence: [],
      },
    ],
    relations: [],
    schedule: {
      revision: 0,
      state: "live",
      schedulerEnabled: true,
      windowMinutes: 60,
      dueGraceMinutes: 3,
      items: [],
    },
  };
}

describe("hub merge", () => {
  it("qualifies activity ids per host", () => {
    const item = qualifyActivity("host-b", snapshot("host-b", "attempt:ri_1").items[0]!);
    expect(item.id).toBe("host-b::attempt:ri_1");
    expect(item.agentId).toBe("host-b::main");
  });

  it("merges snapshots from reachable hosts and keeps unreachable visible in status", () => {
    const bundles = [
      {
        hostId: "a",
        label: "A",
        reachable: true,
        status: status("a"),
        snapshot: snapshot("a", "attempt:ri_1"),
        lastSeenAt: 10,
      },
      {
        hostId: "b",
        label: "B",
        reachable: false,
        code: "node_b_http_500",
        lastSeenAt: 9,
      },
    ];
    const merged = mergeSnapshots(bundles);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]?.id).toBe("a::attempt:ri_1");
    expect(merged.sync.reasons).toContain("host_unreachable:b");

    const hubStatus = mergeStatus({ id: "hub", label: "hub", role: "hub" }, 1, bundles);
    expect(hubStatus.hosts).toHaveLength(2);
    expect(hubStatus.hosts?.[1]).toMatchObject({ id: "b", reachable: false, code: "node_b_http_500" });
    expect(hubStatus.gateway.endpoint).toBe("hub://fan-in");
  });

  it("does not count settled data from unreachable hosts", () => {
    const rangeEnd = 7_000;
    const bundles = [
      {
        hostId: "a",
        label: "A",
        reachable: true,
        settled: settledSnapshot("a", "7d", rangeEnd, 4),
      },
      {
        hostId: "b",
        label: "B",
        reachable: false,
        settled: settledSnapshot("b", "7d", rangeEnd, 10),
      },
    ];
    const merged = mergeSettledGroups("7d", rangeEnd, bundles);
    expect(merged.totalRuns).toBe(4);
    expect(merged.complete).toBe(false);
    expect(Object.keys(merged.groupsByAgent)).toEqual(["a::main"]);
  });
});

function settledSnapshot(hostId: string, range: SettledRange, rangeEnd: number, runs: number): SettledGroupSnapshot {
  return {
    apiVersion: 1,
    epoch: "e",
    revision: 1,
    generatedAt: 1,
    range,
    rangeStart: 0,
    rangeEnd,
    complete: true,
    totalSeries: 1,
    totalRuns: runs,
    outcomeCounts: { none: 0, succeeded: runs, failed: 0, cancelled: 0, timed_out: 0, blocked: 0, unknown: 0 },
    groupsByAgent: {
      main: [
        {
          seriesKey: "s1",
          hostId,
          groupingConfidence: "canonical",
          agentId: "main",
          kind: "attempt",
          title: "run",
          rangeStart: 0,
          rangeEnd,
          runCount: runs,
          succeededCount: runs,
          failedCount: 0,
          timedOutCount: 0,
          cancelledCount: 0,
          blockedCount: 0,
          unknownCount: 0,
          latestActivityId: "a1",
          latestOutcome: "succeeded",
          latestEndedAt: 1,
          failureRate: 0,
          priorityTier: "P2",
        },
      ],
    },
  };
}
