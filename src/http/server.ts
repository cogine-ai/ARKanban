import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type {
  AgentOverview,
  CollectorChange,
  CollectorStatus,
  SessionSignalGrade,
  SettledRange,
  UsageSummary,
} from "../contracts.js";
import type { CollectorRuntime } from "../collector/runtime.js";
import type { ResolvedCollectorConfig } from "../config.js";
import type { SessionStateFilter } from "../storage/repository.js";
import {
  decodeCursor,
  DEFERRED_SESSION_SORTS,
  isSessionSort,
  SESSION_SORTS,
} from "../storage/keyset-cursor.js";
import { MIN_FTS_QUERY_LENGTH } from "../storage/transcript-archive.js";

const SESSION_PAGE_LIMIT_DEFAULT = 50;
const SESSION_PAGE_LIMIT_MAX = 200;
const ACTIVITY_PAGE_LIMIT_DEFAULT = 100;
const ACTIVITY_PAGE_LIMIT_MAX = 500;
const MESSAGE_PAGE_LIMIT_DEFAULT = 200;
const MESSAGE_PAGE_LIMIT_MAX = 500;
const MESSAGE_SEARCH_LIMIT_DEFAULT = 50;
const USAGE_SUMMARY_DEFAULT_MS = 24 * 60 * 60 * 1_000;
const SESSION_STATES: readonly SessionStateFilter[] = ["active", "terminal", "archived"];
const SESSION_SIGNAL_GRADES: readonly SessionSignalGrade[] = ["A", "B", "C", "D", "F", "unscored"];

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isSessionState(value: string): value is SessionStateFilter {
  return (SESSION_STATES as readonly string[]).includes(value);
}

