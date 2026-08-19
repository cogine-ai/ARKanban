import { describe, expect, it } from "vitest";
import { CapabilityRegistry, classifyProbeFailure } from "./capability-probe.js";

describe("classifyProbeFailure", () => {
  it("treats a missing method as permanently unavailable", () => {
    expect(classifyProbeFailure(new Error("method_not_found: sessions.usage"))).toBe("unavailable");
  });

  it("separates scope refusals from missing methods", () => {
    expect(classifyProbeFailure(new Error("unauthorized: scope operator.read required"))).toBe("unauthorized");
  });

  it("treats anything else as transient", () => {
    expect(classifyProbeFailure(new Error("socket hang up"))).toBe("error");
  });
});

describe("CapabilityRegistry", () => {
  it("starts every method unknown", () => {
    expect(new CapabilityRegistry().stateOf("sessions.usage")).toBe("unknown");
  });

  it("marks a successful probe live", async () => {
    const registry = new CapabilityRegistry();
    await registry.probeAll(async () => ({ ok: true }));
    expect(registry.stateOf("sessions.usage")).toBe("live");
  });

  it("does not re-probe a settled unavailable method", async () => {
    const registry = new CapabilityRegistry();
    let calls = 0;
    const failing = async (): Promise<never> => {
      calls += 1;
      throw new Error("method_not_found");
    };
    await registry.probeAll(failing);
    const afterFirst = calls;
    await registry.probeAll(failing);
    expect(calls).toBe(afterFirst);
  });

  it("retries a transient failure on the next pass", async () => {
    const registry = new CapabilityRegistry();
    let attempt = 0;
    await registry.probeAll(async (method) => {
      if (method !== "sessions.usage") return {};
      attempt += 1;
      throw new Error("socket hang up");
    });
    expect(registry.stateOf("sessions.usage")).toBe("error");
    await registry.probeAll(async () => ({}));
    expect(registry.stateOf("sessions.usage")).toBe("live");
    expect(attempt).toBe(1);
  });

  it("discards verdicts on a new connection generation", async () => {
    const registry = new CapabilityRegistry();
    await registry.probeAll(async () => ({}));
    expect(registry.stateOf("sessions.usage")).toBe("live");
    registry.newGeneration();
    expect(registry.stateOf("sessions.usage")).toBe("unknown");
  });

  it("advances the generation counter on reconnect", () => {
    const registry = new CapabilityRegistry();
    const before = registry.currentGeneration;
    registry.newGeneration();
    expect(registry.currentGeneration).toBe(before + 1);
  });

  it("reports a verdict for every non-discoverable method", async () => {
    const registry = new CapabilityRegistry();
    await registry.probeAll(async () => ({}));
    expect(Object.keys(registry.snapshot()).sort()).toEqual([
      "chat.history",
      "sessions.usage",
      "sessions.usage.timeseries",
    ]);
  });

  /**
   * A probe must be a call the Gateway would accept. `chat.history` reports on a
   * session, so asking about an invented key would answer a question about that
   * key rather than about whether the method exists.
   */
  it("waits for a real session before probing chat.history", async () => {
    const registry = new CapabilityRegistry();
    const asked: string[] = [];
    const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      asked.push(`${method}:${String(params.sessionKey ?? "-")}`);
      return {};
    };

    await registry.probeAll(call);
    expect(asked).not.toContain("chat.history:-");
    expect(registry.stateOf("chat.history")).toBe("unknown");

    await registry.probeAll(call, { sessionKey: "agent:builder:one" });
    expect(asked).toContain("chat.history:agent:builder:one");
    expect(registry.stateOf("chat.history")).toBe("live");
  });
});
