import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewayHello = {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features: { methods: string[]; events: string[]; capabilities?: string[] };
  auth?: { role?: string; scopes?: string[] };
};

export type GatewayConnectionState =
  | { state: "connecting" }
  | { state: "connected"; hello: GatewayHello; connectedAt: number }
  | { state: "disconnected"; at: number; code?: number; reason?: string }
  | { state: "unauthorized"; at: number; message: string }
  | { state: "incompatible"; at: number; message: string }
  | { state: "error"; at: number; message: string };

export type GatewayClientOptions = {
  url: string;
  token: string;
  onEvent?: (event: GatewayEventFrame) => void | Promise<void>;
  onState?: (state: GatewayConnectionState) => void;
  onGap?: (gap: { expected: number; received: number }) => void;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
};

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseFrame(data: RawData): GatewayEventFrame | GatewayResponseFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type === "event" && typeof record.event === "string") return record as GatewayEventFrame;
  if (record.type === "res" && typeof record.id === "string" && typeof record.ok === "boolean") {
    return record as GatewayResponseFrame;
  }
  return undefined;
}

export class RawGatewayClient {
  private socket?: WebSocket;
  private readonly pending = new Map<string, PendingRequest>();
  private reconnectTimer?: NodeJS.Timeout;
  private challengeTimer?: NodeJS.Timeout;
  private stopped = true;
  private connected = false;
  private reconnectAttempt = 0;
  private lastSeq?: number;
  private hello?: GatewayHello;
  private helloWaiters = new Set<{ resolve: (hello: GatewayHello) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly options: GatewayClientOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get currentHello(): GatewayHello | undefined {
    return this.hello;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.reconnectTimer = undefined;
    this.challengeTimer = undefined;
    this.connected = false;
    this.socket?.close(1000, "collector stopping");
    this.socket = undefined;
    this.rejectPending(new Error("Gateway client stopped"));
    this.rejectHelloWaiters(new Error("Gateway client stopped"));
  }

  async waitUntilConnected(timeoutMs = 10_000): Promise<GatewayHello> {
    if (this.hello && this.connected) return this.hello;
    return await new Promise<GatewayHello>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.helloWaiters.delete(waiter);
          reject(new Error(`Gateway connection timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.helloWaiters.add(waiter);
    });
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.connected) throw new Error(`Gateway is not connected; cannot call ${method}`);
    return (await this.sendRequest(method, params, timeoutMs)) as T;
  }

  private open(): void {
    if (this.stopped) return;
    this.options.onState?.({ state: "connecting" });
    const socket = new WebSocket(this.options.url, {
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 10_000,
    });
    this.socket = socket;
    this.connected = false;
    this.hello = undefined;
    this.lastSeq = undefined;

    socket.on("open", () => {
      if (socket !== this.socket) return;
      this.challengeTimer = setTimeout(() => {
        if (socket === this.socket && !this.connected) socket.close(1008, "connect challenge timeout");
      }, 10_000);
    });
    socket.on("message", (data) => this.handleFrame(socket, data));
    socket.on("error", (error) => {
      if (socket !== this.socket || this.stopped) return;
      this.options.onState?.({ state: "error", at: Date.now(), message: errorMessage(error) });
    });
    socket.on("close", (code, reasonBuffer) => {
      if (socket !== this.socket) return;
      if (this.challengeTimer) clearTimeout(this.challengeTimer);
      this.challengeTimer = undefined;
      this.socket = undefined;
      this.connected = false;
      this.hello = undefined;
      this.rejectPending(new Error(`Gateway connection closed (${code})`));
      if (this.stopped) return;
      const reason = reasonBuffer.toString() || undefined;
      this.options.onState?.({
        state: "disconnected",
        at: Date.now(),
        ...(code ? { code } : {}),
        ...(reason ? { reason } : {}),
      });
      this.scheduleReconnect();
    });
  }

  private handleFrame(socket: WebSocket, data: RawData): void {
    if (socket !== this.socket) return;
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.payload);
      else {
        const code = frame.error?.code ?? "gateway_error";
        pending.reject(new Error(`${code}: ${frame.error?.message ?? "Gateway request failed"}`));
      }
      return;
    }

    if (frame.event === "connect.challenge") {
      const payload = frame.payload && typeof frame.payload === "object" ? (frame.payload as Record<string, unknown>) : {};
      const nonce = typeof payload.nonce === "string" ? payload.nonce.trim() : "";
      if (!nonce) {
        socket.close(1008, "connect challenge missing nonce");
        return;
      }
      void this.connect(socket, nonce);
      return;
    }

    if (typeof frame.seq === "number") {
      if (this.lastSeq !== undefined && frame.seq > this.lastSeq + 1) {
        this.options.onGap?.({ expected: this.lastSeq + 1, received: frame.seq });
      }
      this.lastSeq = frame.seq;
    }
    void Promise.resolve(this.options.onEvent?.(frame)).catch((error) => {
      this.options.onState?.({ state: "error", at: Date.now(), message: `Event handler: ${errorMessage(error)}` });
    });
  }

  private async connect(socket: WebSocket, _nonce: string): Promise<void> {
    try {
      const hello = (await this.sendRequest(
        "connect",
        {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "gateway-client",
            displayName: "OpenClaw Collector",
            version: "0.1.0",
            platform: process.platform,
            mode: "backend",
            instanceId: `collector-${process.pid}`,
          },
          role: "operator",
          scopes: ["operator.read"],
          caps: [],
          auth: { token: this.options.token },
        },
        10_000,
      )) as GatewayHello;
      if (socket !== this.socket) return;
      if (!hello || hello.type !== "hello-ok") throw new Error("Gateway did not return hello-ok");
      if (hello.protocol !== 4) throw new Error(`incompatible protocol ${hello.protocol}; Collector requires 4`);
      if (this.challengeTimer) clearTimeout(this.challengeTimer);
      this.challengeTimer = undefined;
      this.connected = true;
      this.hello = hello;
      this.reconnectAttempt = 0;
      const state: GatewayConnectionState = { state: "connected", hello, connectedAt: Date.now() };
      this.options.onState?.(state);
      for (const waiter of this.helloWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(hello);
      }
      this.helloWaiters.clear();
    } catch (error) {
      const message = errorMessage(error);
      const lower = message.toLowerCase();
      if (lower.includes("unauthorized") || lower.includes("authentication") || lower.includes("invalid token")) {
        this.options.onState?.({ state: "unauthorized", at: Date.now(), message });
      } else if (lower.includes("incompatible") || lower.includes("protocol")) {
        this.options.onState?.({ state: "incompatible", at: Date.now(), message });
      } else {
        this.options.onState?.({ state: "error", at: Date.now(), message });
      }
      this.rejectHelloWaiters(error instanceof Error ? error : new Error(message));
      socket.close(1008, "connect failed");
    }
  }

  private async sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(`Gateway socket is not open for ${method}`);
    const id = randomUUID();
    const payload = JSON.stringify({ type: "req", id, method, ...(params === undefined ? {} : { params }) });
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(payload, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectHelloWaiters(error: Error): void {
    for (const waiter of this.helloWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.helloWaiters.clear();
  }
}