function isSignalGrade(value: string): value is SessionSignalGrade {
  return (SESSION_SIGNAL_GRADES as readonly string[]).includes(value);
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

/** Same three-way contract, for a message sequence number rather than a time. */
function parseSeq(raw: string | undefined): number | undefined | null {
  return parseTimestamp(raw);
}

/**
 * Overlays the Gateway's ranged pricing onto an agent card.
 *
 * `usage.cost` prices a whole range at once, so it is the better figure than
 * one summed from per-session readings taken at different moments. Only the
 * amount is replaced: whether the total is complete is decided by the models
 * `sessions.usage` could not price, and a ranged total cannot have priced a
 * model that the per-session read already reported as unpriced.
 */
function withGatewayCost(runtime: CollectorRuntime, agent: AgentOverview): AgentOverview {
  const windows = { ...agent.cost.windows };
  let overlaid = false;
  for (const window of ["24h", "7d"] as const) {
    const priced = runtime.getAgentCost(window, agent.id);
    if (priced === undefined) continue;
    windows[window] = { ...windows[window], costMicroUsd: priced };
    overlaid = true;
  }
  return overlaid ? { ...agent, cost: { ...agent.cost, source: "gateway", windows } } : agent;
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

  app.get("/api/v1/agents", async () => ({
    agents: runtime.repository.listAgentOverviews().map((agent) => withGatewayCost(runtime, agent)),
  }));

  app.get<{ Params: { id: string } }>("/api/v1/agents/:id", async (request, reply) => {
    const found = runtime.repository.getAgentOverview(request.params.id);
    if (!found) return reply.code(404).send({ error: "agent_not_found" });
    const agent = withGatewayCost(runtime, found);
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
      grade?: string;
      since?: string;
      until?: string;
      sort?: string;
      limit?: string;
      cursor?: string;
    };
  }>("/api/v1/sessions", async (request, reply) => {
    const { sort, state, grade, limit, since, until } = request.query;

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
    if (grade !== undefined && !isSignalGrade(grade)) {
      return reply.code(400).send({ error: "invalid_grade", supported: SESSION_SIGNAL_GRADES });
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
      ...(grade !== undefined ? { grade } : {}),
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
    const usage = runtime.repository.usage.latest(request.params.key);
    // Scored on read when the stored row is behind the evidence. Opening one
    // session is exactly when its verdict matters, and one session costs a
    // couple of indexed reads — cheap enough not to make the reader wait for
    // the background pass to come round.
    const signals = runtime.repository.signals.freshFor(request.params.key, Date.now());
    return { ...session, ...(usage ? { usage } : {}), ...(signals ? { signals } : {}) };
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

  /**
   * Reads the local archive only. It never falls back to the Gateway, which is
   * what lets the transcript stay readable while the connection is down — and
   * why the sync watermark ships with every page instead of being optional.
   */
  app.get<{ Params: { key: string }; Querystring: { afterSeq?: string; limit?: string } }>(
    "/api/v1/sessions/:key/messages",
    async (request, reply) => {
      if (!runtime.repository.getSession(request.params.key)) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const limit = parseLimit(request.query.limit, MESSAGE_PAGE_LIMIT_MAX, MESSAGE_PAGE_LIMIT_DEFAULT);
      if (limit === undefined) {
        return reply.code(400).send({ error: "invalid_limit", min: 1, max: MESSAGE_PAGE_LIMIT_MAX });
      }
      const afterSeq = parseSeq(request.query.afterSeq);
      if (afterSeq === null) return reply.code(400).send({ error: "invalid_after_seq" });

      const messages = runtime.repository.transcripts.listMessages(request.params.key, {
        ...(afterSeq !== undefined ? { afterSeq } : {}),
        limit,
      });
      return {
        messages,
        sync: runtime.repository.transcripts.syncState(request.params.key) ?? {
          sessionKey: request.params.key,
          syncedCount: 0,
          syncedBytes: 0,
          complete: false,
        },
      };
    },
  );

  app.get<{
    Querystring: { q?: string; agentId?: string; sessionKey?: string; from?: string; to?: string; limit?: string };
  }>("/api/v1/search/messages", async (request, reply) => {
    const text = request.query.q?.trim();
    if (!text) return reply.code(400).send({ error: "missing_query" });

    const limit = parseLimit(request.query.limit, MESSAGE_PAGE_LIMIT_MAX, MESSAGE_SEARCH_LIMIT_DEFAULT);
    if (limit === undefined) {
      return reply.code(400).send({ error: "invalid_limit", min: 1, max: MESSAGE_PAGE_LIMIT_MAX });
    }
    const from = parseTimestamp(request.query.from);
    const to = parseTimestamp(request.query.to);
    if (from === null || to === null) return reply.code(400).send({ error: "invalid_time_range" });

    const narrowed = request.query.agentId !== undefined || request.query.sessionKey !== undefined || from !== undefined;
    // A query too short for the trigram index can only be served by a LIKE scan.
    // Refusing the unnarrowed case is deliberate: the alternative is a full-archive
    // scan that looks like a hang.
    if ([...text].length < MIN_FTS_QUERY_LENGTH && !narrowed) {
      return reply.code(400).send({
        error: "query_too_short",
        minLength: MIN_FTS_QUERY_LENGTH,
        hint: "Filter by agentId, sessionKey or a time range to search a shorter string",
      });
    }

    return runtime.repository.transcripts.search({
      text,
      ...(request.query.agentId !== undefined ? { agentId: request.query.agentId } : {}),
      ...(request.query.sessionKey !== undefined ? { sessionKey: request.query.sessionKey } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      limit,
    });
  });

  /**
   * Backs the standing disclosure that full conversation text is stored on this
   * machine. Counts and settings only — never a fragment of the text itself.
   */
  app.get("/api/v1/transcripts/status", async () => ({
    sync: runtime.getTranscriptStatus() ?? null,
    enabled: runtime.config.storage.transcriptSync === "enabled",
    retentionDays: runtime.config.storage.transcriptRetentionDays,
    maxBytes: runtime.config.storage.transcriptMaxBytes,
    ...runtime.repository.transcripts.totals(),
  }));

  /**
   * Ranged token and cost totals.
   *
   * Defaults to the last 24 hours because an unbounded default would scan the
   * whole archive on a page load.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/v1/usage/summary", async (request, reply) => {
    const from = parseTimestamp(request.query.from);
    const to = parseTimestamp(request.query.to);
    if (from === null || to === null) return reply.code(400).send({ error: "invalid_time_range" });

    const rangeEnd = to ?? Date.now();
    const rangeStart = from ?? rangeEnd - USAGE_SUMMARY_DEFAULT_MS;
    if (rangeStart > rangeEnd) return reply.code(400).send({ error: "invalid_time_range" });

    const { totals, byAgent, byModel } = runtime.repository.usage.summary(rangeStart, rangeEnd);
    return {
      from: rangeStart,
      to: rangeEnd,
      coverage: runtime.repository.getUsageCoverage(),
      totals,
      byAgent: [...byAgent].map(([agentId, agentTotals]) => ({ agentId, totals: agentTotals })),
      byModel: [...byModel].map(([model, modelTotals]) => ({ model, totals: modelTotals })),
    } satisfies UsageSummary;
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
