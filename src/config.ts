import { readFileSync } from "node:fs";
import path from "node:path";

export type CollectorConfig = {
  gateway: {
    name: string;
    url: string;
    tokenEnv: string;
  };
  server: {
    host: "127.0.0.1" | "::1";
    port: number;
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

export type ResolvedCollectorConfig = CollectorConfig & {
  gateway: CollectorConfig["gateway"] & { token: string };
  storage: CollectorConfig["storage"] & { path: string };
  configPath: string;
};

const DEFAULTS: CollectorConfig = {
  gateway: {
    name: "gateway-local",
    url: "ws://127.0.0.1:18789",
    tokenEnv: "OPENCLAW_GATEWAY_TOKEN",
  },
  server: { host: "127.0.0.1", port: 47123 },
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

export type LoadConfigOptions = {
  /**
   * Skips the Gateway token requirement for commands that never connect.
   * Purging transcripts is a local, offline operation, and an operator doing it
   * after revoking the token should not have to restore the token first.
   */
  requireToken?: boolean;
};

export function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): ResolvedCollectorConfig {
  const absoluteConfigPath = path.resolve(configPath);
  const parsed = JSON.parse(readFileSync(absoluteConfigPath, "utf8")) as unknown;
  const root = asRecord(parsed, "config");
  const gateway = asRecord(root.gateway ?? {}, "gateway");
  const server = asRecord(root.server ?? {}, "server");
  const storage = asRecord(root.storage ?? {}, "storage");
  const reconcile = asRecord(root.reconcile ?? {}, "reconcile");
  const ui = asRecord(root.ui ?? {}, "ui");

  const tokenEnv = stringValue(gateway.tokenEnv, DEFAULTS.gateway.tokenEnv, "gateway.tokenEnv");
  const token = env[tokenEnv]?.trim();
  if (!token && options.requireToken !== false) {
    throw new Error(`Gateway token is missing. Set ${tokenEnv} before starting Collector.`);
  }

  const host = stringValue(server.host, DEFAULTS.server.host, "server.host");
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("server.host must be loopback (127.0.0.1 or ::1)");

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

  return {
    gateway: {
      name: stringValue(gateway.name, DEFAULTS.gateway.name, "gateway.name"),
      url: stringValue(gateway.url, DEFAULTS.gateway.url, "gateway.url"),
      tokenEnv,
      token: token ?? "",
    },
    server: {
      host,
      port: numberValue(server.port, DEFAULTS.server.port, "server.port", 1, 65_535),
    },
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

export function redactEndpoint(url: string): string {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
