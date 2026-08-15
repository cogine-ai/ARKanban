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
    // createdAt wins over its alternate startedAt, which is understood, not unrecognised.
    projectSession({ key: "agent:a:1", createdAt: NOW, startedAt: NOW - 1 }, NOW, inventory);
    expect(inventory.report().unknown).not.toContain("startedAt");
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
