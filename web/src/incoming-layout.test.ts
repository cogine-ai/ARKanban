import { describe, expect, it } from "vitest";
import { applyIncomingQuota, sortQueuedActivities } from "./incoming-layout";

describe("incoming cell layout", () => {
  it("keeps queued work ahead of schedules and reserves one slot for overflow", () => {
    expect(applyIncomingQuota(["q1", "q2"], ["s1", "s2", "s3"], 4)).toEqual({
      visibleQueued: ["q1", "q2"],
      visibleSchedules: ["s1"],
      hiddenQueued: [],
      hiddenSchedules: ["s2", "s3"],
    });
  });

  it("reports both hidden queued work and schedules when queued work fills the cell", () => {
    expect(applyIncomingQuota(["q1", "q2", "q3", "q4", "q5"], ["s1", "s2"], 4)).toEqual({
      visibleQueued: ["q1", "q2", "q3"],
      visibleSchedules: [],
      hiddenQueued: ["q4", "q5"],
      hiddenSchedules: ["s1", "s2"],
    });
  });

  it("does not reserve overflow capacity when every incoming card fits", () => {
    expect(applyIncomingQuota(["q1", "q2"], ["s1", "s2"], 4)).toEqual({
      visibleQueued: ["q1", "q2"],
      visibleSchedules: ["s1", "s2"],
      hiddenQueued: [],
      hiddenSchedules: [],
    });
  });

  it("orders queued work by its oldest known queue time", () => {
    const result = sortQueuedActivities([
      { id: "new", createdAt: 3_000, updatedAt: 3_500 },
      { id: "fallback", updatedAt: 1_000 },
      { id: "old", createdAt: 2_000, updatedAt: 4_000 },
    ]);

    expect(result.map((item) => item.id)).toEqual(["fallback", "old", "new"]);
  });
});
