import { describe, expect, it } from "vitest";
import { selectUpcomingSchedules } from "./upcoming-schedules.js";

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
          jobId: "due",
          agentId: "main",
          title: "Due now",
          nextRunAt: now - 180_000,
          scheduleKind: "cron",
          timezone: "Asia/Singapore",
        },
        {
          id: "cron:boundary",
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
