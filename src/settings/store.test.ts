import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ResolvedCollectorConfig } from "../config.js";
import { clearPairingOffers, createPairingOffer, redeemPairingOffer } from "./pairing.js";
import { loadSecrets, maskSecret, saveSecrets, secretsPathFor } from "./secrets.js";
import { createSettingsService } from "./store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  clearPairingOffers();
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
  it("keeps startup facts stable and private while saved settings await restart", () => {
    const config = fixtureConfig();
    config.gateway.url = "ws://operator:gateway-secret@127.0.0.1:18789/rpc?token=query-secret";
    const settings = createSettingsService(config, 123_456);
    const original = settings.getPublicSettings().runtime;
    settings.addHubNode({ id: "desk-b", url: "http://192.168.1.20:47123", token: "node-secret" });
    const saved = settings.applyPatch({
      role: "hub",
      host: { id: "hub", label: "Hub" },
      server: { host: "0.0.0.0", port: 48_000 },
      gateway: { name: "changed", url: "ws://127.0.0.1:18790" },
    });

    expect(saved.runtime).toEqual(original);
    expect(saved.runtime).toMatchObject({
      role: "node",
      host: { id: "desk-a", label: "Desk A" },
      server: { host: "127.0.0.1", port: 47123, lanExposed: false },
      gateway: { name: "gw", url: "ws://127.0.0.1:18789/rpc" },
      storage: { transcriptSync: "disabled" },
      nodeIds: [],
      startedAt: 123_456,
    });
    expect(saved.role).toBe("hub");
    expect(saved.restartRequired).toBe(true);
    expect(JSON.stringify(saved.runtime)).not.toContain("secret");

    saved.runtime.host.label = "spoofed";
    saved.runtime.storage.transcriptSync = "enabled";
    saved.runtime.nodeIds.push("spoofed");
    expect(settings.getPublicSettings().runtime).toEqual(original);
  });

  it("requires an explicit save and restart before enabling local transcript storage", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config, 1000);
    expect(settings.getPublicSettings()).toMatchObject({
      storage: { transcriptSync: "disabled" },
      runtime: { storage: { transcriptSync: "disabled" } },
      restartRequired: false,
    });
    const originalStorage = { ...config.storage };
    const saved = settings.applyPatch({ storage: { transcriptSync: "enabled" } });
    expect(saved).toMatchObject({ storage: { transcriptSync: "enabled" }, runtime: { storage: { transcriptSync: "disabled" } }, restartRequired: true });
    expect(config.storage).toEqual(originalStorage);
    expect(JSON.parse(readFileSync(config.configPath, "utf8")).storage).toEqual({ path: "./data.sqlite", transcriptSync: "enabled" });

    settings.applyPatch({ host: { label: "Renamed" } });
    expect(settings.getPublicSettings().storage.transcriptSync).toBe("enabled");
    expect(config.storage.transcriptSync).toBe("disabled");
    const restarted = createSettingsService(loadConfig(config.configPath, { OPENCLAW_GATEWAY_TOKEN: "gateway-token" }), 2000);
    expect(restarted.getPublicSettings()).toMatchObject({ storage: { transcriptSync: "enabled" }, runtime: { storage: { transcriptSync: "enabled" }, startedAt: 2000 }, restartRequired: false });
  });

  it("saves disabling as pending without touching the database or current archive policy", () => {
    const config = fixtureConfig();
    config.storage.transcriptSync = "enabled";
    const settings = createSettingsService(config);
    writeFileSync(config.storage.path, "stored transcript bytes");
    const saved = settings.applyPatch({ storage: { transcriptSync: "disabled" } });
    expect(saved).toMatchObject({ storage: { transcriptSync: "disabled" }, runtime: { storage: { transcriptSync: "enabled" } }, restartRequired: true });
    expect(config.storage.transcriptSync).toBe("enabled");
    expect(readFileSync(config.storage.path, "utf8")).toBe("stored transcript bytes");
  });

  it("rejects invalid archive choices atomically", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config);
    const original = readFileSync(config.configPath, "utf8");
    for (const value of [null, "auto", true, 1]) {
      expect(() => settings.applyPatch({ host: { label: "Partial change" }, storage: { transcriptSync: value as "enabled" } })).toThrow("invalid_transcript_sync");
      expect(readFileSync(config.configPath, "utf8")).toBe(original);
      expect(settings.getPublicSettings()).toMatchObject({ host: { label: "Desk A" }, storage: { transcriptSync: "disabled" }, restartRequired: false });
    }
    expect(() => settings.applyPatch({ storage: null as never })).toThrow("invalid_transcript_sync");
  });

  it("rejects an empty hub without writing a partial configuration", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config);
    const before = readFileSync(config.configPath, "utf8");
    expect(() => settings.applyPatch({ role: "hub", host: { label: "Changed" } })).toThrow("hub_nodes_required");
    expect(readFileSync(config.configPath, "utf8")).toBe(before);
    expect(settings.getPublicSettings()).toMatchObject({ role: "node", restartRequired: false });

    settings.addHubNode({ id: "desk-b", url: "http://192.168.1.20:47123", token: "node-token" });
    expect(settings.applyPatch({ role: "hub" }).role).toBe("hub");
    expect(() => settings.applyPatch({ hub: { nodes: [] } })).toThrow("hub_nodes_required");
    expect(settings.getPublicSettings().hub.nodes).toHaveLength(1);
  });

  it("prepares the LAN credential before restart and does not prepare it again afterwards", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config);
    const saved = settings.applyPatch({ server: { host: "0.0.0.0" } });
    expect(saved.server.token.configured).toBe(true);
    expect(saved.runtime.server.lanExposed).toBe(false);
    expect(saved.restartRequired).toBe(true);

    const restartedConfig = loadConfig(config.configPath, { OPENCLAW_GATEWAY_TOKEN: "gateway-token" });
    const restarted = createSettingsService(restartedConfig);
    expect(restarted.getPublicSettings().runtime.server.lanExposed).toBe(true);
    expect(restarted.ensureServerToken().created).toBe(false);
    expect(restarted.getPublicSettings().restartRequired).toBe(false);
    expect(settings.getPublicSettings().restartRequired).toBe(true);
  });

  it("requires a new HTTP surface when a node credential was not present at startup", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config);
    expect(settings.ensureServerToken().created).toBe(true);
    expect(settings.getPublicSettings().restartRequired).toBe(true);
    expect(settings.ensureServerToken().created).toBe(false);
    expect(settings.getPublicSettings().restartRequired).toBe(true);
  });

  it("revokes an outstanding connection code when configuration changes", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config);
    const offer = createPairingOffer({ hostId: config.host.id, label: config.host.label, token: "server-token" });
    settings.applyPatch({ host: { id: "renamed" } });
    expect(settings.getPublicSettings().pairing.active).toBeUndefined();
    expect(redeemPairingOffer(offer.code)).toBeUndefined();
  });

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
    expect(publicView.role).toBe("node");
    expect(loadSecrets(secretsPathFor(config.configPath)).nodeTokens?.["desk-b"]).toBe("node-token");
  });

  it("does not commit an in-memory patch when later validation fails", () => {
    const config = fixtureConfig();
    const settings = createSettingsService(config);
    settings.applyPatch({ host: { label: "Desk Z" } });
    expect(() =>
      settings.applyPatch({ host: { label: "Desk Y" }, role: "nope" as unknown as "hub" }),
    ).toThrow("invalid_role");
    expect(settings.getPublicSettings().host.label).toBe("Desk Z");
    expect(JSON.parse(readFileSync(config.configPath, "utf8")).host.label).toBe("Desk Z");
  });

  it("persists secrets with owner-only intent", () => {
    const config = fixtureConfig();
    const secretsPath = secretsPathFor(config.configPath);
    saveSecrets(secretsPath, { serverToken: "lan-secret" });
    expect(loadSecrets(secretsPath).serverToken).toBe("lan-secret");
  });
});
