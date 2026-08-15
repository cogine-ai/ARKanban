import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { CollectorChange, CollectorStatus, SettledRange } from "../contracts.js";
import type { CollectorRuntime } from "../collector/runtime.js";
import type { ResolvedCollectorConfig } from "../config.js";

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function settledRange(value: string | undefined): SettledRange | undefined {
  if (value === undefined) return "7d";
  return value === "24h" || value === "7d" || value === "30d" ? value : undefined;
}

function settledRangeEnd(value: string | undefined): number | undefined {
  if (value === undefined) return Date.now();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
  /**
   * Reports how the session and agent projectors matched the connected Gateway:
   * `unknown` keys were returned but consumed by nothing, `missing` aliases were
   * looked for and never seen. Both indicate a mapping that needs correcting for
   * this Gateway build. Field names only — no session content.
   */
  app.get("/api/v1/diagnostics/field-coverage", async () => ({
    gateway: runtime.getStatus().gateway,
    capabilities: runtime.getCapabilities(),
    fields: runtime.getFieldReports(),
    ...runtime.getArchiveDiagnostics(),
  }));
  app.get<{ Querystring: { range?: string; rangeEnd?: string } }>("/api/v1/settled-groups", async (request, reply) => {
    const range = settledRange(request.query.range);
    if (!range) return reply.code(400).send({ error: "invalid_settled_range", allowed: ["24h", "7d", "30d"] });
    const rangeEnd = settledRangeEnd(request.query.rangeEnd);
    if (rangeEnd === undefined) return reply.code(400).send({ error: "invalid_range_end" });
    return runtime.getSettledGroups(range, rangeEnd);
  });
  app.get<{
    Params: { seriesKey: string };
    Querystring: { range?: string; rangeEnd?: string };
  }>("/api/v1/settled-groups/:seriesKey/runs", async (request, reply) => {
    const range = settledRange(request.query.range);
    if (!range) return reply.code(400).send({ error: "invalid_settled_range", allowed: ["24h", "7d", "30d"] });
    const rangeEnd = settledRangeEnd(request.query.rangeEnd);
    if (rangeEnd === undefined) return reply.code(400).send({ error: "invalid_range_end" });
    const detail = runtime.getSettledSeriesRuns(request.params.seriesKey, range, rangeEnd);
    if (!detail) return reply.code(404).send({ error: "settled_series_not_found" });
    return detail;
  });
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
