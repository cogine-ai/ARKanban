import { describe, expect, it } from "vitest";
import type { ActivityItem, AgentSummary, CollectorStatus } from "../../../src/contracts";
import {
  ARCHIVE_RESULTS, archiveAgentChoices, archiveAgentKey, archiveAgentName, archiveExactTime, archiveHostLabels,
  archiveRelativeTime, archiveResult, archiveTimestamp, filterArchive, groupArchiveByDay,
} from "./archive-model";

function item(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", kind: "task", origin: "task_ledger", catalog: "terminal_history", agentId: "writer", state: "terminal", outcome: "succeeded", phase: "none", attention: "none", stage: "settled", freshness: "live", title: `Activity ${id}`, endedAt: 50, updatedAt: 100, lastObservedAt: 100, evidence: [], ...patch };
}
function agent(hostId: string, id: string, displayName: string): AgentSummary {
  return { id, hostId, displayName, kind: "agent", origin: "roster", firstObservedAt: 0 };
}
const noFilter = { query: "", outcome: "all" as const, agent: "" };

describe("recent activity history", () => {
  it("includes only terminal rows, orders by an observed end or update, and leaves the input intact", () => {
    const source = [item("older", { endedAt: 10 }), item("active", { state: "active", endedAt: undefined }), item("observed", { endedAt: undefined, updatedAt: 40, lastObservedAt: 6_000 }), item("newer", { endedAt: 60 })];
    expect(filterArchive(source, noFilter).map((entry) => entry.id)).toEqual(["newer", "observed", "older"]);
    expect(source.map((entry) => entry.id)).toEqual(["older", "active", "observed", "newer"]);
  });

  it("keeps unknown, unreported, cancellation, failure and timeout separate from success", () => {
    const entries = ARCHIVE_RESULTS.map((outcome) => item(outcome, { outcome }));
    for (const outcome of ARCHIVE_RESULTS) {
      expect(filterArchive(entries, { ...noFilter, outcome }).map((entry) => entry.outcome)).toEqual([outcome]);
      if (outcome !== "succeeded") expect(archiveResult(outcome).symbol).not.toBe("✓");
    }
    expect(archiveResult("unknown").label).toBe("Unknown");
    expect(archiveResult("none").label).toBe("Unreported");
  });

  it("intersects title/name search, result and a full host/agent identity", () => {
    const agents = [agent("desk", "writer", "Report writer"), agent("lab", "writer", "Report writer")];
    const entries = [item("desk-success"), item("desk-failure", { outcome: "failed" }), item("lab-success", { hostId: "lab" })];
    expect(filterArchive(entries, { query: "  REPORT  ", outcome: "succeeded", agent: archiveAgentKey("desk", "writer") }, agents).map((entry) => entry.id)).toEqual(["desk-success"]);
    expect(filterArchive(entries, { ...noFilter, query: "does not exist" }, agents)).toEqual([]);
  });

  it("resolves names only on the owning host and preserves distinct cross-host choices", () => {
    const agents = [agent("desk", "desk::writer", "Draft writer"), agent("lab", "lab::writer", "Lab writer")];
    const entries = [item("same", { agentId: "desk::writer" }), item("same", { hostId: "lab", agentId: "lab::writer" })];
    expect(archiveAgentName(entries[0]!, agents)).toBe("Draft writer");
    expect(archiveAgentName(item("unknown-host", { hostId: "outside", agentId: "desk::writer" }), agents)).toBe("desk::writer");
    const choices = archiveAgentChoices(entries, agents, new Map([["desk", "Desktop"], ["lab", "Lab machine"]]));
    expect(choices).toHaveLength(2);
    expect(choices.map((choice) => choice.label)).toEqual(["Draft writer · Desktop", "Lab writer · Lab machine"]);
    expect(filterArchive(entries, noFilter)).toHaveLength(2);
  });

  it("disambiguates duplicate display names on one host without replacing their identities", () => {
    const agents = [agent("desk", "writer-a", "Writer"), agent("desk", "writer-b", "Writer")];
    const choices = archiveAgentChoices([item("a", { agentId: "writer-a" }), item("b", { agentId: "writer-b" })], agents);
    expect(choices.map((choice) => choice.label)).toEqual(["Writer · writer-a", "Writer · writer-b"]);
    expect(choices.map((choice) => choice.value)).toEqual([archiveAgentKey("desk", "writer-a"), archiveAgentKey("desk", "writer-b")]);
    expect(choices.map((choice) => choice.agentLabel)).toEqual(["Writer · writer-a", "Writer · writer-b"]);
  });

  it("counts distinct Agent identities per host, not repeated rows or equal names on other hosts", () => {
    const agents = [agent("desk", "desk::writer-a", "Writer"), agent("desk", "desk::writer-b", "Writer"), agent("lab", "lab::writer-a", "Writer")];
    const entries = [item("a", { agentId: "desk::writer-a" }), item("again", { agentId: "desk::writer-a" }), item("b", { agentId: "desk::writer-b" }), item("lab", { hostId: "lab", agentId: "lab::writer-a" })];
    const choices = archiveAgentChoices(entries, agents);
    expect(choices).toHaveLength(3);
    const byAgent = new Map(choices.map((choice) => [choice.value, choice.agentLabel]));
    expect(byAgent.get(archiveAgentKey("desk", "desk::writer-a"))).toBe("Writer · writer-a");
    expect(byAgent.get(archiveAgentKey("desk", "desk::writer-b"))).toBe("Writer · writer-b");
    expect(byAgent.get(archiveAgentKey("lab", "lab::writer-a"))).toBe("Writer");
    expect(archiveAgentChoices(entries.slice(0, 2), agents)[0]!.agentLabel).toBe("Writer");
  });

  it("adds host identity only when configured machine labels are repeated", () => {
    const labels = archiveHostLabels({ host: { id: "hub", label: "Hub", role: "hub" }, hosts: [{ id: "desk", label: "Desktop" }, { id: "lab", label: "Desktop" }] } as CollectorStatus);
    expect(labels.get("hub")).toBe("Hub");
    expect(labels.get("desk")).toBe("Desktop · desk");
    expect(labels.get("lab")).toBe("Desktop · lab");
    const agents = [agent("desk", "writer", "Writer"), agent("lab", "writer", "Writer")];
    const choices = archiveAgentChoices([item("a"), item("b", { hostId: "lab" })], agents, labels);
    expect(choices.map((choice) => choice.label)).toEqual(["Writer · Desktop · desk", "Writer · Desktop · lab"]);
  });

  it("groups by local calendar date across midnight and distinguishes yesterday from a 24-hour window", () => {
    const now = new Date(2026, 9, 11, 0, 5).getTime();
    const today = item("today", { endedAt: new Date(2026, 9, 11, 0, 1).getTime() });
    const yesterday = item("yesterday", { endedAt: new Date(2026, 9, 10, 23, 59).getTime() });
    const older = item("older", { endedAt: new Date(2026, 9, 9, 23, 59).getTime() });
    const groups = groupArchiveByDay([today, yesterday, older], now);
    expect(groups.map((group) => group.key)).toEqual(["2026-10-11", "2026-10-10", "2026-10-09"]);
    expect(groups[0]!.label).toBe("Today");
    expect(groups[1]!.label).toBe("Yesterday");
    expect(groups[2]!.label).toContain("2026");
  });

  it("accepts an end timestamp of zero and gives exact time with seconds and a zone", () => {
    expect(archiveTimestamp(item("epoch", { endedAt: 0, updatedAt: 999 }))).toBe(0);
    expect(archiveTimestamp(item("fallback", { endedAt: undefined, updatedAt: 0 }))).toBe(0);
    expect(archiveRelativeTime(0, 60_000)).toBe("1m ago");
    const exact = archiveExactTime(0);
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(0).find((part) => part.type === "timeZoneName")!.value;
    expect(exact).toContain(zone);
    expect(exact).not.toBe("Not observed");
  });
});
