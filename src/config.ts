import { hostname as osHostname } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CollectorRole } from "./contracts.js";
import { isValidHostId } from "./host/ids.js";
import { loadSecrets, secretsPathFor } from "./settings/secrets.js";

export type HubNodeConfig = {
  id: string;
  url: string;
  tokenEnv: string;
  label?: string;
};

export type CollectorConfig = {
  host: {
    id: string;
    label: string;
  };
  role: CollectorRole;
  gateway: {
    name: string;
    url: string;
    tokenEnv: string;
  };
  server: {
    host: string;
    port: number;
    /** Env var holding the shared secret required when binding off loopback. */
    tokenEnv?: string;
  };
  hub: {
    nodes: HubNodeConfig[];
  };
  localSources: {
    /** Observe standalone `claude` / `codex` CLI processes on this machine. */
    standaloneCli: "enabled" | "disabled";
  };
  storage: {
    path: string;
    terminalRetentionDays: number;
    usageRetentionDays: number;
    sessionRetentionDays: number;
    transcriptRetentionDays: number;
    transcriptMaxBytes: number;
    transcriptSync: "enabled" | "disabled";
  };
  reconcile: {
    tasksMs: number;
    sessionsMs: number;
  };
  ui: {
    recentLimit: number;
  };
};

export type ResolvedCollectorConfig = Omit<CollectorConfig, "gateway" | "server" | "hub" | "storage"> & {
  gateway: CollectorConfig["gateway"] & { token: string };
  server: CollectorConfig["server"] & { token?: string };
  hub: {
    nodes: Array<HubNodeConfig & { token: string }>;
  };
  storage: CollectorConfig["storage"] & { path: string };
  configPath: string;
};

