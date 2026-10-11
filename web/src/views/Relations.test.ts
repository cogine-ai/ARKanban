// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityDetail, ActivityItem, ActivityRelation, ActivitySnapshot, CollectorStatus } from "../../../src/contracts";
import { RelationsView } from "./Relations";

const api = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock("../api", () => ({ collectorApi: api, isAbortError: (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError" }));

function activity(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", agentId: "writer", kind: "task", origin: "task_ledger", catalog: "operational", state: "active", outcome: "none", phase: "model", attention: "none", stage: "in_flight", freshness: "live", title: `Record ${id}`, updatedAt: 1, lastObservedAt: 1, evidence: [], ...patch };
}
function link(from: string, to: string, type: ActivityRelation["type"] = "run_correlation"): ActivityRelation {
  return { from, to, type, certainty: type === "parent_task" ? "exact" : "correlation_only", label: type === "parent_task" ? "parent task" : "shared run reference" };
}
function snapshot(items: ActivityItem[], relations: ActivityRelation[]): ActivitySnapshot {
  return { apiVersion: 1, epoch: "test", revision: 1, generatedAt: 1, sync: { state: "live", reasons: [] }, summary: { incoming: 0, inFlight: items.length, waiting: 0, settled: 0, unresolved: 0 }, lanes: [], items, relations, schedule: { revision: 1, windowMinutes: 60, dueGraceMinutes: 3, state: "live", schedulerEnabled: true, items: [] } };
}

describe("relation object navigation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let clipboardDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    api.detail.mockResolvedValue({ identity: { runRef: "actual-run-reference" } });
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    vi.unstubAllGlobals();
  });
  async function mount(data: ActivitySnapshot, patch: { selectedId?: string; paused?: boolean; status?: CollectorStatus } = {}) {
    const onSelect = vi.fn();
    await act(async () => root.render(createElement(RelationsView, { snapshot: data, onSelect, ...patch })));
    return onSelect;
  }
  async function openIdentity() {
    const details = container.querySelector<HTMLDetailsElement>(".relations-identities")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    return details;
  }

  it("selects Task and Attempt separately inside a common run, with no directional arrow", async () => {
    const select = await mount(snapshot([activity("task"), activity("attempt", { kind: "attempt" })], [link("task", "attempt")]), { selectedId: "task" });
    expect(container.querySelectorAll("[data-relation-group=run_correlation]")).toHaveLength(1);
    expect(container.querySelectorAll(".relations-node")).toHaveLength(2);
    expect(container.querySelector("[data-activity-id=task]")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).not.toContain("→");
    await act(async () => container.querySelector<HTMLButtonElement>("[data-activity-id=task]")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("[data-activity-id=attempt]")!.click());
    expect(select.mock.calls.map((call) => call[0])).toEqual(["task", "attempt"]);
    expect(api.detail).not.toHaveBeenCalled();
  });

  it("changes modes using arrow keys and puts explicit parents before nested children", async () => {
    await mount(snapshot(["a", "b", "c"].map((id) => activity(id)), [link("a", "b", "parent_task"), link("b", "c", "parent_task"), link("a", "c")]));
    const shared = container.querySelector<HTMLButtonElement>("[role=tab][aria-selected=true]")!;
    await act(async () => shared.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(container.querySelector("[role=tab][aria-selected=true]")?.textContent).toContain("Parent tasks");
    expect(document.activeElement).toBe(container.querySelector("[role=tab][aria-selected=true]"));
    expect([...container.querySelectorAll<HTMLElement>(".relations-tree-row")].map((row) => row.dataset.depth)).toEqual(["0", "1", "2"]);
    expect(container.querySelector(".relations-observed-count")?.textContent).toBe("1 group ·2 links");
  });

  it("reads the actual run reference only when Identity opens, then cancels on collapse", async () => {
    let resolveDetail!: (detail: Partial<ActivityDetail>) => void;
    api.detail.mockImplementation(() => new Promise((resolve) => { resolveDetail = resolve; }));
    await mount(snapshot([activity("task"), activity("attempt", { kind: "attempt" })], [link("task", "attempt")]));
    expect(container.querySelector(".relations-identity-list")).toBeNull();
    expect(api.detail).not.toHaveBeenCalled();
    const details = await openIdentity();
    expect(api.detail).toHaveBeenCalledOnce();
    const signal = api.detail.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => { details.open = false; details.dispatchEvent(new Event("toggle")); });
    expect(signal.aborted).toBe(true);
    await act(async () => resolveDetail({ identity: { runRef: "late-reference" } }));
    expect(container.textContent).not.toContain("late-reference");
    expect(container.querySelector(".relations-identity-list")).toBeNull();
  });

  it("copies full raw IDs and handles missing clipboard capability without throwing", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await mount(snapshot([activity("desk::task"), activity("desk::attempt", { kind: "attempt" })], [link("desk::task", "desk::attempt")]));
    await openIdentity();
    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='Copy Task ID']")!.click());
    expect(writeText).toHaveBeenCalledWith("desk::task");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='Copy Attempt ID']")!.click());
    expect(container.textContent).toContain("Copy unavailable");
  });

  it("shows incomplete edges without allowing missing records to open a guessed detail", async () => {
    const select = await mount(snapshot([activity("known")], [link("known", "outside")]));
    expect(container.querySelector(".relations-unresolved")?.textContent).toContain("Missing record");
    const missing = container.querySelector<HTMLButtonElement>("[data-activity-id=outside]")!;
    expect(missing.disabled).toBe(true);
    await act(async () => missing.click());
    expect(select).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>("[data-activity-id=known]")!.click());
    expect(select).toHaveBeenCalledWith("known");
  });

  it("does not show cached active objects as currently running when updates are paused", async () => {
    await mount(snapshot([activity("task"), activity("attempt", { kind: "attempt" })], [link("task", "attempt")]), { paused: true });
    expect(container.querySelectorAll(".relations-state-running")).toHaveLength(0);
    expect(container.querySelectorAll("[aria-label='Last observed']")).toHaveLength(2);
  });

  it("uses each host's coverage when only one source in a Hub is offline", async () => {
    const data = snapshot([activity("a::task", { hostId: "a" }), activity("a::attempt", { hostId: "a", kind: "attempt" }), activity("b::task", { hostId: "b" }), activity("b::attempt", { hostId: "b", kind: "attempt" })], [link("a::task", "a::attempt"), link("b::task", "b::attempt")]);
    data.sync.state = "reconciling";
    const status: CollectorStatus = { apiVersion: 1, epoch: "hub", revision: 1, process: { version: "test", ready: true, startedAt: 1 }, host: { id: "hub", label: "Hub", role: "hub" }, syncState: "reconciling", syncReasons: [], gateway: { name: "Hub", endpoint: "hub://fan-in", connected: true, grantedScopes: [] }, sources: [], hosts: [{ id: "a", label: "A", reachable: true, syncState: "live", gatewayConnected: true }, { id: "b", label: "B", reachable: true, syncState: "offline", gatewayConnected: false }] };
    await mount(data, { status });
    expect(container.querySelectorAll(".relations-state-running")).toHaveLength(2);
    expect(container.querySelectorAll("[aria-label='Last observed']")).toHaveLength(2);
  });

  it("bounds 600 parent objects to eight visible rows and expands the real preorder", async () => {
    const items = Array.from({ length: 600 }, (_, index) => activity(String(index).padStart(3, "0")));
    const data = snapshot(items, items.slice(1).map((item, index) => link(items[index]!.id, item.id, "parent_task")));
    await mount(data, { selectedId: "599" });
    await act(async () => container.querySelectorAll<HTMLButtonElement>("[role=tab]")[0]!.click());
    expect(container.querySelectorAll(".relations-tree-row")).toHaveLength(8);
    await act(async () => container.querySelector<HTMLButtonElement>(".relations-parent-group .relations-expand")!.click());
    expect(container.querySelectorAll(".relations-tree-row")).toHaveLength(24);
    expect(container.querySelector(".relations-tree-row:last-child")?.getAttribute("data-depth")).toBe("23");
  });

  it("pages complete relation groups with independent links and group counts", async () => {
    const items = Array.from({ length: 20 }, (_, index) => [activity(`task-${index}`), activity(`attempt-${index}`, { kind: "attempt" })]).flat();
    const links = Array.from({ length: 20 }, (_, index) => link(`task-${index}`, `attempt-${index}`));
    await mount(snapshot(items, links));
    expect(container.querySelectorAll(".relations-group")).toHaveLength(8);
    expect(container.querySelector(".relations-observed-count")?.textContent).toBe("20 groups ·20 links");
    const firstIds = [...container.querySelectorAll<HTMLElement>(".relations-node")].map((node) => node.dataset.activityId);
    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='Next relation groups page']")!.click());
    expect(container.querySelectorAll(".relations-group")).toHaveLength(8);
    expect([...container.querySelectorAll<HTMLElement>(".relations-node")].every((node) => !firstIds.includes(node.dataset.activityId))).toBe(true);
  });
});
