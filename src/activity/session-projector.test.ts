import { describe, expect, it } from "vitest";
import { FieldInventory } from "../collector/field-inventory.js";
import { inferAgents, projectAgent, projectSession, sessionKindHint } from "./session-projector.js";

const NOW = 1_760_000_000_000;

function fullSessionRow(): Record<string, unknown> {
  return {
    key: "agent:researcher:demo-1",
    sessionId: "session-1",
    agentId: "researcher",
    label: "Competitive scan",
    agentRuntime: "openclaw",
    model: "claude-opus-4",
    category: "research",
    kind: "subagent",
    archived: false,
    hasActiveRun: true,
    placement: "workspace",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    parentSessionKey: "agent:researcher:demo-0",
    spawnedBy: "agent:researcher:demo-0",
    spawnDepth: 2,
    subagentRole: "researcher",
    worktree: { branch: "feature/demo", repoRoot: "/home/demo/repo" },
  };
}

describe("projectSession", () => {
  it("maps a fully populated row", () => {
    const write = projectSession(fullSessionRow(), NOW);
    expect(write).toBeDefined();
    expect(write?.sessionKey).toBe("agent:researcher:demo-1");
    expect(write?.sessionId).toBe("session-1");
    expect(write?.agentId).toBe("researcher");
    expect(write?.label).toBe("Competitive scan");
    expect(write?.runtime).toBe("openclaw");
    expect(write?.model).toBe("claude-opus-4");
    expect(write?.kindHint).toBe("subagent");
    expect(write?.hasActiveRun).toBe(true);
    expect(write?.archived).toBe(false);
    expect(write?.lastActivityAt).toBe(NOW - 1_000);
    expect(write?.lineage.spawnDepth).toBe(2);
    expect(write?.lineage.parentSessionKey).toBe("agent:researcher:demo-0");
  });

  /**
   * A row shaped like `buildGatewaySessionRow` in OpenClaw 2026.7.1-2 rather than
   * like the protocol prose: no `agentId`, no `createdAt`, `agentRuntime` as a
   * descriptor object, `forkedFromParent` for the fork source, and a `kind` whose
   * vocabulary cannot express fork or subagent.
   */
  function realSessionRow(): Record<string, unknown> {
    return {
      key: "agent:builder:demo-2",
      sessionId: "session-9",
      label: "Fix the parser",
      displayName: "Fix the parser",
      agentRuntime: { id: "codex", source: "implicit" },
      model: "gpt-5-codex",
      modelProvider: "openai",
      kind: "direct",
      archived: false,
      archivedAt: undefined,
      hasActiveRun: true,
      status: "running",
      updatedAt: NOW - 2_000,
      lastActivityAt: NOW - 2_000,
      startedAt: NOW - 30_000,
      forkedFromParent: "agent:builder:demo-1",
      totalTokens: 4_210,
      estimatedCostUsd: 0.0731,
    };
  }

  it("reads the shape the Gateway actually sends", () => {
    const write = projectSession(realSessionRow(), NOW);

    expect(write?.agentId).toBe("builder");
    expect(write?.runtime).toBe("codex");
    expect(write?.lineage.forkSourceKey).toBe("agent:builder:demo-1");
    // `startedAt` is the newest run, so it must not become a creation time.
    expect(write?.createdAt).toBeUndefined();
  });

  it("calls a forked session a fork even though its kind says direct", () => {
    const write = projectSession(realSessionRow(), NOW);
    expect(write?.kindHint).toBe("fork");
  });

  it("calls a spawned session a subagent, which no kind value can express", () => {
    const row = { ...realSessionRow(), forkedFromParent: undefined, spawnedBy: "agent:builder:demo-1", spawnDepth: 1 };
    expect(projectSession(row, NOW)?.kindHint).toBe("subagent");
  });

  it("does not flatten a group conversation into main", () => {
    const row = { key: "agent:builder:whatsapp:group:42", kind: "group" };
    expect(projectSession(row, NOW)?.kindHint).toBe("unknown");
  });

  it("keeps the worktree branch but drops the repo path", () => {
    const write = projectSession(fullSessionRow(), NOW);
    expect(write?.lineage.worktreeBranch).toBe("feature/demo");
    expect(JSON.stringify(write)).not.toContain("/home/demo/repo");
  });

  it("drops rows without a session key rather than synthesising one", () => {
    expect(projectSession({ agentId: "researcher" }, NOW)).toBeUndefined();
  });

  it("derives the agent id from the session key when absent", () => {
    expect(projectSession({ key: "agent:writer:demo-9" }, NOW)?.agentId).toBe("writer");
  });

  it("falls back to the observation time when no activity timestamp is present", () => {
    expect(projectSession({ key: "agent:ops:demo-2" }, NOW)?.lastActivityAt).toBe(NOW);
  });

  it("reads a timestamp-shaped archived field as archived", () => {
    expect(projectSession({ key: "agent:ops:demo-3", archivedAt: "2026-01-01T00:00:00Z" }, NOW)?.archived).toBe(true);
  });

  it("accepts alias field names", () => {
    const write = projectSession(
      { sessionKey: "agent:ops:demo-4", displayName: "Aliased", runtime: "codex", lastMessageAt: NOW - 500 },
      NOW,
    );
    expect(write?.label).toBe("Aliased");
    expect(write?.runtime).toBe("codex");
    expect(write?.lastActivityAt).toBe(NOW - 500);
  });

  it("marks index coverage live and everything else unobserved", () => {
    expect(projectSession(fullSessionRow(), NOW)?.coverage).toEqual({
      index: "live",
      detail: "not_observed",
      usage: "not_observed",
      messages: "not_observed",
    });
  });
});

