import { describe, expect, it, vi } from "vitest";
import type { CollectorStatus } from "../../../src/contracts";
import type { PublicSettings } from "../api";
import {
  claimAndEnableHub,
  connectionAddress,
  encodeConnectionPackage,
  expiryCountdown,
  intentForRole,
  machineConnectionState,
  parseConnectionPackage,
  roleForIntent,
  settingsError,
  shareReadiness,
  suggestedConnectionAddress,
  type ConnectionPackage,
} from "./settings-flow";

const now = 1_800_000_000_000;
const connection: ConnectionPackage = { version: 1, nodeUrl: "http://192.168.1.24:47123", code: "A7K2-9MQX", label: "Writer Mac", hostId: "writer", expiresAt: now + 600_000 };
function settings(): PublicSettings {
  return {
    role: "node", host: { id: "hub", label: "This machine" },
    gateway: { name: "OpenClaw", url: "ws://127.0.0.1:18789", token: { configured: true } },
    server: { host: "0.0.0.0", port: 47123, lanExposed: true, token: { configured: true } },
    hub: { nodes: [] }, localSources: { standaloneCli: "enabled" }, storage: { transcriptSync: "disabled" }, pairing: {}, paths: { config: "/config", secrets: "/secrets" }, restartRequired: false,
    runtime: { role: "node", host: { id: "hub", label: "This machine" }, server: { host: "0.0.0.0", port: 47123, lanExposed: true }, gateway: { name: "OpenClaw", url: "ws://127.0.0.1:18789" }, storage: { transcriptSync: "disabled" }, nodeIds: [], startedAt: now - 60_000 },
  };
}
function hubStatus(saved: PublicSettings): CollectorStatus {
  return {
    apiVersion: 1, process: { version: "1", startedAt: saved.runtime.startedAt, ready: true }, host: { ...saved.host, role: "hub" },
    hosts: [{ id: "writer", label: "Writer Mac", reachable: true, syncState: "offline", gatewayConnected: false }],
    epoch: "e", revision: 1, syncState: "live", syncReasons: [], gateway: { name: "", endpoint: "", connected: false, grantedScopes: [] }, sources: [],
  };
}

describe("one-time connection packages", () => {
  it("round trips only the six handoff fields, even if a credential was passed in", () => {
    const encoded = encodeConnectionPackage({ ...connection, token: "long-term-secret", gatewayToken: "gateway-secret" } as ConnectionPackage);
    expect(Object.keys(JSON.parse(encoded))).toEqual(["version", "nodeUrl", "code", "label", "hostId", "expiresAt"]);
    expect(encoded).not.toContain("secret");
    expect(parseConnectionPackage(encoded, now)).toEqual(connection);
  });

  it("rejects pasted credentials, unsupported versions and expired codes before a request can be made", () => {
    expect(() => parseConnectionPackage(JSON.stringify({ ...connection, token: "secret" }), now)).toThrow("未知字段");
    expect(() => parseConnectionPackage(JSON.stringify({ ...connection, version: 2 }), now)).toThrow("版本");
    expect(() => parseConnectionPackage(JSON.stringify({ ...connection, expiresAt: now }), now)).toThrow("过期");
    expect(() => parseConnectionPackage(JSON.stringify({ ...connection, code: "not-a-code" }), now)).toThrow("一次性码");
    expect(() => parseConnectionPackage("not JSON", now)).toThrow("格式");
  });

  it.each([
    "http://0.0.0.0:47123", "http://[::]:47123", "http://127.0.0.1:47123", "http://127.0.0.2:47123", "http://localhost:47123", "http://writer.localhost:47123", "http://[::1]:47123", "http://[::ffff:127.0.0.1]:47123",
    "http://169.254.169.254", "http://[fe80::1]", "http://[::ffff:169.254.169.254]", "http://metadata.google.internal",
    "http://user:password@192.168.1.24:47123", "http://192.168.1.24:47123/?token=secret", "http://192.168.1.24:47123/#token", "http://192.168.1.24:47123/api", "ws://192.168.1.24:47123",
  ])("does not package an unusable or secret-bearing remote address: %s", (url) => {
    expect(() => connectionAddress(url)).toThrow();
  });

  it("uses a concrete address when known, never turns a wildcard into a remote destination", () => {
    expect(suggestedConnectionAddress("0.0.0.0", 47123, "127.0.0.1")).toBe("");
    expect(suggestedConnectionAddress("0.0.0.0", 47123, "192.168.1.24")).toBe("http://192.168.1.24:47123");
    expect(suggestedConnectionAddress("192.168.1.42", 47123, "localhost")).toBe("http://192.168.1.42:47123");
    expect(connectionAddress("https://collector.local/")).toBe("https://collector.local");
  });

  it("counts down to expiry without showing negative time", () => {
    expect(expiryCountdown(now + 599_500, now)).toBe("10:00");
    expect(expiryCountdown(now + 12_000, now)).toBe("00:12");
    expect(expiryCountdown(now - 1, now)).toBe("00:00");
  });
});

