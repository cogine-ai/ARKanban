import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { CollectorChange, CollectorStatus, SettledRange } from "../contracts.js";
import type { CollectorRuntime } from "../collector/runtime.js";
import type { ResolvedCollectorConfig } from "../config.js";
import type { SessionStateFilter } from "../storage/repository.js";
import {
  decodeCursor,
  DEFERRED_SESSION_SORTS,
  isSessionSort,
  SESSION_SORTS,
} from "../storage/keyset-cursor.js";

const SESSION_PAGE_LIMIT_DEFAULT = 50;
const SESSION_PAGE_LIMIT_MAX = 200;
const ACTIVITY_PAGE_LIMIT_DEFAULT = 100;
const ACTIVITY_PAGE_LIMIT_MAX = 500;
const SESSION_STATES: readonly SessionStateFilter[] = ["active", "terminal", "archived"];

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isSessionState(value: string): value is SessionStateFilter {
  return (SESSION_STATES as readonly string[]).includes(value);
}

/** Returns undefined for an out-of-range or non-integer limit so callers can 400. */
function parseLimit(
  raw: string | undefined,
  max: number = SESSION_PAGE_LIMIT_MAX,
  fallback: number = SESSION_PAGE_LIMIT_DEFAULT,
): number | undefined {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return undefined;
  return parsed;
}

/**
 * Three-way result: undefined means absent, null means present but invalid.
 * Collapsing those would turn a typo'd timestamp into an unfiltered query.
 */
function parseTimestamp(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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

  app.get("/api/v1/agents", async () => ({ agents: runtime.repository.listAgentOverviews() }));

  app.get<{ Params: { id: string } }>("/api/v1/agents/:id", async (request, reply) => {
    const agent = runtime.repository.getAgentOverview(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent_not_found" });
    return {
      agent,
      sessions: runtime.repository.listSessionsPage({
        agentId: agent.id,
        sort: "lastActivity",
        limit: SESSION_PAGE_LIMIT_DEFAULT,
      }),
    };
  });

  app.get<{
    Querystring: {
      agentId?: string;
      state?: string;
      since?: string;
      until?: string;
      sort?: string;
      limit?: string;
      cursor?: string;
    };
  }>("/api/v1/sessions", async (request, reply) => {
    const { sort, state, limit, since, until } = request.query;

    if (sort !== undefined && DEFERRED_SESSION_SORTS[sort]) {
      // Named explicitly so a client does not read a silent fallback ordering as
      // a working sort returning wrong rows.
      return reply.code(400).send({
        error: "sort_not_yet_collected",
        sort,
        availableIn: DEFERRED_SESSION_SORTS[sort],
        supported: SESSION_SORTS,
      });
    }
    const resolvedSort = sort ?? "lastActivity";
    if (!isSessionSort(resolvedSort)) {
      return reply.code(400).send({ error: "invalid_sort", supported: SESSION_SORTS });
    }
    if (state !== undefined && !isSessionState(state)) {
      return reply.code(400).send({ error: "invalid_state", supported: SESSION_STATES });
    }
    const resolvedLimit = parseLimit(limit);
    if (resolvedLimit === undefined) {
      return reply.code(400).send({ error: "invalid_limit", min: 1, max: SESSION_PAGE_LIMIT_MAX });
    }
    const sinceMs = parseTimestamp(since);
    const untilMs = parseTimestamp(until);
    if (sinceMs === null || untilMs === null) return reply.code(400).send({ error: "invalid_time_range" });

    let cursor;
    if (request.query.cursor !== undefined) {
      cursor = decodeCursor(request.query.cursor, resolvedSort);
      // A cursor issued for another sort would compare unrelated magnitudes.
      // Restarting from page one instead would silently repeat rows the user
      // already scrolled past, so this is reported rather than absorbed.
      if (!cursor) return reply.code(400).send({ error: "invalid_cursor", sort: resolvedSort });
    }

    return runtime.repository.listSessionsPage({
      ...(request.query.agentId !== undefined ? { agentId: request.query.agentId } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(sinceMs !== undefined ? { since: sinceMs } : {}),
      ...(untilMs !== undefined ? { until: untilMs } : {}),
      sort: resolvedSort,
      limit: resolvedLimit,
      ...(cursor ? { cursor } : {}),
    });
  });

  app.get<{ Params: { key: string } }>("/api/v1/sessions/:key", async (request, reply) => {
    const session = runtime.repository.getSession(request.params.key);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    return session;
  });

  app.get<{ Params: { key: string }; Querystring: { limit?: string } }>(
    "/api/v1/sessions/:key/activities",
    async (request, reply) => {
      if (!runtime.repository.getSession(request.params.key)) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const limit = parseLimit(request.query.limit, ACTIVITY_PAGE_LIMIT_MAX, ACTIVITY_PAGE_LIMIT_DEFAULT);
      if (limit === undefined) {
        return reply.code(400).send({ error: "invalid_limit", min: 1, max: ACTIVITY_PAGE_LIMIT_MAX });
      }
      return { activities: runtime.repository.listSessionActivities(request.params.key, limit) };
    },
  );

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
        // A fresh connection has no client state to reconcile against, so every
        // surface is stale regardless of what changed server-side.
        topics: ["activities", "sessions", "usage", "agents"],
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
