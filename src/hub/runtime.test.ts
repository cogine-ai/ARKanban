import { describe, expect, it } from "vitest";
import type { ResolvedCollectorConfig } from "../config.js";
import { HubRuntime } from "./runtime.js";

describe("running Hub identity", () => {
  it("continues reporting the running Hub role after a node role is saved", async () => {
    const config: ResolvedCollectorConfig = {
      host: { id: "hub", label: "Hub" }, role: "hub",
      gateway: { name: "test", url: "ws://127.0.0.1:18789", tokenEnv: "TEST_TOKEN", token: "test-token" },
      server: { host: "127.0.0.1", port: 47123 },
      hub: { nodes: [{ id: "node", url: "http://127.0.0.1:47124", tokenEnv: "TEST_NODE", token: "node-token" }] },
      localSources: { standaloneCli: "disabled" },
      storage: { path: "/unused-hub.sqlite", terminalRetentionDays: 7, usageRetentionDays: 7, sessionRetentionDays: 30, transcriptRetentionDays: 180, transcriptMaxBytes: 1000, transcriptSync: "disabled" },
      reconcile: { tasksMs: 15000, sessionsMs: 8000 }, ui: { recentLimit: 200 }, configPath: "/unused-config.json",
    };
    const runtime = new HubRuntime(config);
    config.role = "node";
    config.host.id = "renamed-hub";
    config.host.label = "Renamed Hub";
    expect(runtime.getStatus().host).toEqual({ id: "hub", label: "Hub", role: "hub" });
    expect(runtime.getStatus().host.role).toBe("hub");
    expect(runtime.getStatus().epoch).toBe("hub:hub");
    expect(runtime.getSnapshot().epoch).toBe("hub:hub");
    const epochs: string[] = [];
    const unsubscribe = runtime.subscribeChanges((change) => epochs.push(change.epoch));
    (runtime as unknown as { emitChange(topics: ["activities"], reasons: string[]): void }).emitChange(["activities"], ["saved_config"]);
    expect(epochs).toEqual(["hub:hub"]);
    unsubscribe();

    // Restarting in Hub mode is the boundary that applies its new host identity.
    const restarted = new HubRuntime({ ...config, role: "hub" });
    expect(restarted.getStatus().host).toEqual({ id: "renamed-hub", label: "Renamed Hub", role: "hub" });
    expect(restarted.getSnapshot().epoch).toBe("hub:renamed-hub");
    await restarted.stop();
    await runtime.stop();
  });
});