describe("sessionKindHint", () => {
  it("normalises documented tokens", () => {
    expect(sessionKindHint("direct", "agent:a:1")).toBe("main");
    expect(sessionKindHint("forked", "agent:a:1")).toBe("fork");
    expect(sessionKindHint("child", "agent:a:1")).toBe("subagent");
  });

  it("infers global sessions from the key prefix", () => {
    expect(sessionKindHint(undefined, "global:main")).toBe("global");
  });

  it("returns unknown rather than guessing on unrecognised tokens", () => {
    expect(sessionKindHint("something-new", "agent:a:1")).toBe("unknown");
  });
});

describe("projectAgent", () => {
  it("maps a roster row", () => {
    const write = projectAgent({ id: "researcher", displayName: "Researcher", kind: "agent", model: "gpt-5" }, NOW);
    expect(write?.displayName).toBe("Researcher");
    expect(write?.kind).toBe("agent");
    expect(write?.origin).toBe("roster");
  });

  it("falls back to unknown for unrecognised kinds", () => {
    expect(projectAgent({ id: "x", kind: "weird" }, NOW)?.kind).toBe("unknown");
  });

  /**
   * `listAgentsForGateway` names the label `name`, makes `model` a
   * `{ primary, fallbacks }` selection and `agentRuntime` a descriptor, and
   * exposes no kind at all. Both objects matched the old alias lists and then
   * projected as nothing, since a string was expected.
   */
  it("reads the roster shape the Gateway actually sends", () => {
    const write = projectAgent(
      {
        id: "builder",
        name: "Builder",
        model: { primary: "gpt-5-codex", fallbacks: ["gpt-5"] },
        agentRuntime: { id: "codex", source: "config" },
        workspace: "/Users/demo/.openclaw/workspace",
      },
      NOW,
    );

    expect(write?.displayName).toBe("Builder");
    expect(write?.model).toBe("gpt-5-codex");
    expect(write?.runtime).toBe("codex");
    // No kind is published, and inventing one would misreport a fact.
    expect(write?.kind).toBe("unknown");
  });

  it("drops rows without an id", () => {
    expect(projectAgent({ displayName: "No id" }, NOW)).toBeUndefined();
  });
});

describe("inferAgents", () => {
  it("deduplicates and marks entries as observed", () => {
    const agents = inferAgents(["a", "b", "a"], NOW);
    expect(agents).toHaveLength(2);
    expect(agents.every((agent) => agent.origin === "observed")).toBe(true);
  });
});

describe("field inventory integration", () => {
  it("reports response keys that no alias consumed", () => {
    const inventory = new FieldInventory("sessions.list");
    projectSession({ key: "agent:a:1", totallyNewField: 42 }, NOW, inventory);
    expect(inventory.report().unknown).toContain("totallyNewField");
  });

  it("does not report a key as unknown once an alias matched it", () => {
    const inventory = new FieldInventory("sessions.list");
    projectSession(fullSessionRow(), NOW, inventory);
    const { unknown } = inventory.report();
    expect(unknown).not.toContain("agentId");
    expect(unknown).not.toContain("sessionId");
  });

  it("does not report a recognised alternate alias as unknown", () => {
    const inventory = new FieldInventory("sessions.list");
    // lastActivityAt wins over its alternate updatedAt, which is understood, not unrecognised.
    projectSession({ key: "agent:a:1", lastActivityAt: NOW, updatedAt: NOW - 1 }, NOW, inventory);
    expect(inventory.report().unknown).not.toContain("updatedAt");
  });

  it("reports a logical field whose whole alias list failed to match", () => {
    const inventory = new FieldInventory("sessions.list");
    projectSession({ key: "agent:a:1" }, NOW, inventory);
    expect(inventory.report().missing).toContain("model: model|modelId");
  });

  it("does not report a field as missing when a non-preferred alias matched", () => {
    const inventory = new FieldInventory("sessions.list");
    projectSession({ sessionKey: "agent:a:1" }, NOW, inventory);
    const { missing } = inventory.report();
    expect(missing.some((entry) => entry.startsWith("sessionKey:"))).toBe(false);
  });

  it("counts observed rows", () => {
    const inventory = new FieldInventory("sessions.list");
    projectSession({ key: "agent:a:1" }, NOW, inventory);
    projectSession({ key: "agent:a:2" }, NOW, inventory);
    expect(inventory.report().rowsObserved).toBe(2);
  });
});
