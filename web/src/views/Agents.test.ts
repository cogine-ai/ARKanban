// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, ActivitySnapshot, AgentActivityRollup, AgentOverview, CollectorStatus } from "../../../src/contracts";
import { navigate } from "../router";
import { AgentsView } from "./Agents";

const state = vi.hoisted(() => ({
  agents: undefined as AgentOverview[] | undefined, error: undefined as string | undefined, reload: vi.fn(),
  snapshot: undefined as ActivitySnapshot | undefined, status: undefined as CollectorStatus | undefined,
  live: { state: "open" },
}));
vi.mock("../state/use-agents", () => ({ useAgents: () => state }));
vi.mock("../state/collector-context", () => ({ useCollector: () => state }));

const emptyRollup: AgentActivityRollup = { completed: 0, succeeded: 0, failed: 0, cancelled: 0, timedOut: 0, blocked: 0, unknown: 0, durationSampleCount: 0 };
function agent(id: string, patch: Partial<AgentOverview> = {}): AgentOverview {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, hasCost: false, sessionCount: 0, unpricedModels: [] };
  return { id, displayName: id === "writer" ? "Writer" : "Operations", hostId: "desk", kind: "unknown", origin: "roster", firstObservedAt: 1, sessionCount: 5, activeSessionCount: 8, archivedSessionCount: 1, activityCount: 9, recent: { "24h": emptyRollup, "7d": { ...emptyRollup, completed: 4 } }, cost: { coverage: "not_observed", source: { "24h": "snapshots", "7d": "snapshots" }, windows: { "24h": totals, "7d": totals } }, ...patch };
}
function activity(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", agentId: "writer", kind: "task", origin: "task_ledger", catalog: "operational", state: "active", outcome: "none", phase: "model", attention: "none", stage: "in_flight", freshness: "live", title: id, createdAt: 1, updatedAt: 10, lastObservedAt: 10, evidence: [], ...patch };
}
function snapshot(items: ActivityItem[] = []): ActivitySnapshot {
  return { items, sync: { state: "live", reasons: [] }, schedule: { state: "live", schedulerEnabled: true, items: [] } } as unknown as ActivitySnapshot;
}
function status(patch: Partial<CollectorStatus> = {}): CollectorStatus {
  return { host: { id: "desk", label: "Desktop", role: "node" }, gateway: { connected: true }, syncState: "live", syncReasons: [], sources: (["tasks", "sessions", "events"] as const).map((source) => ({ source, state: "live" as const })), ...patch } as CollectorStatus;
}

