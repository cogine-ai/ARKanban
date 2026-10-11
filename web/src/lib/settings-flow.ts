import type { CollectorStatus } from "../../../src/contracts";
import type { PublicSettings } from "../api";

export type MachineIntent = "collect" | "aggregate";
export type ConnectionPackage = {
  version: 1;
  nodeUrl: string;
  code: string;
  label: string;
  hostId: string;
  expiresAt: number;
};

export function intentForRole(role: PublicSettings["role"]): MachineIntent {
  return role === "hub" ? "aggregate" : "collect";
}

/** Keep an existing both configuration until the operator explicitly changes it. */
export function roleForIntent(role: PublicSettings["role"], intent: MachineIntent, savedRole?: PublicSettings["role"]): PublicSettings["role"] {
  return intent === "aggregate" ? "hub" : role === "both" || (role === "hub" && savedRole === "both") ? "both" : "node";
}

export function settingsError(cause: unknown, prefix?: string): { message: string; detail: string } {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const messages: Record<string, string> = {
    pairing_restart_required: "配置待重启，应用后再生成连接",
    pairing_requires_lan: "请先保存局域网访问设置并重启",
    pairing_requires_node: "只有采集用途可以分享本机",
    pairing_unreachable: "采集机不可达，请检查候选地址",
    pairing_redeem_failed: "一次性码兑换失败，请在采集机生成新连接",
    pairing_redeem_malformed: "采集机返回了无法识别的连接",
    pairing_save_failed: "连接未能保存，请在采集机生成新连接后重试",
    hub_nodes_required: "请先加入一台采集机",
    invalid_node_url: "连接地址无法使用",
  };
  // readError preserves hints but makes machine error codes readable first.
  const known = Object.keys(messages).find((code) => detail.includes(code) || detail.includes(code.replaceAll("_", " ")));
  return { message: prefix ?? (known ? messages[known]! : "操作未完成，请查看错误详情"), detail };
}

function hostText(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function isLocalAddress(hostname: string): boolean {
  const host = hostText(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)
    || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host);
}

/** A candidate collector origin, never a listen-all address or a secret-bearing URL. */
export function connectionAddress(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("请输入 http:// 或 https:// 连接地址");
  }
  const host = hostText(url.hostname);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("连接地址须使用 http:// 或 https://");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("连接地址只能包含主机和端口");
  }
  if (host === "0.0.0.0" || host === "::" || /^::ffff:0:0$/.test(host)) {
    throw new Error("0.0.0.0 / :: 是监听地址，请填写本机局域网地址");
  }
  if (isLocalAddress(host)) throw new Error("请填写另一台机器可访问的地址，不能使用本地回环地址");
  if (host === "metadata.google.internal" || /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
    || /^::ffff:(?:169\.254\.|a9fe:)/.test(host)) {
    throw new Error("此地址不能用于机器配对");
  }
  return url.origin;
}

export function suggestedConnectionAddress(host: string, port: number, browserHostname: string): string {
  for (const candidate of [host, browserHostname]) {
    const hostname = candidate.includes(":") && !candidate.startsWith("[") ? `[${candidate}]` : candidate;
    try {
      return connectionAddress(`http://${hostname}:${port}`);
    } catch {
      // A wildcard or loopback address cannot be offered as a remote destination.
    }
  }
  return "";
}

/** Serialize a whitelist so credential fields can never enter the clipboard. */
export function encodeConnectionPackage(value: ConnectionPackage): string {
  return JSON.stringify({
    version: 1,
    nodeUrl: connectionAddress(value.nodeUrl),
    code: value.code,
    label: value.label,
    hostId: value.hostId,
    expiresAt: value.expiresAt,
  });
}

export function parseConnectionPackage(raw: string, now: number): ConnectionPackage {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error("连接包格式无法识别，请重新复制连接");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("连接包格式无法识别");
  const data = value as Record<string, unknown>;
  if (data.version !== 1) throw new Error("连接包版本不受支持");
  const allowed = new Set(["version", "nodeUrl", "code", "label", "hostId", "expiresAt"]);
  if (Object.keys(data).some((key) => !allowed.has(key))) throw new Error("连接包包含未知字段，请重新复制连接");
  if (typeof data.nodeUrl !== "string" || typeof data.code !== "string" || typeof data.label !== "string"
    || typeof data.hostId !== "string" || typeof data.expiresAt !== "number") {
    throw new Error("连接包缺少设备、地址或一次性码");
  }
  if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(data.code.trim().toUpperCase())) {
    throw new Error("一次性码格式无法识别");
  }
  if (!data.label.trim() || !data.hostId.trim() || data.label.length > 200 || data.hostId.length > 200) {
    throw new Error("连接包的设备身份无法识别");
  }
  if (!Number.isFinite(data.expiresAt) || data.expiresAt <= now) throw new Error("连接已过期，请在采集机生成新连接");
  return {
    version: 1,
    nodeUrl: connectionAddress(data.nodeUrl),
    code: data.code.trim().toUpperCase(),
    label: data.label.trim(),
    hostId: data.hostId.trim(),
    expiresAt: data.expiresAt,
  };
}

export type ShareReadiness = "loading" | "purpose" | "unsaved" | "restart" | "network" | "ready";
export function shareReadiness(settings: PublicSettings | undefined, draftRole: PublicSettings["role"], dirty: boolean): ShareReadiness {
  if (!settings?.runtime) return "loading";
  if (draftRole === "hub") return "purpose";
  if (dirty) return "unsaved";
  if (settings.restartRequired || settings.runtime.role === "hub") return "restart";
  if (!settings.runtime.server.lanExposed) return "network";
  return "ready";
}

export type MachineConnectionState = "pending" | "connecting" | "reachable" | "unreachable" | "unknown";
export function machineConnectionState(settings: PublicSettings, nodeId: string, status: CollectorStatus | undefined, fresh: boolean): MachineConnectionState {
  // Pending changes do not erase live evidence for a node already in this process.
  if (!settings.runtime || settings.runtime.role !== "hub" || !settings.runtime.nodeIds.includes(nodeId)) return "pending";
  if (!fresh || !status || status.process.startedAt !== settings.runtime.startedAt) return "unknown";
  const observed = status.hosts?.find((host) => host.id === nodeId);
  if (!observed) return "connecting";
  return observed.reachable ? "reachable" : "unreachable";
}

export function expiryCountdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

type ClaimResult = { ok: true; node: { id: string; url: string; label: string }; settings: PublicSettings };
type PairingClient = {
  pairingClaim: (body: { code: string; nodeUrl: string }) => Promise<ClaimResult>;
  saveSettings: (patch: unknown) => Promise<PublicSettings>;
};

/** The redeemed node is retained even when the following role save fails. */
export async function claimAndEnableHub(client: PairingClient, connection: ConnectionPackage, onJoined: (result: ClaimResult) => void) {
  const joined = await client.pairingClaim({ code: connection.code, nodeUrl: connection.nodeUrl });
  onJoined(joined);
  try {
    return { joined, settings: await client.saveSettings({ role: "hub" }), roleSaveError: undefined };
  } catch (roleSaveError) {
    return { joined, settings: joined.settings, roleSaveError };
  }
}
