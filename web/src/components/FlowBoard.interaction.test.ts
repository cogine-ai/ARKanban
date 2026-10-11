// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, SettledGroupSnapshot } from "../../../src/contracts";
import { FlowBoard } from "./FlowBoard";

function activity(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", agentId: "writer", kind: "task", origin: "task_ledger", catalog: "operational", state: "active", outcome: "none", phase: "model", attention: "none", stage: "in_flight", freshness: "live", title: `Working record ${id}`, createdAt: 1, updatedAt: 10, lastObservedAt: 10, evidence: [], ...patch };
}

describe("FlowBoard record expansion", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount(items: ActivityItem[], onSelectActivity = vi.fn(), settled?: SettledGroupSnapshot) {
    await act(async () => root.render(createElement(FlowBoard, { items, schedules: [], settled, range: "24h", kind: "all", query: "", onSelectActivity, onSelectSeries: onSelectActivity, onSelectOverflow: () => {}, onOpenIncomingOverflow: () => {} })));
    return onSelectActivity;
  }

  it("opens a complete 600-record collection with 20-record pages and selects the correct page item", async () => {
    const selected = await mount(Array.from({ length: 600 }, (_, index) => activity(String(index).padStart(3, "0"))));
    await act(async () => container.querySelector<HTMLButtonElement>(".lfb-more")!.click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain("600 RECORDS");
    expect(dialog.querySelectorAll("[data-activity-id]")).toHaveLength(20);
    expect(dialog.querySelector("[data-activity-id=\"000\"]")).not.toBeNull();
    await act(async () => dialog.querySelector<HTMLButtonElement>("[aria-label=\"Next records page\"]")!.click());
    expect(dialog.querySelectorAll("[data-activity-id]")).toHaveLength(20);
    expect(dialog.querySelector("[data-activity-id=\"020\"]")).not.toBeNull();
    await act(async () => dialog.querySelector<HTMLButtonElement>("[data-activity-id=\"020\"]")!.click());
    expect(selected).toHaveBeenCalledExactlyOnceWith("020");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("opens stale approval-shaped evidence as an unconfirmed object rather than an approval action", async () => {
    await mount([activity("stale", { kind: "attempt", phase: "waiting_approval", freshness: "stale" })]);
    await act(async () => container.querySelector<HTMLButtonElement>(".lfb-unconfirmed-row")!.click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain("Unconfirmed state");
    expect(dialog.textContent).toContain("Stale observation");
    expect(dialog.textContent).toContain("Attempt");
    expect(dialog.textContent).not.toContain("Waiting approval");
    expect(dialog.querySelectorAll(".lfb-state-running")).toHaveLength(0);
  });

  it("keeps history collapsed, preserves unknown outcomes, and retains the series detail action", async () => {
    const settled: SettledGroupSnapshot = {
      apiVersion: 1, epoch: "test", revision: 1, generatedAt: 10, range: "24h", rangeStart: 1, rangeEnd: 10, complete: false, totalSeries: 1, totalRuns: 2,
      outcomeCounts: { none: 0, succeeded: 1, unknown: 1, failed: 0, cancelled: 0, timed_out: 0, blocked: 0 },
      groupsByAgent: { writer: [{ seriesKey: "mixed", hostId: "desk", agentId: "writer", kind: "task", title: "Repeated report", groupingConfidence: "display_exact", rangeStart: 1, rangeEnd: 10, runCount: 2, succeededCount: 1, unknownCount: 1, failedCount: 0, timedOutCount: 0, blockedCount: 0, cancelledCount: 0, latestActivityId: "ended", latestOutcome: "unknown", latestEndedAt: 10, failureRate: 0, priorityTier: "P1" }] },
    };
    const selected = await mount([], vi.fn(), settled);
    expect(container.querySelector("[data-series-key]")).toBeNull();
    expect(container.querySelector("[aria-label=\"Unknown: 1\"]")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".lfb-history-toggle")!.click());
    const series = container.querySelector<HTMLButtonElement>("[data-series-key=\"mixed\"]")!;
    expect(series.textContent).toContain("Repeated report");
    expect(series.textContent).toContain("?1");
    await act(async () => series.click());
    expect(selected).toHaveBeenCalledExactlyOnceWith("mixed");
  });
});
