import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyError, type FastifyInstance } from "fastify";
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

/**
 * Nothing is fetched from anywhere else, so everything but same-origin script,
 * style and XHR is denied outright. Inline styles are not permitted either:
 * React sets the `style` prop through the CSSStyleDeclaration API, which CSP
 * does not police, so the app needs no exemption to keep working.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Binding to loopback keeps other machines out. It does nothing about a page in
 * the operator's own browser: a hostile site can point its own hostname at
 * 127.0.0.1, and the browser will then treat this API as that site's same
 * origin — reading the session archive, which holds full conversation text.
 * Every request must therefore arrive under a loopback authority.
 *
 * The port is deliberately not compared. A browser sends the port it actually
 * connected to, so it carries no attacker-controlled signal, while pinning it
 * would break a forwarded port for no gain.
 */
function loopbackAuthorities(configuredHost: string): ReadonlySet<string> {
  return new Set(["localhost", "127.0.0.1", "::1", configuredHost.toLowerCase()]);
}

/** Extracts the host from an authority, tolerating `[::1]:port` and a bare IPv6 literal. */
function authorityHost(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1 ? trimmed.slice(1, end) : undefined;
  }
  // More than one colon and no brackets means a bare IPv6 literal, which cannot
  // also carry a port.
  if (trimmed.indexOf(":") !== trimmed.lastIndexOf(":")) return trimmed;
  const host = trimmed.split(":")[0];
  return host || undefined;
}

function originHost(value: string): string | undefined {
  try {
    return authorityHost(new URL(value).host);
  } catch {
    return undefined;
  }
}

/** A repeated header arrives as an array, which is not something a browser sends. */
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  const parsed = parseCount(raw);
  if (parsed === undefined || parsed < 1 || parsed > max) return undefined;
  return parsed;
}

/**
 * Three-way result: undefined means absent, null means present but invalid.
 * Collapsing those would turn a typo'd timestamp into an unfiltered query.
 */
function parseTimestamp(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = parseCount(raw);
  return parsed === undefined ? null : parsed;
}

/**
 * A non-negative integer, or undefined for anything else.
 *
 * `Number("")` and `Number(" ")` are both zero, which would read `?since=` as
 * the epoch and `?limit=` as a limit of nothing. An empty parameter is a caller
 * mistake, and saying so is better than guessing what they meant.
 */
function parseCount(raw: string): number | undefined {
  if (raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * An identifier to filter on, or undefined when the caller sent nothing usable.
 *
 * `?agentId=` reaches here as an empty string, and passing that through asks the
 * database for rows belonging to an agent named "". The empty result is
 * indistinguishable from an agent that has done nothing, so a cleared filter in
 * the URL would read as a silent, wrong answer.
 */
function filterValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
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
  const parsed = parseCount(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

export async function createHttpServer(
  runtime: CollectorRuntime,
  config: ResolvedCollectorConfig,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    logController: new LogController({ disableRequestLogging: true }),
    // A hijacked event stream is a socket Fastify no longer tracks, so `close()`
    // waits on it forever unless the sockets are torn down as well. `preClose`
    // below ends the streams politely; this is what covers the ones already
    // half-gone, and together they are the difference between Ctrl-C returning
    // and Ctrl-C needing a second signal.
    forceCloseConnections: true,
  });

  const allowedHosts = loopbackAuthorities(config.server.host);
  app.addHook("onRequest", async (request, reply) => {
    reply.headers({
      "content-security-policy": CONTENT_SECURITY_POLICY,
      // Search terms travel in the query string, and a term is usually something
      // the operator read in a transcript.
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
    });

    const host = singleHeader(request.headers.host);
    if (!host || !allowedHosts.has(authorityHost(host) ?? "")) {
      return reply.code(403).send({ error: "forbidden_host" });
    }
    // Absent on most same-origin GETs; when it is present it must agree. `null`
    // is the opaque origin a sandboxed frame sends, which no local page needs.
    const origin = singleHeader(request.headers.origin);
    if (origin !== undefined && !allowedHosts.has(originHost(origin) ?? "")) {
      return reply.code(403).send({ error: "forbidden_origin" });
    }
    if (singleHeader(request.headers["sec-fetch-site"]) === "cross-site") {
      return reply.code(403).send({ error: "forbidden_cross_site" });
    }
    return undefined;
  });

  /**
   * No route takes a parameter twice, and a repeat arrives as an array — which
   * every parser below would treat as a string and hand to SQLite as one, where
   * it fails as an unhandled 500. A typo'd URL deserves a 400.
   */
  app.addHook("onRequest", async (request, reply) => {
    const repeated = Object.entries((request.query ?? {}) as Record<string, unknown>).find(([, value]) =>
      Array.isArray(value),
    );
    if (repeated) {
      return reply.code(400).send({ error: "repeated_query_parameter", parameter: repeated[0] });
    }
    return undefined;
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

    const agentId = filterValue(request.query.agentId);
    return runtime.repository.listSessionsPage({
      ...(agentId !== undefined ? { agentId } : {}),
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

    const agentId = filterValue(request.query.agentId);
    const sessionKey = filterValue(request.query.sessionKey);
    const narrowed = agentId !== undefined || sessionKey !== undefined || from !== undefined;
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
      ...(agentId !== undefined ? { agentId } : {}),
      ...(sessionKey !== undefined ? { sessionKey } : {}),
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
    filePermissionsEnforced: runtime.repository.filePermissionsEnforced,
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

  /**
   * A hijacked response is outside Fastify's connection tracking, so an open
   * event stream would keep `close()` waiting for a browser tab to go away —
   * which is to say, keep Ctrl-C from returning. Shutdown ends them itself.
   *
   * `preClose`, not `onClose`: Fastify's own `onClose` hook runs first and awaits
   * the HTTP server, which is exactly what the open stream is preventing, so an
   * `onClose` hook here is only reached after the deadlock it was meant to avoid.
   */
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });

  /**
   * `HEAD` cannot be served from the streaming handler: it hijacks the response
   * and writes a body, so the twin route Fastify generates by default answers a
   * `curl -I` or a health check by hanging until the client gives up.
   */
  app.head("/api/v1/events", async (_request, reply) => reply.code(405).header("allow", "GET").send());

  app.get("/api/v1/events", { exposeHeadRoute: false }, async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    streams.add(response);
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
      streams.delete(response);
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

  /**
   * A 4xx from the framework describes the request and is worth returning. An
   * unexpected 500 describes this process — its file paths, its SQL — and the
   * client has no use for that, so only the log gets the detail.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 500) {
      void reply.code(status).send({ error: "collector_request_failed" });
      return;
    }
    void reply.code(status).send({ error: error.code ?? "request_rejected", message: error.message });
  });
  return app;
}
