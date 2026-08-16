import { describe, expect, it } from "vitest";
import {
  ABANDON_AFTER_MS,
  SIGNAL_ALGORITHM_VERSION,
  computeSessionSignals,
  gradeForScore,
  isToolFailure,
  tallyToolEvents,
  type SignalEvidence,
  type ToolEventEvidence,
} from "./session-signals.js";

const NOW = 1_700_000_000_000;

function evidence(overrides: Partial<SignalEvidence> = {}): SignalEvidence {
  return {
    sessionKey: "builder:main",
    lastActivityAt: NOW - 60_000,
    hasActiveRun: false,
    activities: [],
    toolEvents: [],
    ...overrides,
  };
}

function terminal(outcome: SignalEvidence["activities"][number]["outcome"], attention: SignalEvidence["activities"][number]["attention"] = "none") {
  return { state: "terminal" as const, outcome, attention, endedAt: NOW - 30_000, updatedAt: NOW - 30_000 };
}

function tool(status: string, toolName = "exec", offset = 0): ToolEventEvidence {
  return { toolName, status, kind: `session.tool:tool:${status}`, occurredAt: NOW - 100_000 + offset };
}

describe("tool failure detection", () => {
  it("reads failure from either the status or the event kind", () => {
    expect(isToolFailure({ status: "error", occurredAt: NOW })).toBe(true);
    expect(isToolFailure({ kind: "session.tool:tool:failed", occurredAt: NOW })).toBe(true);
    expect(isToolFailure({ status: "end", occurredAt: NOW })).toBe(false);
  });

  it("does not read an unfinished call as either outcome", () => {
    const tally = tallyToolEvents([tool("start"), tool("start", "read", 1)]);

    expect(tally).toMatchObject({ settled: 0, failures: 0, retries: 0, consecutiveFailureMax: 0 });
  });
});

describe("tool tally", () => {
  it("counts a failure streak, not just the total", () => {
    const tally = tallyToolEvents([
      tool("error", "exec", 0),
      tool("error", "exec", 1),
      tool("end", "read", 2),
      tool("error", "web_search", 3),
    ]);

    expect(tally.failures).toBe(3);
    expect(tally.consecutiveFailureMax).toBe(2);
  });

  it("charges a retry when the same tool runs again after failing", () => {
    const tally = tallyToolEvents([tool("error", "exec", 0), tool("error", "exec", 1)]);

    expect(tally.retries).toBe(1);
  });

  it("charges a retry when a failing tool later succeeds", () => {
    const tally = tallyToolEvents([tool("error", "exec", 0), tool("end", "exec", 1)]);

    expect(tally.retries).toBe(1);
    expect(tally.failures).toBe(1);
  });

  it("does not charge retries for a session that merely used many tools", () => {
    const tally = tallyToolEvents([tool("end", "read", 0), tool("end", "exec", 1), tool("end", "edit", 2)]);

    expect(tally).toMatchObject({ retries: 0, failures: 0, settled: 3 });
  });

  it("keeps an anonymous failure out of the retry count but inside the failure count", () => {
    const tally = tallyToolEvents([
      { status: "error", occurredAt: NOW },
      { status: "error", occurredAt: NOW + 1 },
    ]);

    expect(tally).toMatchObject({ failures: 2, retries: 0, consecutiveFailureMax: 2 });
  });
});

describe("grade buckets", () => {
  it("maps scores to the documented thresholds", () => {
    expect(gradeForScore(100)).toBe("A");
    expect(gradeForScore(90)).toBe("A");
    expect(gradeForScore(89)).toBe("B");
    expect(gradeForScore(60)).toBe("C");
    expect(gradeForScore(40)).toBe("D");
    expect(gradeForScore(39)).toBe("F");
    expect(gradeForScore(0)).toBe("F");
  });
});

