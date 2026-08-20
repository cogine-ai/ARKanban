import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Local secret bag beside the config file.
 *
 * Config JSON only stores env *names* and public fields. Tokens entered in the
 * Settings UI land here so they never appear in snapshot APIs or committed
 * config examples. Mode is narrowed to the owner when the filesystem allows it.
 */

export type CollectorSecrets = {
  gatewayToken?: string;
  serverToken?: string;
  /** Shared secrets for remote nodes, keyed by host id. */
  nodeTokens?: Record<string, string>;
};

export function secretsPathFor(configPath: string): string {
  const directory = path.dirname(path.resolve(configPath));
  const base = path.basename(configPath, path.extname(configPath));
  return path.join(directory, `${base}.secrets.json`);
}

export function loadSecrets(secretsPath: string): CollectorSecrets {
  if (!existsSync(secretsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(secretsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const root = parsed as Record<string, unknown>;
    const nodeTokensRaw = root.nodeTokens;
    const nodeTokens =
      nodeTokensRaw && typeof nodeTokensRaw === "object" && !Array.isArray(nodeTokensRaw)
        ? Object.fromEntries(
            Object.entries(nodeTokensRaw as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
            ),
          )
        : undefined;
    return {
      ...(typeof root.gatewayToken === "string" && root.gatewayToken ? { gatewayToken: root.gatewayToken } : {}),
      ...(typeof root.serverToken === "string" && root.serverToken ? { serverToken: root.serverToken } : {}),
      ...(nodeTokens && Object.keys(nodeTokens).length > 0 ? { nodeTokens } : {}),
    };
  } catch {
    return {};
  }
}

export function saveSecrets(secretsPath: string, secrets: CollectorSecrets): void {
  const directory = path.dirname(secretsPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payload: CollectorSecrets = {};
  if (secrets.gatewayToken) payload.gatewayToken = secrets.gatewayToken;
  if (secrets.serverToken) payload.serverToken = secrets.serverToken;
  if (secrets.nodeTokens && Object.keys(secrets.nodeTokens).length > 0) {
    payload.nodeTokens = { ...secrets.nodeTokens };
  }
  const tempPath = path.join(
    directory,
    `.${path.basename(secretsPath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // Some volumes refuse chmod; the file still exists for this user.
  }
  renameSync(tempPath, secretsPath);
  try {
    chmodSync(secretsPath, 0o600);
  } catch {
    // Same as above: the atomic replace already landed.
  }
}

export function maskSecret(value: string | undefined): { configured: boolean; hint?: string } {
  if (!value) return { configured: false };
  if (value.length <= 4) return { configured: true, hint: "••••" };
  return { configured: true, hint: `••••${value.slice(-4)}` };
}
