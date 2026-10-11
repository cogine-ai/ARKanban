import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../../../src/contracts";
import { FlowBoard } from "./FlowBoard";

function activity(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", agentId: "writer", kind: "task", origin: "task_ledger", catalog: "operational", state: "active", outcome: "none", phase: "model", attention: "none", stage: "in_flight", freshness: "live", title: `Working record ${id}`, createdAt: 1, updatedAt: 10, lastObservedAt: 10, evidence: [], ...patch };
}

function render(items: ActivityItem[], options: { paused?: boolean; loading?: boolean } = {}) {
  return renderToStaticMarkup(createElement(FlowBoard, { items, schedules: [], range: "24h", kind: "all", query: "", onSelectActivity: () => {}, onSelectSeries: () => {}, onSelectOverflow: () => {}, onOpenIncomingOverflow: () => {}, ...options }));
}

describe("FlowBoard visible semantics", () => {
  it("renders only two named objects for a 600-record Agent and exposes all records through a count", () => {
    const html = render(Array.from({ length: 600 }, (_, index) => activity(String(index).padStart(3, "0"))));
    expect(html.match(/data-activity-id=/g)).toHaveLength(2);
    expect(html).toContain("data-current-records=\"600\"");
    expect(html).toContain("View all 600 in-progress records");
    expect(html).toContain("+598");
    expect(html).not.toContain("density-radar");
    expect(html).toContain("aria-expanded=\"false\"");
  });

  it("keeps approval Attempt identity in the index and lane without inflating the record total", () => {
    const html = render([activity("attempt", { kind: "attempt", phase: "waiting_approval", attention: "waiting", stage: "waiting" })]);
    expect(html.match(/data-activity-id=\"attempt\"/g)).toHaveLength(2);
    expect(html).toContain("data-current-records=\"1\"");
    expect(html.match(/data-kind=\"attempt\"/g)).toHaveLength(2);
    expect(html).toContain("Waiting approval");
    expect(html).not.toContain("Approve");
  });

  it("freezes running animation when the caller loses the live connection", () => {
    expect(render([activity("running")])).toContain("data-live=\"true\"");
    const frozen = render([activity("running")], { paused: true });
    expect(frozen).not.toContain("data-live=\"true\"");
    expect(frozen).toContain("Last observed");
  });

  it("separates uncertain observations from the user attention index and from active lanes", () => {
    const html = render([activity("stale", { freshness: "stale", phase: "waiting_approval" })]);
    expect(html).toContain("Unconfirmed state");
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("data-activity-id=");
    expect(html).toContain("Current state unconfirmed");
  });

  it("distinguishes initial loading from a loaded empty board", () => {
    expect(render([], { loading: true })).toContain("Loading activity");
    expect(render([], { loading: false })).toContain("No current activity");
  });
});
