/**
 * Pairing is for LAN collector nodes. The hub process must not be turned into
 * a fetch proxy for link-local / cloud-metadata addresses.
 *
 * Private RFC1918 addresses stay allowed: that is the intended deployment.
 */
export function parsePairableNodeUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("invalid_node_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid_node_url");
  }
  if (isBlockedPairingHost(parsed.hostname)) {
    throw new Error("invalid_node_url");
  }
  return parsed;
}

export function isBlockedPairingHost(hostname: string): boolean {
  const target = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (target === "metadata.google.internal") return true;
  if (isIpv4LinkLocal(target)) return true;
  if (isIpv6LinkLocal(target)) return true;
  return false;
}

function isIpv4LinkLocal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 169 && octets[1] === 254;
}

function isIpv4MappedLinkLocal(host: string): boolean {
  const dotted = host.match(/^(?:(?:0:){5}|::)ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted?.[1]) return isIpv4LinkLocal(dotted[1]);

  const hex = host.match(/^(?:(?:0:){5}|::)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex?.[1]) return false;
  const high = Number.parseInt(hex[1], 16);
  return ((high >> 8) & 0xff) === 169 && (high & 0xff) === 254;
}

function isIpv6LinkLocal(host: string): boolean {
  if (!host.includes(":")) return false;
  if (isIpv4MappedLinkLocal(host)) return true;
  const first = host.split(":")[0]?.toLowerCase() ?? "";
  if (!first) return false;
  const hextet = first.padStart(4, "0");
  return hextet >= "fe80" && hextet <= "febf";
}
