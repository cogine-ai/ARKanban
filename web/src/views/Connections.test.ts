// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectorStatus } from "../../../src/contracts";
import type { TranscriptArchiveStatus } from "../api";
import type { LiveStreamState } from "../state/collector-context";
import { ConnectionsView } from "./Connections";

const controls = vi.hoisted(() => ({ reload: vi.fn(), retryLive: vi.fn(), refresh: vi.fn(), archiveHook: vi.fn() }));
const data = vi.hoisted(() => ({
  archive: undefined as TranscriptArchiveStatus | undefined, archiveError: undefined as string | undefined,
  live: { state: "open", attempts: 0 } as LiveStreamState, error: undefined as string | undefined,
}));
vi.mock("../state/use-transcript-status", () => ({ useTranscriptStatus: () => {
  controls.archiveHook();
  return { status: data.archive, error: data.archiveError, reload: controls.reload };
} }));
vi.mock("../state/collector-context", () => ({ useCollector: () => ({ live: data.live, retryLive: controls.retryLive, refresh: controls.refresh, error: data.error }) }));

function status(role: CollectorStatus["host"]["role"] = "node"): CollectorStatus {
  return {
    apiVersion: 1, process: { version: "0.1.0", startedAt: 0, ready: true }, host: { id: "desk", label: "My desk", role },
    epoch: "epoch", revision: 1, syncState: "live", syncReasons: [],
    gateway: { name: "My OpenClaw", endpoint: "ws://localhost:18789", connected: true, grantedScopes: [] },
    sources: [{ source: "tasks", state: "live", lastEventAt: 0 }, { source: "sessions", state: "unavailable" }, { source: "events", state: "live" }],
  };
}

describe("connection page modes and recovery", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    data.live = { state: "open", attempts: 0 };
    data.error = undefined;
    data.archiveError = undefined;
    data.archive = { enabled: false, messageCount: 8, contentBytes: 8_000, retentionDays: 30, maxBytes: 1_000_000, filePermissionsEnforced: true, sync: null };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const mount = async (record?: CollectorStatus) => { await act(async () => root.render(createElement(ConnectionsView, { status: record }))); };

  it("shows loading without claiming a Gateway is offline or requesting an unknown role's archive", async () => {
    await mount();
    expect(container.textContent).toContain("Loading connections…");
    expect(container.textContent).not.toContain("Offline");
    expect(controls.archiveHook).not.toHaveBeenCalled();
  });
  it("keeps both role on the local collector path and states saved text is retained", async () => {
    await mount(status("both"));
    expect(container.querySelector(".connection-flow")?.getAttribute("aria-label")).toBe("Gateway to Collector to Browser");
    expect(controls.archiveHook).toHaveBeenCalled();
    expect(container.querySelector(".connection-archive-disclosure")?.textContent).toBe("Sync off · saved text kept");
    expect(container.textContent).not.toContain("Healthy");
    expect(container.querySelector(".connection-diagnostics")?.textContent).toContain("ws://localhost:18789");
    expect(container.querySelector<HTMLDetailsElement>(".connection-diagnostics")?.open).toBe(false);
  });
  it("does not fetch a Hub archive or mistake aggregate Gateway data for a local socket", async () => {
    const hub = status("hub");
    hub.gateway.endpoint = "hub://fan-in";
    hub.hosts = [
      { id: "a", label: "First desk", reachable: false, syncState: "live", gatewayConnected: true },
      { id: "b", label: "Second desk", reachable: true, syncState: "offline" },
    ];
    await mount(hub);
    expect(controls.archiveHook).not.toHaveBeenCalled();
    expect(container.querySelector(".connection-archive")).toBeNull();
    expect(container.textContent).toContain("Conversation archives stay on nodes");
    expect(container.textContent).not.toContain("hub://fan-in");
    expect(container.querySelector("[data-host-id=a]")?.textContent).toContain("Node offlineGateway · Not current");
    expect(container.querySelector("[data-host-id=a] .connection-signal[data-tone=good]")).toBeNull();
    expect(container.querySelector("[data-host-id=b]")?.textContent).toContain("Gateway · Unknown");
    expect(container.querySelector("[data-host-id=b]")?.textContent).toContain("Sync · Source offline");
  });
  it("separates a stopped page stream from Gateway connectivity and offers real stream recovery", async () => {
    data.live = { state: "stopped", attempts: 1 };
    await mount(status());
    expect(container.querySelector("[data-step=gateway]")?.textContent).toContain("Connected");
    expect(container.querySelector("[data-step=browser]")?.textContent).toContain("Updates paused");
    expect(container.querySelector(".connection-arrow[data-flowing=true]")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".connection-retry")!.click());
    expect(controls.retryLive).toHaveBeenCalledOnce();
  });
  it("keeps archive errors visible and retries their own status request", async () => {
    data.archive = undefined;
    data.archiveError = "read_failed";
    await mount(status());
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Archive status unavailable");
    expect(container.textContent).not.toContain("Archive off");
    await act(async () => container.querySelector<HTMLButtonElement>(".connection-error button")!.click());
    expect(controls.reload).toHaveBeenCalledOnce();
  });
  it("keeps privacy warnings outside disclosure and never turns text bytes into disk usage", async () => {
    data.archive = { ...data.archive!, enabled: true, filePermissionsEnforced: false, sync: { sessions: 1, inserted: 0, capacity: "full" } };
    await mount(status());
    const warning = container.querySelector(".connection-privacy-warning");
    expect(warning?.textContent).toContain("readable by other users");
    expect(warning?.closest("details")).toBeNull();
    expect(container.textContent).toContain("New messages paused");
    expect(container.querySelector("[role=progressbar]")).toBeNull();
    expect(container.querySelector(".connection-archive-details")?.textContent).toContain("purge-transcripts --yes");
    expect(container.querySelector<HTMLDetailsElement>(".connection-archive-details")?.open).toBe(false);
  });
  it("keeps a failed archive refresh distinguishable from fresh settings", async () => {
    data.archiveError = "read_failed";
    await mount(status());
    expect(container.querySelector(".connection-archive-heading")?.textContent).toContain("Last known");
    expect(container.querySelector(".connection-archive-disclosure")?.textContent).toContain("saved text kept");
    expect(container.querySelector(".connection-error")).not.toBeNull();
  });
});