describe("session scoring", () => {
  it("gives a clean completed session an A with the algorithm version attached", () => {
    const signals = computeSessionSignals(
      evidence({ activities: [terminal("succeeded")], toolEvents: [tool("end")] }),
      NOW,
    );

    expect(signals).toMatchObject({
      grade: "A",
      score: 100,
      outcome: "completed",
      confidence: "high",
      algorithmVersion: SIGNAL_ALGORITHM_VERSION,
      penalties: [],
    });
  });

  it("refuses to read a terminal activity with no classified outcome as success", () => {
    const signals = computeSessionSignals(
      evidence({
        activities: [{ state: "terminal", outcome: "unknown", attention: "none", endedAt: NOW - 1_000, updatedAt: NOW - 1_000 }],
      }),
      NOW,
    );

    expect(signals).toMatchObject({ grade: "unscored", outcome: "unknown", confidence: "low" });
    expect(signals).not.toHaveProperty("score");
  });

  it("still grades an unclassified ending once tool calls settled to judge it on", () => {
    const signals = computeSessionSignals(
      evidence({
        activities: [{ state: "terminal", outcome: "unknown", attention: "none", endedAt: NOW - 1_000, updatedAt: NOW - 1_000 }],
        toolEvents: [tool("end", "read", 0), tool("error", "exec", 1)],
      }),
      NOW,
    );

    expect(signals).toMatchObject({ grade: "A", score: 94, outcome: "unknown", confidence: "medium" });
  });

  it("refuses to score a session with no terminal activity and no settled tool call", () => {
    const signals = computeSessionSignals(evidence({ hasActiveRun: true, toolEvents: [tool("start")] }), NOW);

    expect(signals.grade).toBe("unscored");
    expect(signals).not.toHaveProperty("score");
    expect(signals.outcome).toBe("unknown");
    expect(signals.confidence).toBe("low");
  });

  it("names an abandoned outcome at low confidence but still withholds the grade", () => {
    const signals = computeSessionSignals(
      evidence({ lastActivityAt: NOW - ABANDON_AFTER_MS - 1 }),
      NOW,
    );

    expect(signals).toMatchObject({ grade: "unscored", outcome: "abandoned", confidence: "low" });
  });

  it("scores an abandoned session once a tool call settled to back it up", () => {
    const signals = computeSessionSignals(
      evidence({ lastActivityAt: NOW - ABANDON_AFTER_MS - 1, toolEvents: [tool("end")] }),
      NOW,
    );

    expect(signals).toMatchObject({ grade: "B", score: 75, outcome: "abandoned", confidence: "medium" });
    expect(signals.penalties).toEqual([{ code: "abandoned", points: 25 }]);
  });

  it("does not call a recently quiet session abandoned", () => {
    const signals = computeSessionSignals(
      evidence({ lastActivityAt: NOW - 60_000, toolEvents: [tool("end")] }),
      NOW,
    );

    expect(signals.outcome).toBe("unknown");
    expect(signals.penalties).toEqual([]);
  });

  it("lets a terminal failure dominate the score", () => {
    const signals = computeSessionSignals(
      evidence({ activities: [terminal("failed", "error")], toolEvents: [tool("error")] }),
      NOW,
    );

    expect(signals.outcome).toBe("errored");
    expect(signals.grade).toBe("F");
    expect(signals.score).toBe(100 - 45 - 10 - 6);
    expect(signals.penalties.map((penalty) => penalty.code)).toEqual([
      "errored_outcome",
      "attention_error",
      "tool_failure",
    ]);
  });

  it("separates a timeout from a plain failure", () => {
    const timedOut = computeSessionSignals(evidence({ activities: [terminal("timed_out")], toolEvents: [tool("end")] }), NOW);
    const failed = computeSessionSignals(evidence({ activities: [terminal("failed")], toolEvents: [tool("end")] }), NOW);

    expect(timedOut.penalties).toEqual([{ code: "timed_out", points: 35 }]);
    expect(failed.penalties).toEqual([{ code: "errored_outcome", points: 45 }]);
    expect(timedOut.outcome).toBe("errored");
  });

  it("classifies a cancelled session as abandoned rather than errored", () => {
    const signals = computeSessionSignals(evidence({ activities: [terminal("cancelled")], toolEvents: [tool("end")] }), NOW);

    expect(signals).toMatchObject({ outcome: "abandoned", grade: "B", score: 85 });
  });

  it("takes the verdict from the last terminal activity, not the first", () => {
    const signals = computeSessionSignals(
      evidence({
        activities: [
          { state: "terminal", outcome: "failed", attention: "none", endedAt: NOW - 90_000, updatedAt: NOW - 90_000 },
          { state: "terminal", outcome: "succeeded", attention: "none", endedAt: NOW - 10_000, updatedAt: NOW - 10_000 },
        ],
        toolEvents: [tool("end")],
      }),
      NOW,
    );

    expect(signals.outcome).toBe("completed");
    expect(signals.penalties).toEqual([]);
  });

  it("does not let a newer unclassified ending bury the verdict the Gateway gave", () => {
    // A snapshot closing a leftover attempt writes `unknown` and is newer than
    // the run that actually failed. Reading the newest row outright would grade
    // this session as if nothing had gone wrong.
    const signals = computeSessionSignals(
      evidence({
        activities: [
          { state: "terminal", outcome: "failed", attention: "error", endedAt: NOW - 90_000, updatedAt: NOW - 90_000 },
          { state: "terminal", outcome: "unknown", attention: "none", endedAt: NOW - 5_000, updatedAt: NOW - 5_000 },
        ],
        toolEvents: [tool("end")],
      }),
      NOW,
    );

    expect(signals.outcome).toBe("errored");
    expect(signals.grade).toBe("D");
    expect(signals.confidence).toBe("high");
  });

  it("ignores still-running activities when picking the verdict", () => {
    const signals = computeSessionSignals(
      evidence({
        activities: [
          { state: "terminal", outcome: "succeeded", attention: "none", endedAt: NOW - 90_000, updatedAt: NOW - 90_000 },
          { state: "active", outcome: "none", attention: "none", updatedAt: NOW },
        ],
        toolEvents: [tool("end")],
      }),
      NOW,
    );

    expect(signals.outcome).toBe("completed");
  });

  it("caps each penalty so one pathological session cannot run the score off the scale", () => {
    const many = Array.from({ length: 20 }, (_, index) => tool("error", "exec", index));
    const signals = computeSessionSignals(evidence({ activities: [terminal("succeeded")], toolEvents: many }), NOW);

    expect(signals.toolFailures).toBe(20);
    // Uncapped this would be 20 × 6 + 19 × 12 + 19 × 8; the caps hold it at 78.
    expect(signals.score).toBe(100 - 30 - 24 - 24);
    expect(signals.grade).toBe("F");
  });

  it("never reports a negative score", () => {
    const many = Array.from({ length: 40 }, (_, index) => tool("error", `tool-${index % 3}`, index));
    const signals = computeSessionSignals(
      evidence({ activities: [terminal("failed", "error")], toolEvents: many }),
      NOW,
    );

    expect(signals.score).toBe(0);
    expect(signals.grade).toBe("F");
  });

  it("reports medium confidence when only one kind of evidence exists", () => {
    const activityOnly = computeSessionSignals(evidence({ activities: [terminal("succeeded")] }), NOW);
    const toolsOnly = computeSessionSignals(evidence({ toolEvents: [tool("end")] }), NOW);

    expect(activityOnly.confidence).toBe("medium");
    expect(toolsOnly.confidence).toBe("medium");
  });
});
