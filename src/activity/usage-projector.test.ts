import { describe, expect, it } from "vitest";
import { FieldInventory } from "../collector/field-inventory.js";
import { projectCostReport, projectUsagePage, projectUsageRow, toMicroUsd } from "./usage-projector.js";

const OBSERVED_AT = 1_800_000_000_000;

describe("projectUsageRow", () => {
  it("reads the documented field names", () => {
    const row = projectUsageRow(
      {
        sessionKey: "agent:builder:1",
        inputTokens: 1_200,
        outputTokens: 300,
        cacheReadTokens: 40,
        cacheWriteTokens: 12,
        peakContextTokens: 18_000,
        costMicroUsd: 4_500,
        models: ["sonnet"],
      },
      { observedAt: OBSERVED_AT },
    );
    expect(row).toEqual({
      sessionKey: "agent:builder:1",
      observedAt: OBSERVED_AT,
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 40,
      cacheWriteTokens: 12,
      peakContextTokens: 18_000,
      costMicroUsd: 4_500,
      hasCost: true,
      models: ["sonnet"],
      unpricedModels: [],
    });
  });

  /**
   * The store keeps the newest reading per session, so a reading dated in the
   * future is never superseded: without this bound one skewed value froze a
   * session's tokens and cost at that figure permanently.
   */
  it("bounds a reading dated ahead of the moment it was read", () => {
    const skewed = projectUsageRow(
      { sessionKey: "s", inputTokens: 5, outputTokens: 5, observedAt: OBSERVED_AT + 86_400_000 },
      { observedAt: OBSERVED_AT },
    );
    expect(skewed?.observedAt).toBe(OBSERVED_AT);

    // Seconds read as milliseconds is a wrong unit, not a date in 1970.
    const seconds = projectUsageRow(
      { sessionKey: "s", inputTokens: 5, outputTokens: 5, observedAt: Math.floor(OBSERVED_AT / 1000) },
      { observedAt: OBSERVED_AT },
    );
    expect(seconds?.observedAt).toBe(OBSERVED_AT);
  });

  /**
   * The row shape `sessions.usage` actually returns: the figures are nested in a
   * `usage` object, cost is dollars under `totalCost`, models arrive as
   * `{ provider, model }` pairs, and the unpriced signal is a count.
   */
  it("reads the nested shape the Gateway actually sends", () => {
    const row = projectUsageRow(
      {
        key: "agent:builder:1",
        sessionId: "generation-7",
        agentId: "builder",
        updatedAt: OBSERVED_AT - 5_000,
        usage: {
          input: 1_200,
          output: 300,
          cacheRead: 40,
          cacheWrite: 12,
          totalTokens: 1_552,
          totalCost: 0.0045,
          missingCostEntries: 0,
          modelUsage: [{ provider: "anthropic", model: "sonnet" }],
        },
      },
      { observedAt: OBSERVED_AT },
    );

    // Filed under the session key, not the transcript generation id.
    expect(row?.sessionKey).toBe("agent:builder:1");
    expect(row).toMatchObject({
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 40,
      cacheWriteTokens: 12,
      costMicroUsd: 4_500,
      hasCost: true,
      models: ["sonnet"],
    });
    // No peak-context figure exists, so none may be reported.
    expect(row?.peakContextTokens).toBeUndefined();
  });

  it("treats an unpriced entry count as proof the cost is only a floor", () => {
    const row = projectUsageRow(
      { key: "agent:builder:1", usage: { input: 10, output: 2, totalCost: 0.5, missingCostEntries: 3 } },
      { observedAt: OBSERVED_AT },
    );

    expect(row?.costMicroUsd).toBe(500_000);
    expect(row?.hasCost).toBe(false);
  });

  it("accepts the snake_case aliases a different Gateway build might use", () => {
    const row = projectUsageRow(
      { session: "agent:builder:1", prompt_tokens: 10, completion_tokens: 5, cache_creation_input_tokens: 2 },
      { observedAt: OBSERVED_AT },
    );
    expect(row).toMatchObject({ sessionKey: "agent:builder:1", inputTokens: 10, outputTokens: 5, cacheWriteTokens: 2 });
  });

  it("converts dollars to integer micro-USD exactly once", () => {
    const row = projectUsageRow(
      { sessionKey: "s", inputTokens: 1, outputTokens: 1, costUsd: 0.0123455 },
      { observedAt: OBSERVED_AT },
    );
    expect(row?.costMicroUsd).toBe(12_346);
    expect(toMicroUsd(1.5)).toBe(1_500_000);
  });

  it("marks a total as unpriced when any model had no price", () => {
    const row = projectUsageRow(
      { sessionKey: "s", inputTokens: 10, outputTokens: 1, costUsd: 0.5, models: ["a", "b"], unpricedModels: ["b"] },
      { observedAt: OBSERVED_AT },
    );
    expect(row).toMatchObject({ hasCost: false, costMicroUsd: 500_000, unpricedModels: ["b"] });
  });

  it("separates a missing price from a measured zero", () => {
    const free = projectUsageRow({ sessionKey: "s", inputTokens: 1, outputTokens: 1, costUsd: 0 }, { observedAt: OBSERVED_AT });
    const unknown = projectUsageRow({ sessionKey: "s", inputTokens: 1, outputTokens: 1 }, { observedAt: OBSERVED_AT });
    expect(free).toMatchObject({ hasCost: true, costMicroUsd: 0 });
    expect(unknown?.hasCost).toBe(false);
    expect(unknown).not.toHaveProperty("costMicroUsd");
  });

  it("drops a row with no recognisable token counts rather than storing zeros", () => {
    expect(projectUsageRow({ sessionKey: "s", cost: 1 }, { observedAt: OBSERVED_AT })).toBeUndefined();
  });

  /**
   * The reply every session produced on the calibration machine: the counts are
   * all present, all zero, and `cacheStatus` reported `fresh`, for sessions that
   * had run for minutes. Stored, it would have asserted the session was free and
   * `hasCost` would have called that assertion complete.
   */
  it("drops an all-zero reading instead of asserting the session was free", () => {
    const row = projectUsageRow(
      {
        key: "agent:builder:1",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, missingCostEntries: 0 },
      },
      { observedAt: OBSERVED_AT },
    );
    expect(row).toBeUndefined();
  });

  it("keeps a genuinely free reading that counted tokens", () => {
    const row = projectUsageRow(
      { key: "s", usage: { input: 10, output: 2, totalCost: 0, missingCostEntries: 0 } },
      { observedAt: OBSERVED_AT },
    );
    expect(row).toMatchObject({ costMicroUsd: 0, hasCost: true });
  });

  it("falls back to the requested session when the reply omits the key", () => {
    const row = projectUsageRow({ inputTokens: 4, outputTokens: 1 }, { observedAt: OBSERVED_AT, sessionKey: "asked" });
    expect(row?.sessionKey).toBe("asked");
  });

  it("ignores a negative token count instead of subtracting from the total", () => {
    const row = projectUsageRow(
      { sessionKey: "s", inputTokens: 10, outputTokens: 1, cacheReadTokens: -5 },
      { observedAt: OBSERVED_AT },
    );
    expect(row?.cacheReadTokens).toBe(0);
  });
});

