import { describe, expect, it } from "vitest";
import { isBlockedPairingHost, parsePairableNodeUrl } from "./node-url.js";

describe("pairable node URLs", () => {
  it("accepts LAN and loopback http(s) targets", () => {
    expect(parsePairableNodeUrl("http://192.168.1.10:47123").host).toBe("192.168.1.10:47123");
    expect(parsePairableNodeUrl("http://10.0.0.4").hostname).toBe("10.0.0.4");
    expect(parsePairableNodeUrl("https://127.0.0.1:47123").hostname).toBe("127.0.0.1");
  });

  it("rejects link-local and cloud metadata hosts", () => {
    expect(isBlockedPairingHost("169.254.169.254")).toBe(true);
    expect(isBlockedPairingHost("metadata.google.internal")).toBe(true);
    expect(isBlockedPairingHost("fe80::1")).toBe(true);
    expect(() => parsePairableNodeUrl("http://169.254.169.254/")).toThrow("invalid_node_url");
    expect(() => parsePairableNodeUrl("file:///etc/passwd")).toThrow("invalid_node_url");
  });
});
