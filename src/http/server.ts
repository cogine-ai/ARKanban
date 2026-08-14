import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { CollectorChange, CollectorStatus } from "../contracts.js";
import type { CollectorRuntime } from "../collector/runtime.js";
import type { ResolvedCollectorConfig } from "../config.js";

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function createHttpServer(
  runtime: CollectorRuntime,
  config: ResolvedCollectorConfig,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.get("/healthz", async () => ({ ok: true, version: "0.1.0" }));
  app.get("/readyz", async (_request, reply) => {
    const status = runtime.getStatus();
    if (!status.process.ready) reply.code(503);
    return { ok: status.process.ready, syncState: status.syncState, reasons: status.syncReasons };
  });
  app.get("/api/v1/meta", async () => runtime.getStatus());
  app.get("/api/v1/snapshot", async () => runtime.getSnapshot());
  app.get<{ Params: { id: string } }>("/api/v1/activities/:id", async (request, reply) => {
    const detail = runtime.getDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "activity_not_found" });
    return detail;
  });
  app.get("/api/v1/events", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(sseEvent("status", runtime.getStatus()));
    response.write(
      sseEvent("invalidate", {
        epoch: runtime.repository.epoch,
        revision: runtime.repository.revision,
        full: true,
        ids: [],
        reasons: ["sse_connected"],
        syncState: runtime.getStatus().syncState,
      } satisfies CollectorChange),
    );

    const unsubscribeChanges = runtime.subscribeChanges((change) => {
      const event: CollectorChange = {
        ...change,
        full: false,
        syncState: runtime.getStatus().syncState,
      };
      if (!response.destroyed) response.write(sseEvent("invalidate", event));
    });
    const unsubscribeStatus = runtime.subscribeStatus((status: CollectorStatus) => {
      if (!response.destroyed) response.write(sseEvent("status", status));
    });
    const keepAlive = setInterval(() => {
      if (!response.destroyed) response.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    request.raw.once("close", () => {
      clearInterval(keepAlive);
      unsubscribeChanges();
      unsubscribeStatus();
    });
  });

  const webRoot = path.resolve(process.cwd(), "dist/web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  } else {
    app.get("/", async () => ({
      name: "OpenClaw Collector",
      message: "Web bundle not found. Run pnpm build:web or use pnpm dev.",
      api: "/api/v1/snapshot",
    }));
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    void reply.code(500).send({
      error: "collector_request_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  });
  return app;
}