describe("projectUsagePage", () => {
  it("reads a list reply", () => {
    const page = projectUsagePage(
      { sessions: [{ sessionKey: "a", inputTokens: 1, outputTokens: 1 }, { sessionKey: "b", inputTokens: 2, outputTokens: 1 }] },
      { observedAt: OBSERVED_AT },
    );
    expect(page.writes.map((write) => write.sessionKey)).toEqual(["a", "b"]);
  });

  it("keeps session identity when usage is keyed by session instead of listed", () => {
    const page = projectUsagePage(
      { sessions: { "agent:x:1": { inputTokens: 3, outputTokens: 1 } } },
      { observedAt: OBSERVED_AT },
    );
    expect(page.writes[0]).toMatchObject({ sessionKey: "agent:x:1", inputTokens: 3 });
  });

  it("prefers per-session rows over a rolled-up total in the same reply", () => {
    const page = projectUsagePage(
      { inputTokens: 999, outputTokens: 999, sessions: [{ sessionKey: "a", inputTokens: 1, outputTokens: 1 }] },
      { observedAt: OBSERVED_AT },
    );
    expect(page.writes).toHaveLength(1);
    expect(page.writes[0]).toMatchObject({ sessionKey: "a", inputTokens: 1 });
  });

  it("reads a single-session reply", () => {
    const page = projectUsagePage({ inputTokens: 7, outputTokens: 2 }, { observedAt: OBSERVED_AT, sessionKey: "solo" });
    expect(page.writes).toHaveLength(1);
    expect(page.writes[0]?.sessionKey).toBe("solo");
  });

  it("reports unknown fields so a real Gateway's shape can be diffed", () => {
    const inventory = new FieldInventory("sessions.usage");
    projectUsagePage(
      { sessions: [{ sessionKey: "a", inputTokens: 1, outputTokens: 1, reasoningTokens: 42 }] },
      { observedAt: OBSERVED_AT, inventory },
    );
    const report = inventory.report();
    expect(report.unknown).toContain("reasoningTokens");
    expect(report.consumed).toContain("inputTokens");
  });
});

