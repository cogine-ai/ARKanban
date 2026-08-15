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
  it("reads per-agent cost from a list", () => {
    const report = projectCostReport({
      agents: [
        { agentId: "builder", costMicroUsd: 1_000 },
        { agentId: "runner", costUsd: 0.002 },
      ],
    });
    expect(report.byAgent.get("builder")).toBe(1_000);
    expect(report.byAgent.get("runner")).toBe(2_000);
    expect(report.totalMicroUsd).toBe(3_000);
  });

  it("reads per-agent cost from a keyed map", () => {
    const report = projectCostReport({ byAgent: { builder: { costUsd: 0.5 } } });
    expect(report.byAgent.get("builder")).toBe(500_000);
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
