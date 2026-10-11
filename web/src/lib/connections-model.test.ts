import { describe, expect, it } from "vitest";
import type { HostCoverage } from "../../../src/contracts";
import type { TranscriptArchiveStatus } from "../api";
import {
  archiveDisclosure, archiveSignal, browserSignal, gatewaySignal, hostGatewaySignal,
  latestSourceObservation, sourceSignal,
} from "./connections-model";

const archive = (overrides: Partial<TranscriptArchiveStatus> = {}): TranscriptArchiveStatus => ({
  enabled: true, messageCount: 0, contentBytes: 0, retentionDays: 30, maxBytes: 1_024,
  filePermissionsEnforced: true, sync: null, ...overrides,
});
const host = (overrides: Partial<HostCoverage> = {}): HostCoverage => ({
  id: "node", label: "Desk", reachable: true, syncState: "live", ...overrides,
});

describe("connection observations", () => {
  it("keeps missing Gateway observations distinct from a failed connection", () => {
    expect(gatewaySignal()).toEqual({ label: "Unknown", tone: "quiet" });
    expect(gatewaySignal(false)).toEqual({ label: "Offline", tone: "bad" });
    expect(hostGatewaySignal(host())).toEqual({ label: "Unknown", tone: "quiet" });
  });
  it("does not render an unreachable host's last-known Gateway as healthy", () => {
    expect(hostGatewaySignal(host({ reachable: false, gatewayConnected: true }))).toEqual({ label: "Not current", tone: "quiet" });
    expect(hostGatewaySignal(host({ reachable: true, gatewayConnected: false }))).toEqual({ label: "Offline", tone: "bad" });
  });
  it("keeps unavailable source coverage distinct from an error", () => {
    expect(sourceSignal({ source: "tasks", state: "unavailable" })).toEqual({ label: "Unavailable", tone: "quiet" });
    expect(sourceSignal({ source: "tasks", state: "error" })).toEqual({ label: "Error", tone: "bad" });
    expect(sourceSignal()).toEqual({ label: "Not reported", tone: "quiet" });
  });
  it("uses the latest of event and snapshot timestamps including epoch zero", () => {
    expect(latestSourceObservation({ source: "tasks", state: "live", lastSnapshotAt: 0 })).toBe(0);
    expect(latestSourceObservation({ source: "events", state: "live", lastSnapshotAt: 12, lastEventAt: 30 })).toBe(30);
    expect(latestSourceObservation({ source: "sessions", state: "connecting" })).toBeUndefined();
  });
  it("keeps page stream loss independent from an observed connected Gateway", () => {
    expect(browserSignal({ state: "stopped", attempts: 1 }).label).toBe("Updates paused");
    expect(gatewaySignal(true).label).toBe("Connected");
  });
});

describe("local archive disclosure", () => {
  it("keeps retained text explicit after sync is disabled", () => {
    expect(archiveDisclosure(archive({ enabled: false, messageCount: 8 }))).toBe("Sync off · saved text kept");
    expect(archiveDisclosure(archive({ enabled: false }))).toBe("Archive off");
    expect(archiveDisclosure(archive())).toBe("Full text · saved locally");
  });
  it("does not claim a successful sync before any round ran", () => {
    expect(archiveSignal(archive())).toEqual({ label: "Not run yet", tone: "quiet" });
  });
  it("separates paused backfill from halted new messages and source errors", () => {
    expect(archiveSignal(archive({ sync: { sessions: 2, inserted: 1, capacity: "paused" } })).label).toBe("Backfill paused");
    expect(archiveSignal(archive({ sync: { sessions: 2, inserted: 1, capacity: "full" } })).label).toBe("New messages paused");
    expect(archiveSignal(archive({ sync: { sessions: 0, inserted: 0, capacity: "ok", errorCode: "database_busy" } })).label).toBe("Last sync failed");
  });
});
