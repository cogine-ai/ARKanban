import { describe, expect, it } from "vitest";
import { FieldInventory } from "../collector/field-inventory.js";
import { auditToolVerdict, projectAuditPage } from "./audit-projector.js";

const NOW = 1_800_000_000_000;

/** The shape 2026.7.1-2 returns, field for field. */
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "11111111-2222-3333-4444-555555555555",
    sequence: 54,
    sourceSequence: 3,
    occurredAt: NOW - 60_000,
    kind: "tool_action",
    action: "tool.action.finished",
    status: "failed",
    errorCode: "tool_failed",
    actor: { type: "agent", id: "main" },
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:1",
    sessionId: "sess-1",
    runId: "run-9",
    toolCallId: "call-3",
    toolName: "bash",
    redaction: "metadata_only",
    ...overrides,
  };
}

describe("projectAuditPage", () => {
  it("reads every field a real audit record carries", () => {
    const page = projectAuditPage({ events: [event()], nextCursor: "40" }, { observedAt: NOW });

    expect(page.writes).toEqual([
      {
        eventId: "11111111-2222-3333-4444-555555555555",
        sequence: 54,
        sourceSequence: 3,
        occurredAt: NOW - 60_000,
        kind: "tool_action",
        action: "tool.action.finished",
        status: "failed",
        errorCode: "tool_failed",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:1",
        sessionId: "sess-1",
        runId: "run-9",
        toolCallId: "call-3",
        toolName: "bash",
        observedAt: NOW,
      },
    ]);
    expect(page.nextCursor).toBe("40");
    expect(page.newestSequence).toBe(54);
    expect(page.oldestSequence).toBe(54);
  });

  it("reports the sequence range of a page, which is what paging and the watermark use", () => {
    const page = projectAuditPage(
      { events: [event({ eventId: "a", sequence: 54 }), event({ eventId: "b", sequence: 51 })] },
      { observedAt: NOW },
    );

    expect(page.newestSequence).toBe(54);
    expect(page.oldestSequence).toBe(51);
    expect(page.nextCursor).toBeUndefined();
  });

  /**
   * The trail is metadata by contract. A build that shipped anything else here
   * would be offering content through a path with none of the archive's controls.
   */
  it("drops a record that does not carry the metadata-only guarantee", () => {
    const page = projectAuditPage({ events: [event({ redaction: "full" })] }, { observedAt: NOW });

    expect(page.writes).toEqual([]);
    expect(page.dropped).toBe(1);
  });

  it("keeps a record from a build that states no redaction at all", () => {
    const { redaction, ...withoutRedaction } = event();
    expect(redaction).toBe("metadata_only");

    const page = projectAuditPage({ events: [withoutRedaction] }, { observedAt: NOW });

    expect(page.writes).toHaveLength(1);
  });

  it.each([
    ["identity", { eventId: undefined }],
    ["sequence", { sequence: undefined }],
    ["date", { occurredAt: undefined }],
    ["kind", { kind: undefined }],
    ["status", { status: undefined }],
  ])("drops a record with no %s, since that is what makes it storable", (_label, overrides) => {
    const page = projectAuditPage({ events: [event(overrides)] }, { observedAt: NOW });

    expect(page.writes).toEqual([]);
    expect(page.dropped).toBe(1);
  });

  it("keeps a run record, which carries no tool fields", () => {
    const page = projectAuditPage(
      {
        events: [
          {
            eventId: "run-event",
            sequence: 14,
            occurredAt: NOW - 30_000,
            kind: "agent_run",
            action: "agent.run.finished",
            status: "succeeded",
            actor: { type: "agent", id: "main" },
            agentId: "main",
            sessionKey: "agent:main:telegram:direct:1",
            runId: "run-9",
            redaction: "metadata_only",
          },
        ],
      },
      { observedAt: NOW },
    );

    expect(page.writes[0]).toMatchObject({ kind: "agent_run", status: "succeeded" });
    expect(page.writes[0]).not.toHaveProperty("toolName");
    expect(page.writes[0]).not.toHaveProperty("errorCode");
  });

  /**
   * The cursor comes from the Gateway's own last row rather than from what this
   * projector kept, so it still points below the page even when every record on it
   * was dropped. Withholding it would report an unreadable stretch as the end of
   * the trail, and the end of the trail is the one answer that stops the backwards
   * walk permanently.
   */
  it("passes on the cursor from a page that yielded nothing", () => {
    const page = projectAuditPage({ events: [event({ eventId: undefined })], nextCursor: "40" }, { observedAt: NOW });

    expect(page.writes).toEqual([]);
    expect(page.dropped).toBe(1);
    expect(page.nextCursor).toBe("40");
  });

  it("reports no cursor when the Gateway sent none", () => {
    const page = projectAuditPage({ events: [event({})] }, { observedAt: NOW });

    expect(page.nextCursor).toBeUndefined();
  });

  it("bounds a record dated in the future by the moment it was read", () => {
    const page = projectAuditPage({ events: [event({ occurredAt: NOW + 90_000 })] }, { observedAt: NOW });

    expect(page.writes[0]?.occurredAt).toBe(NOW);
  });

  it("records the field coverage of what it read", () => {
    const inventory = new FieldInventory("audit.list");

    projectAuditPage({ events: [event({ surpriseField: 1 })], nextCursor: "40" }, { observedAt: NOW, inventory });

    const report = inventory.report();
    expect(report.consumed).toContain("toolName");
    expect(report.consumed).toContain("redaction");
    expect(report.unknown).toEqual(["surpriseField"]);
    expect(report.missing).toEqual([]);
  });

  it("returns an empty page for a payload with no events array", () => {
    expect(projectAuditPage({}, { observedAt: NOW })).toEqual({ writes: [], dropped: 0 });
  });
});

describe("auditToolVerdict", () => {
  it.each([
    ["succeeded", false],
    ["failed", true],
    ["timed_out", true],
    ["blocked", true],
  ])("reads %s as a settled call", (status, failed) => {
    expect(auditToolVerdict(status, undefined)).toBe(failed);
  });

  /**
   * A start settles nothing, and an operator stopping a tool is not the tool
   * failing — charging either would invent an outcome the Gateway did not state.
   */
  it.each(["started", "cancelled", "unknown", "something_new"])("leaves %s unsettled", (status) => {
    expect(auditToolVerdict(status, undefined)).toBeUndefined();
  });

  it("reads an error code from an unfamiliar status as the failure it is", () => {
    expect(auditToolVerdict("something_new", "tool_failed")).toBe(true);
  });
});
