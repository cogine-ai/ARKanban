import { describe, expect, it } from "vitest";
import { agentIdFromSessionKey, attemptPatch, sessionAgentId, stableTaskActivityId, taskToActivity } from "./projector.js";

describe("activity projector", () => {
  it("keeps the task ledger and observed attempt as different activity kinds", () => {
    const task = taskToActivity({
      id: "task-1",
      status: "running",
      title: "Collect sources",
      agentId: "researcher",
      runId: "run-1",
      createdAt: 1_000,
      updatedAt: 2_000,
    }, 2_100);
    const attempt = attemptPatch({
      id: "attempt:ri_test",
      sourceKey: "attempt:run:run-1",
      origin: "online",
      agentId: "researcher",
      title: "Collect sources run",
      now: 2_100,
      runRef: "run-1",
      state: "active",
      phase: "tool",
      lastToolName: "read",
      source: "events",
      eventKind: "agent:tool:start",
    });

    expect(task).toMatchObject({ id: stableTaskActivityId("task-1"), kind: "task", state: "active" });
    expect(attempt).toMatchObject({ id: "attempt:ri_test", kind: "attempt", state: "active", phase: "tool" });
    expect(task?.id).not.toBe(attempt.id);
  });

  it("does not infer success from an unqualified attempt end", () => {
    const attempt = attemptPatch({
      id: "attempt:ri_end",
      sourceKey: "attempt:run:run-end",
      origin: "online",
      agentId: "ops",
      title: "Observed run",
      now: 4_000,
      runRef: "run-end",
      state: "terminal",
      source: "events",
      eventKind: "agent:lifecycle:end",
    });
    expect(attempt.outcome).toBe("unknown");
    expect(attempt.stage).toBe("settled");
  });

  it("uses the task ledger's explicit terminal outcome", () => {
    expect(taskToActivity({ id: "ok", status: "completed", terminalOutcome: "succeeded" }, 10)?.outcome).toBe("succeeded");
    expect(taskToActivity({ id: "blocked", status: "completed", terminalOutcome: "blocked" }, 10)?.outcome).toBe("blocked");
    expect(taskToActivity({ id: "failed", status: "failed" }, 10)?.outcome).toBe("failed");
  });

  it("derives a missing session agent from a structured OpenClaw session key", () => {
    expect(sessionAgentId({ key: "agent:pm-awb:feishu:group:group-one" })).toBe("pm-awb");
    expect(sessionAgentId({ key: "agent:pm-awb:one", agentId: "explicit-agent" })).toBe("explicit-agent");
    expect(agentIdFromSessionKey("not-an-agent-key")).toBeUndefined();
    expect(agentIdFromSessionKey("agent:bad/id:one")).toBeUndefined();
    expect(sessionAgentId({ key: "not-an-agent-key" })).toBe("Unattributed");
  });
});
