import { readFileSync, writeFileSync } from "node:fs";
import type { CollectorRole } from "../contracts.js";
import { isValidHostId } from "../host/ids.js";
import { isLoopbackHost, type ResolvedCollectorConfig } from "../config.js";
import { generateSharedToken, peekPairingOffer } from "./pairing.js";
import { loadSecrets, maskSecret, saveSecrets, secretsPathFor, type CollectorSecrets } from "./secrets.js";

export type PublicSecretState = {
  configured: boolean;
  hint?: string;
};

export type PublicHubNode = {
  id: string;
  url: string;
  label?: string;
  token: PublicSecretState;
};

export type PublicSettings = {
  host: { id: string; label: string };
  role: CollectorRole;
  gateway: {
    name: string;
    url: string;
    token: PublicSecretState;
  };
  server: {
    host: string;
    port: number;
    lanExposed: boolean;
    token: PublicSecretState;
  };
  hub: { nodes: PublicHubNode[] };
  localSources: { standaloneCli: "enabled" | "disabled" };
  pairing: {
    active?: { code: string; expiresAt: number; hostId: string; label: string };
  };
  paths: {
    config: string;
    secrets: string;
  };
  restartRequired: boolean;
};

export type SettingsPatch = {
  host?: { id?: string; label?: string };
  role?: CollectorRole;
  gateway?: { name?: string; url?: string; token?: string | null };
  server?: { host?: string; port?: number; token?: string | null };
  hub?: {
    nodes?: Array<{ id: string; url: string; label?: string; token?: string | null }>;
  };
  localSources?: { standaloneCli?: "enabled" | "disabled" };
};

export type SettingsService = {
  getPublicSettings(): PublicSettings;
  applyPatch(patch: SettingsPatch): PublicSettings;
  ensureServerToken(): { token: string; created: boolean };
  setNodeToken(hostId: string, token: string): void;
  addHubNode(node: { id: string; url: string; label?: string; token: string }): PublicSettings;
  markRestartRequired(): void;
};