describe("projectCostReport", () => {
  /**
   * The shape 2026.7.1-2 returns: the split is under `aggregates.byAgent`, the
   * amount is a dollar figure one level further down in `totals`, and the span the
   * Gateway resolved comes back with it.
   */
  it("reads the per-agent aggregate of a ranged reply", () => {
    const report = projectCostReport({
      updatedAt: 1_800_000_000_000,
      startDate: "2026-08-18",
      endDate: "2026-08-18",
      sessions: [],
      totals: { totalCost: 0.037, missingCostEntries: 0 },
      aggregates: {
        byAgent: [
          { agentId: "builder", totals: { totalCost: 0.03, totalTokens: 900, missingCostEntries: 0 } },
          { agentId: "runner", totals: { totalCost: 0.007, totalTokens: 120, missingCostEntries: 1 } },
        ],
        messages: { total: 27, toolCalls: 17, errors: 3 },
      },
    });

    expect(report.byAgent.get("builder")).toEqual({ costMicroUsd: 30_000, hasCost: true });
    // The Gateway counted an entry it could not price, so this amount is a floor.
    expect(report.byAgent.get("runner")).toEqual({ costMicroUsd: 7_000, hasCost: false });
    expect(report.totalMicroUsd).toBe(37_000);
    expect(report.pricedFrom).toBe("2026-08-18");
    expect(report.pricedTo).toBe("2026-08-18");
  });

  /**
   * What 2026.7.1-2 answered for a week holding 27,844 tokens: the aggregate has
   * the counts, `totalCost` is zero, and one entry went unpriced because the codex
   * harness has no price table. Reported as an amount it renders "$0.00+", which
   * puts a floor marker on a figure that measures nothing.
   */
  it("reports no amount when nothing in the span could be priced", () => {
    const report = projectCostReport({
      startDate: "2026-08-12",
      endDate: "2026-08-18",
      aggregates: {
        byAgent: [{ agentId: "main", totals: { totalTokens: 27_844, totalCost: 0, missingCostEntries: 1 } }],
      },
    });

    expect(report.byAgent.has("main")).toBe(false);
    // The span still came back, so the window knows what it asked about.
    expect(report.pricedFrom).toBe("2026-08-12");
  });

  /** A day with no work priced to zero is a fact, and reads as one. */
  it("keeps a zero that nothing was left unpriced against", () => {
    const report = projectCostReport({
      startDate: "2026-08-18",
      endDate: "2026-08-18",
      aggregates: { byAgent: [{ agentId: "main", totals: { totalTokens: 0, totalCost: 0, missingCostEntries: 0 } }] },
    });

    expect(report.byAgent.get("main")).toEqual({ costMicroUsd: 0, hasCost: true });
  });

  it("reads per-agent cost from a list", () => {
    const report = projectCostReport({
      agents: [
        { agentId: "builder", costMicroUsd: 1_000 },
        { agentId: "runner", costUsd: 0.002 },
      ],
    });
    expect(report.byAgent.get("builder")).toEqual({ costMicroUsd: 1_000, hasCost: true });
    expect(report.byAgent.get("runner")).toEqual({ costMicroUsd: 2_000, hasCost: true });
    expect(report.totalMicroUsd).toBe(3_000);
  });

  it("reads per-agent cost from a keyed map", () => {
    const report = projectCostReport({ byAgent: { builder: { costUsd: 0.5 } } });
    expect(report.byAgent.get("builder")).toEqual({ costMicroUsd: 500_000, hasCost: true });
  });

  it("prefers a reported total over the sum of its parts", () => {
    const report = projectCostReport({ totalUsd: 9, agents: [{ agentId: "builder", costMicroUsd: 1_000 }] });
    expect(report.totalMicroUsd).toBe(9_000_000);
  });

  it("returns nothing rather than zero when the reply carries no cost", () => {
    const report = projectCostReport({ agents: [] });
    expect(report.byAgent.size).toBe(0);
    expect(report.totalMicroUsd).toBeUndefined();
  });
});
