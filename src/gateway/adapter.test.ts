import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RawGatewayClient } from "./adapter.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("RawGatewayClient", () => {
  it("performs the protocol-v4 challenge handshake with read-only scope and detects event gaps", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock gateway did not bind TCP");
    const connectParams: Array<Record<string, unknown>> = [];
    let socket: import("ws").WebSocket | undefined;
    server.on("connection", (connected) => {
      socket = connected;
      connected.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test", ts: Date.now() } }));
      connected.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as { id: string; method: string; params?: Record<string, unknown> };
        if (request.method === "connect") {
          connectParams.push(request.params ?? {});
          connected.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload: { type: "hello-ok", protocol: 4, server: { version: "test", connId: "one" }, features: { methods: ["echo"], events: ["agent"] }, snapshot: {}, auth: { role: "operator", scopes: ["operator.read"] }, policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 } } }));
        } else if (request.method === "echo") {
          connected.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload: request.params }));
        }
      });
    });
    const onGap = vi.fn();
    const client = new RawGatewayClient({ url: `ws://127.0.0.1:${address.port}`, token: "read-token", onGap });
    cleanups.push(async () => {
      client.stop();
      for (const connected of server.clients) connected.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    client.start();
    await client.waitUntilConnected();

    expect(connectParams[0]).toMatchObject({ minProtocol: 4, maxProtocol: 4, role: "operator", scopes: ["operator.read"], auth: { token: "read-token" } });
    await expect(client.request("echo", { ok: true })).resolves.toEqual({ ok: true });
    socket?.send(JSON.stringify({ type: "event", event: "agent", seq: 1, payload: {} }));
    socket?.send(JSON.stringify({ type: "event", event: "agent", seq: 3, payload: {} }));
    await vi.waitFor(() => expect(onGap).toHaveBeenCalledWith({ expected: 2, received: 3 }));
  });
});
