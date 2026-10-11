// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, AgentSummary, CollectorStatus } from "../../../src/contracts";
import { ARCHIVE_PAGE_SIZE, archiveAgentKey } from "../lib/archive-model";
import { ArchiveView, type ArchiveViewProps } from "./Archive";

function item(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", kind: "task", origin: "task_ledger", catalog: "terminal_history", agentId: "writer", state: "terminal", outcome: "succeeded", phase: "none", attention: "none", stage: "settled", freshness: "live", title: `Activity ${id}`, endedAt: Date.now(), updatedAt: Date.now(), lastObservedAt: Date.now(), evidence: [], ...patch };
}
const agents: AgentSummary[] = [
  { id: "writer", hostId: "desk", displayName: "Draft writer", kind: "agent", origin: "roster", firstObservedAt: 0 },
  { id: "writer", hostId: "lab", displayName: "Lab writer", kind: "agent", origin: "roster", firstObservedAt: 0 },
];

describe("Archive view", () => {
  let root: Root;
  let container: HTMLDivElement;
  const select = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const mount = async (props: Partial<ArchiveViewProps> = {}) => { await act(async () => root.render(createElement(ArchiveView, { onSelect: select, ...props }))); };
  const setSelect = async (name: string, value: string) => {
    const element = container.querySelector<HTMLSelectElement>(`select[aria-label='${name}']`)!;
    await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  const search = async (value: string) => {
    const element = container.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
  };

  it("distinguishes loading, a real empty snapshot and an unavailable initial history", async () => {
    await mount();
    expect(container.textContent).toContain("Loading history…");
    expect(container.textContent).not.toContain("No recent activity");
    await mount({ items: [] });
    expect(container.textContent).toContain("No recent activity");
    const retry = vi.fn();
    await mount({ error: "network failed", onRetry: retry });
    expect(container.querySelector("[role=alert]")?.textContent).toContain("History unavailable");
    expect(container.textContent).not.toContain("No recent activity");
    await act(async () => container.querySelector<HTMLButtonElement>(".archive-error button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await mount({ items: [], error: "refresh failed" });
    expect(container.textContent).toContain("History update unavailable");
    expect(container.textContent).not.toContain("No recent activity");
  });

  it("keeps recent rows during an update failure and scopes counts and search to the snapshot window", async () => {
    await mount({ items: [item("kept")], error: "stream disconnected" });
    expect(container.querySelectorAll(".archive-row")).toHaveLength(1);
    expect(container.textContent).toContain("History update unavailable");
    expect(container.textContent).toContain("1 recent");
    expect(container.querySelector(".archive-search .sr-only")?.textContent).toBe("Find recent activity");
    expect(container.querySelector(".archive-timeline")?.getAttribute("aria-label")).toBe("Recent activity history");
    expect(container.textContent).not.toContain("all time");
    expect(container.textContent).not.toContain("retained");
    await search("kept");
    expect(container.querySelector(".archive-result-toolbar")?.textContent).toContain("1 match in recent history");
  });

  it("renders all result states without a success check for an unconfirmed result", async () => {
    await mount({ items: [item("good"), item("unknown", { outcome: "unknown" }), item("none", { outcome: "none" }), item("cancelled", { outcome: "cancelled" }), item("failed", { outcome: "failed" }), item("timed_out", { outcome: "timed_out" }), item("blocked", { outcome: "blocked" })], agents });
    expect(container.querySelector(".archive-result-symbol[data-result=succeeded]")?.textContent).toBe("✓");
    expect(container.querySelector(".archive-result-symbol[data-result=unknown]")?.textContent).toBe("?");
    expect(container.querySelector(".archive-row-result[data-result=none]")?.textContent).toBe("Unreported");
    expect(container.querySelectorAll(".archive-result-symbol")).toHaveLength(7);
    expect(container.querySelectorAll(".archive-agent-name")[0]?.textContent).toBe("Draft writer");
  });

  it("labels only known end times as Ended and preserves a zero timestamp in the exact tooltip", async () => {
    await mount({ items: [item("epoch", { endedAt: 0 }), item("fallback", { endedAt: undefined, updatedAt: 0, lastObservedAt: 900_000 })] });
    const end = container.querySelector<HTMLTimeElement>("[data-activity-id=epoch] time")!;
    const updated = container.querySelector<HTMLTimeElement>("[data-activity-id=fallback] time")!;
    expect(end.dateTime).toBe("1970-01-01T00:00:00.000Z");
    expect(end.title).toMatch(/^Ended · /);
    expect(end.title).not.toContain("Not observed");
    expect(updated.title).toMatch(/^Updated · /);
    expect(updated.textContent).toContain("Updated");
    expect(updated.dateTime).toBe("1970-01-01T00:00:00.000Z");
  });

  it("intersects name search, outcome and host-aware agent filtering, and resets a zero result", async () => {
    await mount({ items: [item("desk-success"), item("desk-failed", { outcome: "failed" }), item("lab-success", { hostId: "lab" })], agents });
    await setSelect("Agent", archiveAgentKey("lab", "writer"));
    await setSelect("Result", "succeeded");
    await search("lab writer");
    expect(container.querySelectorAll(".archive-row")).toHaveLength(1);
    expect(container.querySelector(".archive-row")?.getAttribute("data-activity-id")).toBe("lab-success");
    await search("no such activity");
    expect(container.querySelectorAll(".archive-row")).toHaveLength(0);
    expect(container.textContent).toContain("No matching activity");
    await act(async () => container.querySelector<HTMLButtonElement>(".archive-empty button")!.click());
    expect(container.querySelectorAll(".archive-row")).toHaveLength(3);
    expect(container.querySelector<HTMLSelectElement>("select[aria-label=Agent]")!.value).toBe("");
    expect(container.querySelector<HTMLInputElement>("input[type=search]")!.value).toBe("");
  });

  it("limits initial rendering, loads the next recent rows and resets expansion on a filter change", async () => {
    const entries = Array.from({ length: ARCHIVE_PAGE_SIZE + 5 }, (_, index) => item(`row-${index}`, { endedAt: Date.now() - index * 1_000 }));
    await mount({ items: entries });
    expect(container.querySelectorAll(".archive-row")).toHaveLength(ARCHIVE_PAGE_SIZE);
    expect(container.querySelector(".archive-paging")?.textContent).toContain(`${ARCHIVE_PAGE_SIZE} of ${entries.length} recent`);
    expect(container.querySelector(".archive-day h2")?.textContent).toContain(`${ARCHIVE_PAGE_SIZE} shown`);
    await act(async () => container.querySelector<HTMLButtonElement>(".archive-load-more")!.click());
    expect(container.querySelectorAll(".archive-row")).toHaveLength(entries.length);
    expect(container.querySelector(".archive-load-more")).toBeNull();
    await setSelect("Result", "succeeded");
    expect(container.querySelectorAll(".archive-row")).toHaveLength(ARCHIVE_PAGE_SIZE);
  });

  it("opens the exact qualified activity identity and supports native button keyboard focus", async () => {
    const id = "lab::task:full-reference-with-::inside";
    await mount({ items: [item(id, { hostId: "lab", agentId: "lab::writer" })], selectedId: id });
    const row = container.querySelector<HTMLButtonElement>(".archive-row")!;
    expect(row.getAttribute("aria-pressed")).toBe("true");
    row.focus();
    expect(document.activeElement).toBe(row);
    await act(async () => row.click());
    expect(select).toHaveBeenCalledExactlyOnceWith(id);
  });

  it("distinguishes repeated machine and Agent labels in choices and record sources", async () => {
    const roster = agents.map((agent) => ({ ...agent, displayName: "Writer" }));
    const status = { host: { id: "hub", label: "Hub", role: "hub" }, hosts: [{ id: "desk", label: "Desktop" }, { id: "lab", label: "Desktop" }] } as CollectorStatus;
    await mount({ items: [item("desk::same"), item("lab::same", { hostId: "lab" })], agents: roster, status });
    const choices = [...container.querySelectorAll("select[aria-label=Agent] option")].map((choice) => choice.textContent);
    expect(choices).toContain("Writer · Desktop · desk");
    expect(choices).toContain("Writer · Desktop · lab");
    expect(container.querySelector('[data-host-id="desk"] .archive-record-host')?.textContent).toBe("Desktop · desk");
    expect(container.querySelector('[data-host-id="lab"] .archive-record-host')?.textContent).toBe("Desktop · lab");
    await setSelect("Agent", archiveAgentKey("lab", "writer"));
    expect(container.querySelectorAll(".archive-row")).toHaveLength(1);
    expect(container.querySelector(".archive-row")?.getAttribute("data-activity-id")).toBe("lab::same");
  });

  it("uses the same disambiguated Agent label in choices and rows, preserving it when filtered", async () => {
    const roster = [
      { ...agents[0]!, id: "desk::writer-a", displayName: "Writer" },
      { ...agents[0]!, id: "desk::writer-b", displayName: "Writer" },
      { ...agents[0]!, id: "desk::reviewer", displayName: "Reviewer" },
    ];
    await mount({ items: [item("a", { agentId: "desk::writer-a" }), item("b", { agentId: "desk::writer-b" }), item("review", { agentId: "desk::reviewer" })], agents: roster });
    const rowLabels = [...container.querySelectorAll(".archive-agent-name")].map((label) => label.textContent);
    expect(rowLabels).toEqual(expect.arrayContaining(["Writer · writer-a", "Writer · writer-b", "Reviewer"]));
    for (const rowLabel of rowLabels) {
      expect([...container.querySelectorAll("select[aria-label=Agent] option")].map((option) => option.textContent)).toContain(rowLabel);
    }
    await setSelect("Agent", archiveAgentKey("desk", "desk::writer-b"));
    expect(container.querySelectorAll(".archive-row")).toHaveLength(1);
    expect(container.querySelector(".archive-agent-name")?.textContent).toBe("Writer · writer-b");
    await act(async () => container.querySelector<HTMLButtonElement>(".archive-row")!.click());
    expect(select).toHaveBeenCalledExactlyOnceWith("b");
  });
});