describe("saved settings and running configuration", () => {
  it("preserves both as the existing local-only compatibility role", () => {
    expect(intentForRole("both")).toBe("collect");
    expect(roleForIntent("both", "collect")).toBe("both");
    expect(roleForIntent("node", "aggregate")).toBe("hub");
    expect(roleForIntent("hub", "collect")).toBe("node");
    expect(roleForIntent("hub", "collect", "both")).toBe("both");
  });

  it("recognizes machine errors after the API renders underscores as spaces", () => {
    expect(settingsError(new Error("pairing restart required — restart Collector"))).toMatchObject({ message: "配置待重启，应用后再生成连接" });
    expect(settingsError(new Error("pairing_unreachable"))).toMatchObject({ message: "采集机不可达，请检查候选地址" });
    expect(settingsError(new Error("hub nodes required"))).toMatchObject({ message: "请先加入一台采集机" });
    expect(settingsError(new Error("disk write failed"), "采集机已加入；汇总设置尚未保存")).toEqual({ message: "采集机已加入；汇总设置尚未保存", detail: "disk write failed" });
  });

  it("requires the local purpose and actually applied LAN binding before sharing", () => {
    const saved = settings();
    expect(shareReadiness(undefined, "node", false)).toBe("loading");
    expect(shareReadiness(saved, "hub", true)).toBe("purpose");
    expect(shareReadiness(saved, "node", true)).toBe("unsaved");
    saved.restartRequired = true;
    expect(shareReadiness(saved, "node", false)).toBe("restart");
    saved.restartRequired = false;
    saved.runtime.server.lanExposed = false;
    expect(shareReadiness(saved, "node", false)).toBe("network");
    saved.runtime.server.lanExposed = true;
    expect(shareReadiness(saved, "node", false)).toBe("ready");
    saved.runtime.role = "hub";
    expect(shareReadiness(saved, "node", false)).toBe("restart");
  });

  it("does not treat a saved or exchanged node as an online node", () => {
    const saved = settings();
    saved.role = "hub";
    saved.hub.nodes = [{ id: "writer", url: connection.nodeUrl, token: { configured: true } }];
    expect(machineConnectionState(saved, "writer", hubStatus(saved), true)).toBe("pending");
    saved.runtime.role = "hub";
    saved.runtime.nodeIds = ["writer"];
    const status = hubStatus(saved);
    expect(machineConnectionState(saved, "writer", status, true)).toBe("reachable");
    saved.restartRequired = true;
    expect(machineConnectionState(saved, "writer", status, true)).toBe("reachable");
    expect(machineConnectionState(saved, "new-node", status, true)).toBe("pending");
    // HTTP reachability is independent of the Gateway being offline.
    expect(status.hosts?.[0]?.gatewayConnected).toBe(false);
    expect(machineConnectionState(saved, "writer", status, false)).toBe("unknown");
    status.process.startedAt -= 10;
    expect(machineConnectionState(saved, "writer", status, true)).toBe("unknown");
    status.process.startedAt = saved.runtime.startedAt;
    status.hosts = [];
    expect(machineConnectionState(saved, "writer", status, true)).toBe("connecting");
    status.hosts = [{ id: "writer", label: "Writer Mac", reachable: false, syncState: "starting" }];
    expect(machineConnectionState(saved, "writer", status, true)).toBe("unreachable");
    expect(machineConnectionState(saved, "writer", status, true)).toBe("unreachable");
  });
});

describe("first machine claim", () => {
  it("claims a node before saving hub, and retains that node if saving the role fails", async () => {
    const order: string[] = [];
    const joinedSettings = settings();
    joinedSettings.hub.nodes = [{ id: "writer", url: connection.nodeUrl, token: { configured: true } }];
    joinedSettings.restartRequired = true;
    const joined = { ok: true as const, node: { id: "writer", url: connection.nodeUrl, label: "Writer Mac" }, settings: joinedSettings };
    const saveFailure = new Error("disk write failed");
    const client = {
      pairingClaim: vi.fn(async () => { order.push("claim"); return joined; }),
      saveSettings: vi.fn(async () => { order.push("save hub"); throw saveFailure; }),
    };
    const result = await claimAndEnableHub(client, connection, () => { order.push("show joined node"); });
    expect(order).toEqual(["claim", "show joined node", "save hub"]);
    expect(client.pairingClaim).toHaveBeenCalledOnce();
    expect(client.saveSettings).toHaveBeenCalledWith({ role: "hub" });
    expect(result.settings.hub.nodes[0]?.id).toBe("writer");
    expect(result.settings.role).toBe("node");
    expect(result.roleSaveError).toBe(saveFailure);
  });

  it("does not save a hub or emit a joined node when the exchange fails", async () => {
    const client = { pairingClaim: vi.fn(async () => { throw new Error("pairing_unreachable"); }), saveSettings: vi.fn() };
    const onJoined = vi.fn();
    await expect(claimAndEnableHub(client, connection, onJoined)).rejects.toThrow("pairing_unreachable");
    expect(onJoined).not.toHaveBeenCalled();
    expect(client.saveSettings).not.toHaveBeenCalled();
  });
});
