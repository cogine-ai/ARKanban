import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRuntime } from "../collector/runtime.js";
import type { ResolvedCollectorConfig } from "../config.js";
import { createHttpServer } from "./server.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function runtimeFixture(retentionDays = 30): { runtime: CollectorRuntime; config: ResolvedCollectorConfig } {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-http-"));
  const config: ResolvedCollectorConfig = {
    gateway: { name: "test", url: "ws://127.0.0.1:18789", tokenEnv: "TEST_TOKEN", token: "secret" },
    server: { host: "127.0.0.1", port: 47_123 },
    storage: {
      path: path.join(directory, "collector.sqlite"),
      terminalRetentionDays: retentionDays,
      usageRetentionDays: 14,
      sessionRetentionDays: 90,
    },
    reconcile: { tasksMs: 15_000, sessionsMs: 8_000 },
    ui: { recentLimit: 200 },
    configPath: path.join(directory, "collector.config.json"),
  };
  const runtime = new CollectorRuntime(config);
  cleanups.push(async () => {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, config };
}

describe("settled group HTTP API", () => {
  it("defaults to seven days and exposes retention completeness", async () => {
    const { runtime, config } = runtimeFixture(1);
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());

    const response = await app.inject({ method: "GET", url: "/api/v1/settled-groups" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ range: "7d", complete: false, totalRuns: 0, totalSeries: 0 });
  });

  it("rejects invalid ranges and range endpoints", async () => {
    const { runtime, config } = runtimeFixture();
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());

    expect((await app.inject({ method: "GET", url: "/api/v1/settled-groups?range=1y" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/settled-groups?rangeEnd=not-a-time" })).statusCode).toBe(400);
  });
});
