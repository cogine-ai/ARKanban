import { describe, expect, it } from "vitest";
import type { ActivityItem, SettledGroupSnapshot, SettledGroupSummary, UpcomingSchedule } from "../../../src/contracts";
import { activityIdentity, buildFlowBoardModel, currentPreview, displayedAgent, isAwaitingApproval, pageOf } from "./flow-board-model";

function activity(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", agentId: "writer", kind: "task", origin: "task_ledger", catalog: "operational", state: "active", outcome: "none", phase: "model", attention: "none", stage: "in_flight", freshness: "live", title: `Activity ${id}`, createdAt: 1, updatedAt: 10, lastObservedAt: 10, evidence: [], ...patch };
}

function group(patch: Partial<SettledGroupSummary> = {}): SettledGroupSummary {
  return { seriesKey: "daily-report", hostId: "desk", agentId: "writer", kind: "task", groupingConfidence: "display_exact", title: "Daily report", rangeStart: 1, rangeEnd: 10, runCount: 6, succeededCount: 1, failedCount: 1, timedOutCount: 1, cancelledCount: 1, blockedCount: 1, unknownCount: 1, latestActivityId: "ended", latestOutcome: "unknown", latestEndedAt: 10, failureRate: 0.3, priorityTier: "P0", ...patch };
}

function history(groups: SettledGroupSummary[]): SettledGroupSnapshot {
  return { apiVersion: 1, epoch: "test", revision: 1, generatedAt: 10, range: "24h", rangeStart: 1, rangeEnd: 10, complete: false, totalSeries: groups.length, totalRuns: 600, outcomeCounts: { none: 0, succeeded: 100, failed: 100, timed_out: 100, cancelled: 100, blocked: 100, unknown: 100 }, groupsByAgent: { "aggregate-key": groups } };
}

describe("focus-first FlowBoard model", () => {
  it("indexes genuine approval waits without duplicating records or treating uncertain records as approvals", () => {
    const records = [
      activity("task"),
      activity("wait", { kind: "attempt", phase: "waiting_approval", attention: "waiting", stage: "waiting" }),
      activity("queue", { state: "queued", stage: "incoming" }),
      activity("unknown", { state: "unknown", stage: "unresolved" }),
      activity("stale", { freshness: "stale", phase: "waiting_approval" }),
      activity("partial", { attention: "partial", phase: "waiting_approval" }),
      activity("blocked", { state: "terminal", outcome: "blocked", stage: "settled", catalog: "terminal_history", attention: "blocked" }),
    ];
    const model = buildFlowBoardModel(records, [], undefined, "all", "");
    expect(model.operationalCount).toBe(6);
    expect(model.attention.map((item) => item.id)).toEqual(["wait"]);
    expect(model.attention[0]?.kind).toBe("attempt");
    expect(model.unconfirmed.map((item) => item.id)).toEqual(["partial", "stale", "unknown"]);
    expect(model.lanes.flatMap((lane) => lane.running).map((item) => item.id)).toEqual(["task", "wait"]);
    expect(model.lanes.flatMap((lane) => lane.queued).map((item) => item.id)).toEqual(["queue"]);
    expect(isAwaitingApproval(activity("queued-approval", { state: "queued", phase: "waiting_approval" }))).toBe(false);
  });

  it("preserves Task / Attempt and host partitions even when displayed names and local IDs match", () => {
    const model = buildFlowBoardModel([
      activity("same", { hostId: "a" }), activity("same", { hostId: "b" }),
      activity("execution", { hostId: "a", kind: "attempt", title: "Activity same" }),
    ], [], history([group({ hostId: "a" }), group({ hostId: "b" })]), "all", "");
    expect(model.lanes).toHaveLength(2);
    expect(model.operationalCount).toBe(3);
    expect(new Set(model.lanes.flatMap((lane) => lane.running).map(activityIdentity)).size).toBe(3);
    expect(model.history).toHaveLength(2);
    expect(model.seriesCount).toBe(2);
    expect(displayedAgent("a", "a::writer")).toBe("writer");
    expect(displayedAgent("a", "b::writer")).toBe("b::writer");
  });

  it("recomputes every history outcome and run count from the same kind / query scope", () => {
    const model = buildFlowBoardModel([], [], history([
      group(), group({ seriesKey: "attempt", kind: "attempt", runCount: 20, succeededCount: 20 }),
      group({ seriesKey: "other", title: "Other title", runCount: 30, succeededCount: 30 }),
    ]), "task", "daily");
    expect(model.seriesCount).toBe(1);
    expect(model.runCount).toBe(6);
    expect(model.outcomes).toEqual({ succeeded: 1, failed: 1, timedOut: 1, cancelled: 1, blocked: 1, unknown: 1 });
  });

  it("never turns an elapsed Cron forecast into an activity or includes forecasts in kind-filtered records", () => {
    const schedules: UpcomingSchedule[] = [{ id: "cron", hostId: "desk", jobId: "cron", agentId: "writer", title: "Daily report", nextRunAt: 1, scheduleKind: "cron" }];
    const model = buildFlowBoardModel([], schedules, undefined, "all", "");
    expect(model.schedules).toHaveLength(1);
    expect(model.operationalCount).toBe(0);
    expect(model.lanes).toHaveLength(0);
    expect(buildFlowBoardModel([], schedules, undefined, "task", "").schedules).toHaveLength(0);
  });

  it.each([4, 180, 600])("bounds the named preview at %i records and keeps a selected overflow record visible", (count) => {
    const records = Array.from({ length: count }, (_, index) => activity(String(index).padStart(3, "0")));
    const model = buildFlowBoardModel(records, [], undefined, "all", "");
    const preview = currentPreview(model.lanes[0]!.running, 2, records[count - 1]!.id);
    expect(preview.visible).toHaveLength(2);
    expect(preview.visible[1]?.id).toBe(records[count - 1]?.id);
    expect(preview.hiddenCount).toBe(count - 2);
    expect(model.operationalCount).toBe(count);
    const withHistory = buildFlowBoardModel(records, [], history(Array.from({ length: 500 }, (_, index) => group({ seriesKey: String(index) }))), "all", "");
    expect(currentPreview(withHistory.lanes[0]!.running, 2).visible).toEqual(currentPreview(model.lanes[0]!.running, 2).visible);
  });

  it("keeps list pages bounded and clamps a page after the result set shrinks", () => {
    expect(pageOf(Array.from({ length: 600 }, (_, index) => index), 100)).toEqual({ page: 29, pageCount: 30, entries: Array.from({ length: 20 }, (_, index) => 580 + index) });
    expect(pageOf([1, 2], 29)).toEqual({ page: 0, pageCount: 1, entries: [1, 2] });
    expect(pageOf([], 29)).toEqual({ page: 0, pageCount: 1, entries: [] });
  });

  it("does not reorder records or lanes when update timestamps and attention change", () => {
    const original = [activity("a", { agentId: "z" }), activity("b", { agentId: "a" }), activity("c", { agentId: "z" })];
    const updated = original.map((item, index) => ({ ...item, updatedAt: (3 - index) * 1_000, phase: "waiting_approval" as const, attention: "waiting" as const }));
    const ids = (records: ActivityItem[]) => buildFlowBoardModel(records, [], undefined, "all", "").lanes.map((lane) => [lane.key, lane.running.map((item) => item.id)]);
    expect(ids(updated)).toEqual(ids(original));
  });
});
