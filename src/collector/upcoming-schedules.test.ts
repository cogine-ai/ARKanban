import { describe, expect, it } from "vitest";
import { scheduleAgentIds, selectUpcomingSchedules } from "./upcoming-schedules.js";

describe("upcoming schedule selection", () => {
  it("returns one enabled occurrence inside the due-now and next-hour boundaries", () => {
    const now = 1_000_000_000;
    const result = selectUpcomingSchedules(
      [
        {
          id: "due",
          name: "Due now",
          enabled: true,
          schedule: { kind: "cron", expr: "* * * * *", tz: "Asia/Singapore" },
          state: { nextRunAtMs: now - 180_000 },
        },
        {
          id: "boundary",
          name: "At one hour",
          enabled: true,
          agentId: "pm-awb",
          schedule: { kind: "cron" },
          nextRunAtMs: now + 3_600_000,
        },
        { id: "too-late", name: "Too late", enabled: true, agentId: "pm-awb", nextRunAtMs: now + 3_600_001 },
        { id: "too-old", name: "Too old", enabled: true, agentId: "pm-awb", nextRunAtMs: now - 180_001 },
        { id: "disabled", name: "Disabled", enabled: false, agentId: "pm-awb", nextRunAtMs: now + 1_000 },
        { id: "unknown-time", name: "Unknown", enabled: true, agentId: "pm-awb" },
      ],
      { now, defaultAgentId: "main" },
    );

    expect(result).toEqual({
      items: [
        {
          id: "cron:due",
          hostId: "local",
          jobId: "due",
          agentId: "main",
          title: "Due now",
          nextRunAt: now - 180_000,
          scheduleKind: "cron",
          timezone: "Asia/Singapore",
        },
        {
          id: "cron:boundary",
          hostId: "local",
          jobId: "boundary",
          agentId: "pm-awb",
          title: "At one hour",
          nextRunAt: now + 3_600_000,
          scheduleKind: "cron",
        },
      ],
      omittedAgentCount: 0,
    });
  });

  it("omits only jobs whose agent cannot be resolved and reports partial coverage", () => {
    const now = 2_000_000_000;
    const result = selectUpcomingSchedules(
      [
        { id: "explicit", name: "Explicit agent", enabled: true, agentId: "pm-awb", nextRunAtMs: now + 2_000 },
        { id: "missing", name: "Missing agent", enabled: true, nextRunAtMs: now + 1_000 },
      ],
      { now },
    );

    expect(result).toEqual({
      items: [
        {
          id: "cron:explicit",
          hostId: "local",
          jobId: "explicit",
          agentId: "pm-awb",
          title: "Explicit agent",
          nextRunAt: now + 2_000,
          scheduleKind: "unknown",
        },
      ],
      omittedAgentCount: 1,
    });
  });
});

describe("schedule agent ids", () => {
  const now = 1_000_000_000;

  it("collects owners of enabled jobs regardless of when they next run", () => {
    const ids = scheduleAgentIds([
      { id: "soon", enabled: true, agentId: "scheduler", nextRunAtMs: now + 1_000 },
      { id: "far", enabled: true, agentId: "ops", nextRunAtMs: now + 30 * 24 * 3_600_000 },
      { id: "undated", enabled: true, agentId: "archivist" },
      { id: "repeat", enabled: true, agentId: "scheduler", nextRunAtMs: now + 2_000 },
    ]);

    expect(ids.sort()).toEqual(["archivist", "ops", "scheduler"]);
  });

  it("attributes unowned jobs to the default agent and skips disabled ones", () => {
    const ids = scheduleAgentIds(
      [
        { id: "inherits", enabled: true, nextRunAtMs: now + 1_000 },
        { id: "off", enabled: false, agentId: "retired", nextRunAtMs: now + 1_000 },
      ],
      "main",
    );

    expect(ids).toEqual(["main"]);
  });

  it("yields nothing when a job has no owner and there is no default", () => {
    expect(scheduleAgentIds([{ id: "orphan", enabled: true, nextRunAtMs: now + 1_000 }])).toEqual([]);
  });
});
