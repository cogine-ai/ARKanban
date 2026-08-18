import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, redactEndpoint } from "./config.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Writes a config file containing `gateway`, and returns its path. */
function configWith(gateway: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-config-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "collector.config.json");
  writeFileSync(configPath, JSON.stringify({ gateway, storage: { path: path.join(directory, "c.sqlite") } }));
  return configPath;
}

const env = { OPENCLAW_GATEWAY_TOKEN: "t" };

describe("gateway endpoint validation", () => {
  /**
   * The banner printed after the server is already listening is what parses this
   * URL, so an unchecked typo took the process down with an invalid-URL stack
   * from a line that has nothing to do with the mistake.
   */
  it("names the setting when the endpoint is not a URL", () => {
    expect(() => loadConfig(configWith({ url: "ws://[::1" }), env)).toThrow(/gateway\.url is not a URL/);
  });

  it("rejects a scheme the Gateway does not speak", () => {
    expect(() => loadConfig(configWith({ url: "http://127.0.0.1:8787" }), env)).toThrow(/ws:\/\/ or wss:\/\//);
  });

  /**
   * A host written without a scheme. Which branch catches it depends on the host:
   * `localhost:8787` parses as a URL whose scheme is `localhost:`, while
   * `127.0.0.1:8787` does not parse at all. Both must name the setting.
   */
  it("rejects an endpoint written without a scheme", () => {
    expect(() => loadConfig(configWith({ url: "localhost:8787" }), env)).toThrow(/gateway\.url/);
    expect(() => loadConfig(configWith({ url: "127.0.0.1:8787" }), env)).toThrow(/gateway\.url/);
  });

  it("accepts both websocket schemes", () => {
    expect(loadConfig(configWith({ url: "ws://127.0.0.1:8787" }), env).gateway.url).toBe("ws://127.0.0.1:8787");
    expect(loadConfig(configWith({ url: "wss://gateway.internal/rpc" }), env).gateway.url).toBe(
      "wss://gateway.internal/rpc",
    );
  });
});

describe("endpoint redaction", () => {
  it("drops anything that could carry a credential", () => {
    expect(redactEndpoint("ws://operator:hunter2@127.0.0.1:8787/rpc?token=abc#frag")).toBe("ws://127.0.0.1:8787/rpc");
  });

  /** Printed by error paths, so it reports the failure it was given, not a new one. */
  it("returns a placeholder rather than throwing on a string it cannot parse", () => {
    expect(redactEndpoint("not a url")).toBe("<unparseable endpoint>");
  });
});
