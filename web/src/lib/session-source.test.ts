import { describe, expect, it } from "vitest";
import { buildSessionSources, reportedLineageFields } from "./session-source";

describe("reported one-hop session sources", () => {
  it("merges one true source identity while keeping each reported relationship", () => {
    expect(buildSessionSources("current", { parentSessionKey: "agent:writer:parent", spawnedBy: "agent:writer:parent", forkSourceKey: "fork-other" }).sources).toEqual([
      { reference: "agent:writer:parent", lookupKey: "agent:writer:parent", relations: ["Parent", "Spawned by"] },
      { reference: "fork-other", lookupKey: "fork-other", relations: ["Forked from"] },
    ]);
  });

  it("does not query an arbitrary spawn actor, but preserves it as an unresolved source", () => {
    expect(buildSessionSources("current", { spawnedBy: "scheduler" }).sources).toEqual([
      { reference: "scheduler", relations: ["Spawned by"] },
    ]);
    expect(buildSessionSources("current", { spawnedBy: "agent:writer:parent" }).sources[0]?.lookupKey).toBe("agent:writer:parent");
  });

  it("uses explicit key evidence for a spawn value that also names a parent", () => {
    expect(buildSessionSources("current", { parentSessionKey: "opaque-local-key", spawnedBy: "opaque-local-key" }).sources).toEqual([
      { reference: "opaque-local-key", lookupKey: "opaque-local-key", relations: ["Parent", "Spawned by"] },
    ]);
  });

  it("never turns a generation ID, depth, or worktree into ancestors", () => {
    expect(buildSessionSources("current", { previousSessionId: "generation-3", spawnDepth: 4, worktreeBranch: "feature/tree", subagentRole: "researcher" })).toEqual({ sources: [], selfReferences: [] });
  });

  it("keeps a self-reference as a reported anomaly instead of drawing a self-parent", () => {
    expect(buildSessionSources("current", { parentSessionKey: "current", spawnedBy: "current" })).toEqual({ sources: [], selfReferences: ["Parent", "Spawned by"] });
  });

  it("folds only reported fields and keeps a real depth of zero", () => {
    expect(reportedLineageFields({ parentSessionKey: " ", spawnDepth: 0, previousSessionId: "v0" })).toEqual([
      { key: "previousSessionId", label: "Previous version", value: "v0" },
      { key: "spawnDepth", label: "Depth", value: 0 },
    ]);
  });
});
