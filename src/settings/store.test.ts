import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedCollectorConfig } from "../config.js";
import { clearPairingOffers, createPairingOffer, redeemPairingOffer } from "./pairing.js";
import { loadSecrets, maskSecret, saveSecrets, secretsPathFor } from "./secrets.js";
import { createSettingsService, resetSettingsRestartFlag } from "./store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  clearPairingOffers();
  resetSettingsRestartFlag();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixtureConfig(): ResolvedCollectorConfig {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-settings-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "collector.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      host: { id: "desk-a", label: "Desk A" },
      role: "node",
      gateway: { name: "gw", url: "ws://127.0.0.1:18789", tokenEnv: "OPENCLAW_GATEWAY_TOKEN" },
      server: { host: "127.0.0.1", port: 47123 },
      localSources: { standaloneCli: "enabled" },
      storage: { path: "./data.sqlite" },
    }),
  );
  return {
    host: { id: "desk-a", label: "Desk A" },
    role: "node",
    gateway: { name: "gw", url: "ws://127.0.0.1:18789", tokenEnv: "OPENCLAW_GATEWAY_TOKEN", token: "" },
    server: { host: "127.0.0.1", port: 47123 },
    hub: { nodes: [] },
    localSources: { standaloneCli: "enabled" },
    storage: {
      path: path.join(directory, "data.sqlite"),
      terminalRetentionDays: 30,
      usageRetentionDays: 14,
      sessionRetentionDays: 90,
      transcriptRetentionDays: 180,
      transcriptMaxBytes: 64 * 1024 * 1024,
      transcriptSync: "disabled",
    },
    reconcile: { tasksMs: 15_000, sessionsMs: 8_000 },
    ui: { recentLimit: 200 },
    configPath,
  };
}

describe("secrets masking", () => {
  it("never returns the raw secret", () => {
    expect(maskSecret(undefined)).toEqual({ configured: false });
    expect(maskSecret("abcdefghijklmnop")).toEqual({ configured: true, hint: "••••mnop" });
  });
});

describe("pairing codes", () => {
  it("redeems once and then rejects", () => {
    const offer = createPairingOffer({ hostId: "desk-a", label: "Desk A", token: "shared-secret" });
    expect(redeemPairingOffer(offer.code)).toEqual({
      hostId: "desk-a",
      label: "Desk A",
      token: "shared-secret",
    });
    expect(redeemPairingOffer(offer.code)).toBeUndefined();
  });
});

describe("settings service", () => {
  it("stores gateway token in the secrets file and only exposes a hint", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config);
    const publicView = settings.applyPatch({ gateway: { token: "gateway-secret-value" } });
    expect(publicView.gateway.token).toEqual({ configured: true, hint: "••••alue" });
    expect(JSON.stringify(publicView)).not.toContain("gateway-secret-value");

    const secrets = loadSecrets(secretsPathFor(config.configPath));
    expect(secrets.gatewayToken).toBe("gateway-secret-value");
    const rawConfig = readFileSync(config.configPath, "utf8");
    expect(rawConfig).not.toContain("gateway-secret-value");
  });

  it("adds a hub node from a redeemed pairing payload", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config);
    const publicView = settings.addHubNode({
      id: "desk-b",
      url: "http://192.168.1.20:47123",
      label: "Desk B",
      token: "node-token",
    });
    expect(publicView.hub.nodes).toHaveLength(1);
    expect(publicView.hub.nodes[0]?.token.configured).toBe(true);
    expect(publicView.role).toBe("both");
    expect(loadSecrets(secretsPathFor(config.configPath)).nodeTokens?.["desk-b"]).toBe("node-token");
  });

  it("persists secrets with owner-only intent", () => {
    const config = fixtureConfig();
    const secretsPath = secretsPathFor(config.configPath);
    saveSecrets(secretsPath, { serverToken: "lan-secret" });
    expect(loadSecrets(secretsPath).serverToken).toBe("lan-secret");
  });
});