function readRawConfig(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function writeRawConfig(configPath: string, root: Record<string, unknown>): void {
  writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

let restartRequired = false;

/** Test helper: clear the process-local restart flag between cases. */
export function resetSettingsRestartFlag(): void {
  restartRequired = false;
}

export function createSettingsService(config: ResolvedCollectorConfig): SettingsService {
  const configPath = config.configPath;
  const secretsPath = secretsPathFor(configPath);

  const readSecrets = (): CollectorSecrets => loadSecrets(secretsPath);

  const getPublicSettings = (): PublicSettings => {
    const secrets = readSecrets();
    const offer = peekPairingOffer();
    return {
      host: { id: config.host.id, label: config.host.label },
      role: config.role,
      gateway: {
        name: config.gateway.name,
        url: config.gateway.url,
        token: maskSecret(config.gateway.token || secrets.gatewayToken),
      },
      server: {
        host: config.server.host,
        port: config.server.port,
        lanExposed: !isLoopbackHost(config.server.host),
        token: maskSecret(config.server.token || secrets.serverToken),
      },
      hub: {
        nodes: config.hub.nodes.map((node) => ({
          id: node.id,
          url: node.url,
          ...(node.label ? { label: node.label } : {}),
          token: maskSecret(node.token || secrets.nodeTokens?.[node.id]),
        })),
      },
      localSources: { standaloneCli: config.localSources.standaloneCli },
      pairing: {
        ...(offer
          ? {
              active: {
                code: offer.code,
                expiresAt: offer.expiresAt,
                hostId: offer.hostId,
                label: offer.label,
              },
            }
          : {}),
      },
      paths: {
        config: configPath,
        secrets: secretsPath,
      },
      restartRequired,
    };
  };

  const ensureServerToken = (): { token: string; created: boolean } => {
    const secrets = readSecrets();
    if (config.server.token) return { token: config.server.token, created: false };
    if (secrets.serverToken) {
      config.server.token = secrets.serverToken;
      return { token: secrets.serverToken, created: false };
    }
    const token = generateSharedToken();
    saveSecrets(secretsPath, { ...secrets, serverToken: token });
    const root = readRawConfig(configPath);
    const server = (root.server && typeof root.server === "object" ? root.server : {}) as Record<string, unknown>;
    server.tokenEnv = server.tokenEnv ?? "COLLECTOR_NODE_TOKEN";
    root.server = server;
    writeRawConfig(configPath, root);
    config.server.token = token;
    config.server.tokenEnv = String(server.tokenEnv);
    restartRequired = true;
    return { token, created: true };
  };

  const setNodeToken = (hostId: string, token: string): void => {
    const secrets = readSecrets();
    saveSecrets(secretsPath, {
      ...secrets,
      nodeTokens: { ...secrets.nodeTokens, [hostId]: token },
    });
  };

  const addHubNode = (node: { id: string; url: string; label?: string; token: string }): PublicSettings => {
    if (!isValidHostId(node.id)) throw new Error("invalid_host_id");
    let parsed: URL;
    try {
      parsed = new URL(node.url);
    } catch {
      throw new Error("invalid_node_url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid_node_url");

    setNodeToken(node.id, node.token);
    const root = readRawConfig(configPath);
    const hub = (root.hub && typeof root.hub === "object" ? root.hub : {}) as Record<string, unknown>;
    const nodes = Array.isArray(hub.nodes) ? [...hub.nodes] : [];
    const next = {
      id: node.id,
      url: parsed.toString().replace(/\/$/, ""),
      tokenEnv: `COLLECTOR_NODE_TOKEN_${node.id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`,
      ...(node.label ? { label: node.label } : {}),
    };
    const index = nodes.findIndex(
      (entry) => entry && typeof entry === "object" && (entry as { id?: string }).id === node.id,
    );
    if (index >= 0) nodes[index] = next;
    else nodes.push(next);
    hub.nodes = nodes;
    root.hub = hub;
    if (config.role === "node") root.role = "both";
    writeRawConfig(configPath, root);

    const existing = config.hub.nodes.find((candidate) => candidate.id === node.id);
    if (existing) {
      existing.url = next.url;
      existing.token = node.token;
      existing.tokenEnv = next.tokenEnv;
      if (node.label) existing.label = node.label;
    } else {
      config.hub.nodes.push({
        id: node.id,
        url: next.url,
        tokenEnv: next.tokenEnv,
        token: node.token,
        ...(node.label ? { label: node.label } : {}),
      });
    }
    if (config.role === "node") config.role = "both";
    restartRequired = true;
    return getPublicSettings();
  };

  const applyPatch = (patch: SettingsPatch): PublicSettings => {
    const root = readRawConfig(configPath);
    const secrets = readSecrets();
    let secretsChanged = false;
    const nextSecrets: CollectorSecrets = { ...secrets, nodeTokens: { ...secrets.nodeTokens } };

    if (patch.host) {
      const host = (root.host && typeof root.host === "object" ? root.host : {}) as Record<string, unknown>;
      if (patch.host.id !== undefined) {
        if (!isValidHostId(patch.host.id)) throw new Error("invalid_host_id");
        host.id = patch.host.id;
        config.host.id = patch.host.id;
      }
      if (patch.host.label !== undefined) {
        if (!patch.host.label.trim()) throw new Error("invalid_host_label");
        host.label = patch.host.label.trim();
        config.host.label = host.label as string;
      }
      root.host = host;
    }

    if (patch.role !== undefined) {
      if (patch.role !== "node" && patch.role !== "hub" && patch.role !== "both") throw new Error("invalid_role");
      root.role = patch.role;
      config.role = patch.role;
    }

    if (patch.gateway) {
      const gateway = (root.gateway && typeof root.gateway === "object" ? root.gateway : {}) as Record<string, unknown>;
      if (patch.gateway.name !== undefined) {
        if (!patch.gateway.name.trim()) throw new Error("invalid_gateway_name");
        gateway.name = patch.gateway.name.trim();
        config.gateway.name = gateway.name as string;
      }
      if (patch.gateway.url !== undefined) {
        let parsed: URL;
        try {
          parsed = new URL(patch.gateway.url);
        } catch {
          throw new Error("invalid_gateway_url");
        }
        if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("invalid_gateway_url");
        gateway.url = parsed.toString();
        config.gateway.url = gateway.url as string;
      }
      if (patch.gateway.token !== undefined) {
        if (patch.gateway.token === null || patch.gateway.token === "") {
          delete nextSecrets.gatewayToken;
          config.gateway.token = "";
        } else {
          nextSecrets.gatewayToken = patch.gateway.token;
          config.gateway.token = patch.gateway.token;
        }
        secretsChanged = true;
        gateway.tokenEnv = gateway.tokenEnv ?? "OPENCLAW_GATEWAY_TOKEN";
      }
      root.gateway = gateway;
    }

    if (patch.server) {
      const server = (root.server && typeof root.server === "object" ? root.server : {}) as Record<string, unknown>;
      if (patch.server.host !== undefined) {
        if (!patch.server.host.trim()) throw new Error("invalid_server_host");
        server.host = patch.server.host.trim();
        config.server.host = server.host as string;
        if (!isLoopbackHost(config.server.host)) {
          server.tokenEnv = server.tokenEnv ?? "COLLECTOR_NODE_TOKEN";
          config.server.tokenEnv = String(server.tokenEnv);
          if (!config.server.token && !nextSecrets.serverToken) {
            nextSecrets.serverToken = generateSharedToken();
            config.server.token = nextSecrets.serverToken;
            secretsChanged = true;
          }
        }
      }
      if (patch.server.port !== undefined) {
        if (!Number.isInteger(patch.server.port) || patch.server.port < 1 || patch.server.port > 65_535) {
          throw new Error("invalid_server_port");
        }
        server.port = patch.server.port;
        config.server.port = patch.server.port;
      }
      if (patch.server.token !== undefined) {
        if (patch.server.token === null || patch.server.token === "") {
          delete nextSecrets.serverToken;
          config.server.token = undefined;
        } else {
          nextSecrets.serverToken = patch.server.token;
          config.server.token = patch.server.token;
        }
        secretsChanged = true;
        server.tokenEnv = server.tokenEnv ?? "COLLECTOR_NODE_TOKEN";
        config.server.tokenEnv = String(server.tokenEnv);
      }
      root.server = server;
    }

    if (patch.localSources?.standaloneCli !== undefined) {
      const value = patch.localSources.standaloneCli;
      if (value !== "enabled" && value !== "disabled") throw new Error("invalid_standalone_cli");
      const localSources = (root.localSources && typeof root.localSources === "object" ? root.localSources : {}) as Record<
        string,
        unknown
      >;
      localSources.standaloneCli = value;
      root.localSources = localSources;
      config.localSources.standaloneCli = value;
    }

    if (patch.hub?.nodes !== undefined) {
      const hub = (root.hub && typeof root.hub === "object" ? root.hub : {}) as Record<string, unknown>;
      const nodes = [];
      const resolved = [];
      for (const node of patch.hub.nodes) {
        if (!isValidHostId(node.id)) throw new Error("invalid_host_id");
        let parsed: URL;
        try {
          parsed = new URL(node.url);
        } catch {
          throw new Error("invalid_node_url");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid_node_url");
        const tokenEnv = `COLLECTOR_NODE_TOKEN_${node.id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
        nodes.push({
          id: node.id,
          url: parsed.toString().replace(/\/$/, ""),
          tokenEnv,
          ...(node.label ? { label: node.label } : {}),
        });
        if (node.token !== undefined) {
          if (node.token === null || node.token === "") {
            if (nextSecrets.nodeTokens) delete nextSecrets.nodeTokens[node.id];
          } else {
            nextSecrets.nodeTokens = { ...nextSecrets.nodeTokens, [node.id]: node.token };
          }
          secretsChanged = true;
        }
        resolved.push({
          id: node.id,
          url: parsed.toString().replace(/\/$/, ""),
          tokenEnv,
          token: (typeof node.token === "string" && node.token) || nextSecrets.nodeTokens?.[node.id] || "",
          ...(node.label ? { label: node.label } : {}),
        });
      }
      hub.nodes = nodes;
      root.hub = hub;
      config.hub.nodes = resolved;
    }

    writeRawConfig(configPath, root);
    if (secretsChanged) saveSecrets(secretsPath, nextSecrets);
    restartRequired = true;
    return getPublicSettings();
  };

  return {
    getPublicSettings,
    applyPatch,
    ensureServerToken,
    setNodeToken,
    addHubNode,
    markRestartRequired: () => {
      restartRequired = true;
    },
  };
}