describe("Agents roster", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    state.agents = [agent("writer"), agent("ops")]; state.error = undefined;
    state.snapshot = snapshot([activity("running")]); state.status = status(); state.live.state = "open";
    navigate("/agents", { replace: true });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const mount = async () => { await act(async () => root.render(createElement(AgentsView))); };
  const click = async (selector: string) => { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()); };
  const search = async (value: string) => { await act(async () => { const control = container.querySelector<HTMLInputElement>(".roster-search input")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); }); };

  it("shows real run signals, one comparable window and readable links; details keep missing data unknown", async () => {
    await mount();
    const row = container.querySelector('[data-agent-id="writer"]')!;
    expect(row.querySelector(".roster-signal")?.textContent).toContain("1 running");
    expect(row.textContent).not.toContain("8 running");
    expect(row.querySelector(".roster-details")).toBeNull();
    expect(row.querySelector('[data-window="7d"]')).toBeNull();
    expect(row.querySelector('[data-window="24h"]')?.textContent).not.toContain("0%");
    expect(row.querySelector(".agent-card-open")?.getAttribute("href")).toBe("/agents/writer");
    expect(row.querySelector(".agent-sessions-link")?.getAttribute("href")).toBe("/sessions?agentId=writer");
    await click('[data-agent-id="writer"] .roster-more');
    expect(row.querySelector(".roster-more")?.getAttribute("aria-expanded")).toBe("true");
    expect(row.querySelector('[data-window="7d"]')).not.toBeNull();
    expect(row.querySelector(".roster-details")?.textContent).toContain("Active sessions8");
    expect(row.querySelector(".agent-cost")?.textContent).toContain("Usage not collected yet");
    expect(row.textContent).not.toContain("$0");
    expect(row.textContent).not.toContain("system");
    await click('[data-agent-id="writer"] .roster-more');
    expect(row.querySelector(".roster-details")).toBeNull();
  });

  it("combines true activity filters with name, machine and runtime search and clears empty filters", async () => {
    state.agents = [agent("writer", { model: "Example Large" }), agent("ops", { hostId: "remote" })];
    state.status = status({ host: { id: "hub", label: "Hub", role: "hub" }, hosts: [
      { id: "desk", label: "Desktop", reachable: true, syncState: "live", gatewayConnected: true },
      { id: "remote", label: "Remote", reachable: true, syncState: "live", gatewayConnected: true },
    ] });
    state.snapshot = snapshot([activity("wait", { attention: "waiting" })]);
    await mount();
    await click('[data-filter="attention"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(1);
    await search("example large");
    expect(container.querySelector(".agent-card")?.getAttribute("data-agent-id")).toBe("writer");
    await search("remote");
    expect(container.querySelectorAll(".agent-card")).toHaveLength(0);
    expect(container.textContent).toContain("No matching agents");
    await click(".roster-empty button");
    expect(container.querySelectorAll(".agent-card")).toHaveLength(2);
    expect(container.querySelector<HTMLInputElement>(".roster-search input")!.value).toBe("");
    await click('[data-filter="idle"]');
    expect(container.querySelector(".agent-card")?.getAttribute("data-host-id")).toBe("remote");
  });

  it("keeps unknown snapshots and missing Hub machines out of the Idle filter", async () => {
    state.snapshot = undefined;
    await mount();
    expect(container.querySelectorAll('.roster-signal[data-state="unknown"]')).toHaveLength(2);
    await click('[data-filter="idle"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(0);
    await click('[data-filter="all"]');
    state.snapshot = snapshot();
    state.status = status({ syncState: "reconciling", hosts: [{ id: "desk", label: "Desktop", reachable: false, syncState: "offline", gatewayConnected: false }] });
    await mount();
    expect(container.querySelectorAll('.roster-signal[data-state="unknown"]')).toHaveLength(2);
    expect(container.querySelector(".roster-source-state")?.textContent).toContain("1 collector unavailable");
    await click('[data-filter="idle"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(0);
  });

  it("does not equate unavailable roster with an empty one and retries the request", async () => {
    state.agents = undefined;
    await mount();
    expect(container.textContent).toContain("Loading agents");
    expect(container.textContent).not.toContain("No agents yet");
    expect(container.querySelector(".roster-count")).toBeNull();
    state.error = "Gateway unavailable";
    await mount();
    expect(container.textContent).not.toContain("Loading agents");
    expect(container.textContent).not.toContain("No agents yet");
    await click(".roster-error button");
    expect(state.reload).toHaveBeenCalledTimes(1);
    state.error = undefined; state.agents = [];
    await mount();
    expect(container.textContent).toContain("No agents yet");
    expect(container.querySelector(".roster-empty a")?.getAttribute("href")).toBe("/connections");
  });

  it("retains calendar dates on expanded Gateway-priced usage", async () => {
    const entry = agent("writer");
    entry.cost.coverage = "live"; entry.cost.source["24h"] = "gateway";
    entry.cost.priced = { "24h": { from: "2000-01-02", to: "2000-01-02" } };
    entry.cost.windows["24h"] = { ...entry.cost.windows["24h"], sessionCount: 1, costMicroUsd: 100_000, hasCost: true };
    state.agents = [entry];
    await mount();
    await click(".roster-more");
    const label = container.querySelector('.agent-cost [data-window="24h"] small')!;
    expect(label.textContent).toBe("01-02");
    expect(label.getAttribute("title")).toContain("calendar day");
    expect(container.querySelector(".agent-cost")?.textContent).toContain("$0.10");
  });

  it("uses a real next Cron time without counting the forecast as a running task", async () => {
    state.snapshot = snapshot();
    state.snapshot.schedule.items = [{ id: "job", jobId: "job", agentId: "writer", hostId: "desk", title: "Daily digest", nextRunAt: Date.now() + 7 * 60_000, scheduleKind: "cron" }];
    await mount();
    const row = container.querySelector('[data-agent-id="writer"]')!;
    expect(row.querySelector(".roster-next")?.textContent).toContain("in 7m");
    expect(row.querySelector(".roster-next")?.getAttribute("title")).toContain("Daily digest");
    expect(row.querySelector(".roster-next small")?.textContent).toBe("Next 1h");
    expect(container.querySelector(".roster-columns")?.textContent).toContain("Next 1h");
    expect(row.querySelector(".roster-signal")?.textContent).toContain("Idle");
    state.live.state = "stopped";
    await mount();
    expect(container.querySelector(".roster-source-state")?.textContent).toContain("Updates paused");
  });

  it("shows unknown activity with unavailable sources while keeping independently live Cron and historical results", async () => {
    state.status = status({ syncReasons: ["live_with_unavailable_source"], sources: [
      { source: "tasks", state: "unavailable" }, { source: "sessions", state: "unavailable" }, { source: "events", state: "unavailable" },
    ] });
    state.agents![0]!.recent["24h"] = { ...emptyRollup, completed: 6 };
    state.snapshot!.schedule.items = [{ id: "job", jobId: "job", agentId: "writer", hostId: "desk", title: "Daily digest", nextRunAt: Date.now() + 7 * 60_000, scheduleKind: "cron" }];
    await mount();
    expect(container.querySelectorAll('.roster-signal[data-state="unknown"]')).toHaveLength(2);
    expect(container.querySelector(".roster-source-state")?.textContent).toContain("Snapshot");
    const writer = container.querySelector('[data-agent-id="writer"]')!;
    expect(writer.querySelector(".roster-next")?.textContent).toContain("in 7m");
    expect(writer.querySelector(".roster-next")?.getAttribute("title")).toContain("Next 1h · Daily digest");
    expect(writer.querySelector('[data-window="24h"]')?.textContent).toContain("Done6");
    expect(container.querySelector('[data-agent-id="ops"] .roster-next b')?.textContent).toBe("—");
    await click('[data-filter="running"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(0);
    await click('[data-filter="idle"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(0);
  });

  it("keeps one Hub node's source uncertainty separate from the healthy node and from its real forecast", async () => {
    state.agents = [agent("desk::writer", { displayName: "Writer" }), agent("remote::writer", { displayName: "Writer", hostId: "remote" })];
    state.status = status({ host: { id: "hub", label: "Hub", role: "hub" }, sources: [], syncReasons: ["live_with_unavailable_source"], hosts: [
      { id: "desk", label: "Desktop", reachable: true, syncState: "live", gatewayConnected: true },
      { id: "remote", label: "Remote", reachable: true, syncState: "live", gatewayConnected: true },
    ] });
    state.snapshot = snapshot([activity("earlier-run", { agentId: "desk::writer" })]);
    state.snapshot.sync.reasons = ["desk:live_with_unavailable_source"];
    state.snapshot.schedule.items = [{ id: "desk::job", jobId: "job", agentId: "desk::writer", hostId: "desk", title: "Real Cron forecast", nextRunAt: Date.now() + 7 * 60_000, scheduleKind: "cron" }];
    await mount();
    expect(container.querySelector('[data-host-id="desk"] .roster-signal')?.getAttribute("data-state")).toBe("unknown");
    expect(container.querySelector('[data-host-id="remote"] .roster-signal')?.getAttribute("data-state")).toBe("idle");
    expect(container.querySelector('[data-host-id="desk"] .roster-next')?.textContent).toContain("in 7m");
    await click('[data-filter="idle"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(1);
    expect(container.querySelector(".agent-card")?.getAttribute("data-host-id")).toBe("remote");
  });

  it("withholds old running and planned signals when the Gateway goes offline while retaining the roster and rollups", async () => {
    const writer = agent("writer");
    writer.recent["24h"] = { ...emptyRollup, completed: 6 };
    state.agents = [writer];
    state.snapshot!.schedule.items = [{ id: "job", jobId: "job", agentId: "writer", hostId: "desk", title: "Old forecast", nextRunAt: Date.now() + 10 * 60_000, scheduleKind: "cron" }];
    await mount();
    expect(container.querySelector('.roster-signal[data-state="running"]')).not.toBeNull();
    state.status = status({ syncState: "offline", gateway: { connected: false } as CollectorStatus["gateway"] });
    await mount();
    expect(container.querySelector('.roster-signal[data-state="unknown"]')).not.toBeNull();
    expect(container.querySelector(".roster-next")?.textContent).toContain("Unavailable");
    expect(container.querySelector('[data-window="24h"]')?.textContent).toContain("Done6");
    await click('[data-filter="running"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(0);
    await click('[data-filter="idle"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(0);
  });

  it("does not use aggregate Hub live or schedule coverage for a Gateway-offline owning node", async () => {
    state.status = status({ host: { id: "hub", label: "Hub", role: "hub" }, hosts: [
      { id: "desk", label: "Desktop", reachable: true, syncState: "offline", gatewayConnected: false },
      { id: "remote", label: "Remote", reachable: true, syncState: "live", gatewayConnected: true },
    ] });
    state.snapshot!.schedule.state = "partial";
    await mount();
    expect(container.querySelectorAll('.roster-signal[data-state="unknown"]')).toHaveLength(2);
    expect([...container.querySelectorAll(".roster-next")].every((next) => next.textContent?.includes("Unavailable"))).toBe(true);
    await click('[data-filter="running"]');
    expect(container.querySelectorAll(".agent-card")).toHaveLength(0);
  });

  it("labels missing Hub collectors on both partial and empty successful roster responses", async () => {
    state.status = status({ host: { id: "hub", label: "Hub", role: "hub" }, hosts: [
      { id: "desk", label: "Desktop", reachable: false, syncState: "offline", gatewayConnected: false },
      { id: "remote", label: "Remote", reachable: true, syncState: "live", gatewayConnected: true },
    ] });
    state.agents = [];
    await mount();
    expect(container.querySelector(".roster-source-state")?.textContent).toContain("1 collector unavailable");
    expect(container.querySelector(".roster-source-state")?.getAttribute("href")).toBe("/connections");
    expect(container.textContent).not.toContain("No agents yet");
    expect(container.textContent).toContain("No agents available");
    state.agents = [agent("remote::writer", { hostId: "remote" })];
    await mount();
    expect(container.querySelector(".roster-source-state")?.textContent).toContain("1 collector unavailable");
    expect(container.querySelectorAll(".agent-card")).toHaveLength(1);
    expect(container.querySelector('.roster-signal[data-state="idle"]')).not.toBeNull();
  });
});