const DEFAULTS: CollectorConfig = {
  host: {
    id: "local",
    label: "local",
  },
  role: "node",
  gateway: {
    name: "gateway-local",
    url: "ws://127.0.0.1:18789",
    tokenEnv: "OPENCLAW_GATEWAY_TOKEN",
  },
  server: { host: "127.0.0.1", port: 47123 },
  hub: { nodes: [] },
  localSources: { standaloneCli: "enabled" },
  storage: {
    path: "./data/collector.sqlite",
    terminalRetentionDays: 30,
    usageRetentionDays: 90,
    sessionRetentionDays: 365,
    transcriptRetentionDays: 180,
    transcriptMaxBytes: 2 * 1024 * 1024 * 1024,
    // Archiving whole conversations is opt-in. v1.1 §6 invariant 10 forbids
    // enabling it silently, and a default of "enabled" is exactly that: the
    // operator never asked, and the only disclosure sits on a page they may
    // never open. Everything else in this file only changes how much is kept,
    // not whether conversation text is kept at all.
    transcriptSync: "disabled",
  },
  reconcile: { tasksMs: 15_000, sessionsMs: 8_000 },
  ui: { recentLimit: 200 },
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function numberValue(value: unknown, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export type LoadConfigOptions = {
  /**
   * Skips the Gateway token requirement for commands that never connect.
   * Purging transcripts is a local, offline operation, and an operator doing it
   * after revoking the token should not have to restore the token first.
   */
  requireToken?: boolean;
};

function defaultHostId(): string {
  const raw = osHostname().trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (raw && isValidHostId(raw)) return raw.slice(0, 64);
  return "local";
}

export function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): ResolvedCollectorConfig {
  const absoluteConfigPath = path.resolve(configPath);
  const secrets = loadSecrets(secretsPathFor(absoluteConfigPath));
  const parsed = JSON.parse(readFileSync(absoluteConfigPath, "utf8")) as unknown;
  const root = asRecord(parsed, "config");
  const hostBlock = asRecord(root.host ?? {}, "host");
  const gateway = asRecord(root.gateway ?? {}, "gateway");
  const server = asRecord(root.server ?? {}, "server");
  const hubBlock = asRecord(root.hub ?? {}, "hub");
  const localSources = asRecord(root.localSources ?? {}, "localSources");
  const storage = asRecord(root.storage ?? {}, "storage");
  const reconcile = asRecord(root.reconcile ?? {}, "reconcile");
  const ui = asRecord(root.ui ?? {}, "ui");

  const roleRaw = stringValue(root.role, DEFAULTS.role, "role");
  if (roleRaw !== "node" && roleRaw !== "hub" && roleRaw !== "both") {
    throw new Error('role must be "node", "hub", or "both"');
  }
  const role: CollectorRole = roleRaw;

  const hostId = stringValue(hostBlock.id, defaultHostId(), "host.id");
  if (!isValidHostId(hostId)) {
    throw new Error("host.id must be 1-64 chars of [A-Za-z0-9._-] starting with alphanumeric");
  }
  const hostLabel = stringValue(hostBlock.label, stringValue(gateway.name, hostId, "gateway.name"), "host.label");

  const collectsLocally = role === "node" || role === "both";
  const isHub = role === "hub" || role === "both";

  const tokenEnv = stringValue(gateway.tokenEnv, DEFAULTS.gateway.tokenEnv, "gateway.tokenEnv");
  // Env wins for systemd-style deploys; the Settings UI writes the secrets file.
  const token = env[tokenEnv]?.trim() || secrets.gatewayToken?.trim();
  const requireGatewayToken = options.requireToken !== false && collectsLocally;
  if (!token && requireGatewayToken) {
    throw new Error(
      `Gateway token is missing. Set ${tokenEnv}, or enter it under Settings (stored in ${path.basename(secretsPathFor(absoluteConfigPath))}).`,
    );
  }

  const listenHost = stringValue(server.host, DEFAULTS.server.host, "server.host");
  const serverTokenEnv =
    optionalString(server.tokenEnv, "server.tokenEnv") ??
    (secrets.serverToken || !isLoopbackHost(listenHost) ? "COLLECTOR_NODE_TOKEN" : undefined);
  const serverToken =
    (serverTokenEnv ? env[serverTokenEnv]?.trim() : undefined) || secrets.serverToken?.trim() || undefined;
  if (!isLoopbackHost(listenHost)) {
    if (!serverToken) {
      throw new Error(
        `Server token is missing. Set ${serverTokenEnv ?? "COLLECTOR_NODE_TOKEN"}, or generate a pairing offer under Settings.`,
      );
    }
  }

  // Checked here rather than at the first connection attempt, because a typo
  // otherwise surfaced as an invalid-URL stack from the line that prints the
  // startup banner — with the HTTP server already listening.
  const gatewayUrl = stringValue(gateway.url, DEFAULTS.gateway.url, "gateway.url");
  let gatewayScheme: string;
  try {
    gatewayScheme = new URL(gatewayUrl).protocol;
  } catch {
    throw new Error(`gateway.url is not a URL: ${gatewayUrl}`);
  }
  if (gatewayScheme !== "ws:" && gatewayScheme !== "wss:") {
    throw new Error(`gateway.url must be ws:// or wss://, got ${gatewayScheme}//`);
  }

  const configuredStoragePath = stringValue(storage.path, DEFAULTS.storage.path, "storage.path");
  const terminalRetentionDays = numberValue(
    storage.terminalRetentionDays,
    DEFAULTS.storage.terminalRetentionDays,
    "storage.terminalRetentionDays",
    1,
    365,
  );
  const usageRetentionDays = numberValue(
    storage.usageRetentionDays,
    DEFAULTS.storage.usageRetentionDays,
    "storage.usageRetentionDays",
    1,
    365,
  );
  const sessionRetentionDays = numberValue(
    storage.sessionRetentionDays,
    DEFAULTS.storage.sessionRetentionDays,
    "storage.sessionRetentionDays",
    1,
    3_650,
  );
  if (sessionRetentionDays < terminalRetentionDays) {
    throw new Error("storage.sessionRetentionDays must be >= storage.terminalRetentionDays");
  }
  const transcriptRetentionDays = numberValue(
    storage.transcriptRetentionDays,
    DEFAULTS.storage.transcriptRetentionDays,
    "storage.transcriptRetentionDays",
    1,
    3_650,
  );
  const transcriptMaxBytes = numberValue(
    storage.transcriptMaxBytes,
    DEFAULTS.storage.transcriptMaxBytes,
    "storage.transcriptMaxBytes",
    64 * 1024 * 1024,
    64 * 1024 * 1024 * 1024,
  );
  const transcriptSync = stringValue(
    storage.transcriptSync,
    DEFAULTS.storage.transcriptSync,
    "storage.transcriptSync",
  );
  if (transcriptSync !== "enabled" && transcriptSync !== "disabled") {
    throw new Error('storage.transcriptSync must be "enabled" or "disabled"');
  }

  const standaloneCli = stringValue(
    localSources.standaloneCli,
    DEFAULTS.localSources.standaloneCli,
    "localSources.standaloneCli",
  );
  if (standaloneCli !== "enabled" && standaloneCli !== "disabled") {
    throw new Error('localSources.standaloneCli must be "enabled" or "disabled"');
  }

  const rawNodes = hubBlock.nodes;
  const nodesInput = rawNodes === undefined ? [] : rawNodes;
  if (!Array.isArray(nodesInput)) throw new Error("hub.nodes must be an array");
  if (isHub && nodesInput.length === 0 && role === "hub") {
    throw new Error("hub.nodes must list at least one remote collector when role is hub");
  }

  const nodes: Array<HubNodeConfig & { token: string }> = nodesInput.map((entry, index) => {
    const node = asRecord(entry, `hub.nodes[${index}]`);
    const id = stringValue(node.id, "", `hub.nodes[${index}].id`);
    if (!isValidHostId(id)) {
      throw new Error(`hub.nodes[${index}].id must be a valid host id`);
    }
    const url = stringValue(node.url, "", `hub.nodes[${index}].url`);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`hub.nodes[${index}].url is not a URL: ${url}`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`hub.nodes[${index}].url must be http:// or https://`);
    }
    const nodeTokenEnv = stringValue(node.tokenEnv, "COLLECTOR_NODE_TOKEN", `hub.nodes[${index}].tokenEnv`);
    const nodeToken = env[nodeTokenEnv]?.trim() || secrets.nodeTokens?.[id]?.trim() || "";
    if (options.requireToken !== false && !nodeToken) {
      throw new Error(
        `Hub node token is missing. Set ${nodeTokenEnv} for hub.nodes[${index}] (${id}), or pair the node under Settings.`,
      );
    }
    return {
      id,
      url: parsedUrl.toString().replace(/\/$/, ""),
      tokenEnv: nodeTokenEnv,
      token: nodeToken,
      ...(optionalString(node.label, `hub.nodes[${index}].label`)
        ? { label: optionalString(node.label, `hub.nodes[${index}].label`) }
        : {}),
    };
  });

  const seenNodeIds = new Set<string>();
  for (const node of nodes) {
    if (seenNodeIds.has(node.id)) throw new Error(`hub.nodes has duplicate id ${node.id}`);
    seenNodeIds.add(node.id);
  }

  return {
    host: { id: hostId, label: hostLabel },
    role,
    gateway: {
      name: stringValue(gateway.name, DEFAULTS.gateway.name, "gateway.name"),
      url: gatewayUrl,
      tokenEnv,
      token: token ?? "",
    },
    server: {
      host: listenHost,
      port: numberValue(server.port, DEFAULTS.server.port, "server.port", 1, 65_535),
      ...(serverTokenEnv ? { tokenEnv: serverTokenEnv } : {}),
      ...(serverToken ? { token: serverToken } : {}),
    },
    hub: { nodes },
    localSources: { standaloneCli },
    storage: {
      path: path.resolve(path.dirname(absoluteConfigPath), configuredStoragePath),
      terminalRetentionDays,
      usageRetentionDays,
      sessionRetentionDays,
      transcriptRetentionDays,
      transcriptMaxBytes,
      transcriptSync,
    },
    reconcile: {
      tasksMs: numberValue(reconcile.tasksMs, DEFAULTS.reconcile.tasksMs, "reconcile.tasksMs", 2_000, 300_000),
      sessionsMs: numberValue(
        reconcile.sessionsMs,
        DEFAULTS.reconcile.sessionsMs,
        "reconcile.sessionsMs",
        2_000,
        300_000,
      ),
    },
    ui: {
      recentLimit: numberValue(ui.recentLimit, DEFAULTS.ui.recentLimit, "ui.recentLimit", 0, 500),
    },
    configPath: absoluteConfigPath,
  };
}

/**
 * States whether whole conversations are being stored on this machine.
 *
 * v1.1 §6 invariant 10 requires that archiving never turn on silently. The
 * standing disclosure in the UI does not cover it on its own: the operator who
 * turns this on edits a config file and starts the process from a terminal, so
 * the terminal has to say so too — and say how to undo it.
 */
export function transcriptNotice(config: ResolvedCollectorConfig): string {
  if (config.storage.transcriptSync !== "enabled") {
    return "Transcript archive: off. No conversation text is stored (storage.transcriptSync).\n";
  }
  return [
    "Transcript archive: ON. Full conversation text from this Gateway is stored at",
    `  ${config.storage.path}`,
    `  kept ${config.storage.transcriptRetentionDays} days, up to ${Math.round(config.storage.transcriptMaxBytes / 1024 / 1024)} MiB`,
    "  erase with: openclaw-collector purge-transcripts --yes",
    "",
  ].join("\n");
}

/**
 * The endpoint without anything that could carry a credential.
 *
 * Total by construction: this is what error paths and banners print, so a string
 * that will not parse must come back as a placeholder rather than throw out of
 * the code that was reporting something else.
 */
export function redactEndpoint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "<unparseable endpoint>";
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
