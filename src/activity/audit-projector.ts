import type { ActivityOutcome } from "../contracts.js";
import { FieldInventory, pick } from "../collector/field-inventory.js";
import type { AuditEventWrite } from "../storage/audit-store.js";
import { boundedTimestamp } from "./timestamps.js";

/**
 * Projects raw `audit.list` rows into audit trail writes.
 *
 * The method is `audit.list`, not the `audit.activity.list` the blueprint named,
 * and its `kind` accepts `agent_run` and `tool_action` rather than `message`.
 * Both were read off the handler in OpenClaw 2026.7.1-2, which is also where the
 * response shape below comes from: `{ events, nextCursor? }`, newest first, with
 * `nextCursor` present only while older records remain.
 */

export const AUDIT_FIELD_ALIASES = {
  eventId: ["eventId", "id"],
  sequence: ["sequence", "seq"],
  /** The Gateway's own dedup key component; kept so a row explains itself. */
  sourceSequence: ["sourceSequence"],
  occurredAt: ["occurredAt", "timestamp", "ts"],
  kind: ["kind", "type"],
  action: ["action"],
  status: ["status", "state"],
  errorCode: ["errorCode", "error_code"],
  /** `{ type, id }` — an object, so it is read through its own two lookups. */
  actor: ["actor"],
  actorType: ["type"],
  actorId: ["id"],
  agentId: ["agentId", "agent"],
  sessionKey: ["sessionKey", "key"],
  sessionId: ["sessionId"],
  runId: ["runId", "run"],
  toolCallId: ["toolCallId"],
  toolName: ["toolName", "tool"],
  /**
   * The Gateway's promise that the row is metadata.
   *
   * Read rather than ignored: a build that shipped anything else here would be
   * offering content through a path with none of the archive's controls, and this
   * projector drops those rows instead of storing them.
   */
  redaction: ["redaction"],
} as const satisfies Record<string, readonly string[]>;

export const AUDIT_PAGE_ALIASES = {
  events: ["events", "items", "records"],
  nextCursor: ["nextCursor"],
} as const satisfies Record<string, readonly string[]>;

/** The only value the audit contract allows, and the only one worth storing. */
export const METADATA_ONLY = "metadata_only";

/**
 * Statuses that settle a call, and what each one asserts.
 *
 * A closed set taken from the handler, unlike the observation phase vocabulary in
 * `session-signals.ts`, which had to be guessed from prose. `started` is absent
 * on purpose: a call with only a start has settled nothing, and reading it either
 * way would invent an outcome. `cancelled` is absent for a different reason — an
 * operator stopping a tool is not the tool failing, and charging it as one would
 * grade an interrupted session as a broken one.
 */
export const AUDIT_TOOL_VERDICTS: Record<string, boolean> = Object.assign(Object.create(null), {
  succeeded: false,
  failed: true,
  timed_out: true,
  blocked: true,
});

/**
 * Run statuses as the outcome vocabulary this codebase already scores.
 *
 * The two vocabularies coincide, which is not a coincidence: both describe how a
 * run ended, and `ActivityOutcome` was derived from the same protocol.
 */
export const AUDIT_RUN_OUTCOMES: Record<string, ActivityOutcome> = Object.assign(Object.create(null), {
  succeeded: "succeeded",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  blocked: "blocked",
});

/** Whether a stored row settles a tool call, and which way. Undefined if neither. */
export function auditToolVerdict(status: string, errorCode: string | undefined): boolean | undefined {
  const stated = AUDIT_TOOL_VERDICTS[status.toLowerCase()];
  if (stated !== undefined) return stated;
  // An error code without a status this build knows is still a stated failure;
  // the reverse — a status this build knows — is answered above.
  return errorCode ? true : undefined;
}

export const AUDIT_KIND_TOOL = "tool_action";
export const AUDIT_KIND_RUN = "agent_run";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export type ProjectAuditOptions = {
  observedAt: number;
  inventory?: FieldInventory;
};

export type ProjectedAuditPage = {
  /** Ordered as the Gateway returned them: newest first. */
  writes: AuditEventWrite[];
  /** Token for the next older page, absent when this page is the oldest. */
  nextCursor?: string;
  newestSequence?: number;
  oldestSequence?: number;
  /** Rows without an identity, a sequence, or the metadata-only guarantee. */
  dropped: number;
};

export function projectAuditPage(payload: Record<string, unknown>, options: ProjectAuditOptions): ProjectedAuditPage {
  const rawEvents = pick(payload, "events", AUDIT_PAGE_ALIASES.events, options.inventory);
  const rows = Array.isArray(rawEvents) ? rawEvents : [];
  const writes: AuditEventWrite[] = [];
  let dropped = 0;

  for (const entry of rows) {
    const row = record(entry);
    if (!row) {
      dropped += 1;
      continue;
    }
    options.inventory?.observeRow(row);
    const read = (field: keyof typeof AUDIT_FIELD_ALIASES): unknown =>
      pick(row, field, AUDIT_FIELD_ALIASES[field], options.inventory);

    const redaction = asString(read("redaction"));
    if (redaction !== undefined && redaction !== METADATA_ONLY) {
      dropped += 1;
      continue;
    }

    const eventId = asString(read("eventId"));
    const sequence = asInteger(read("sequence"));
    const occurredAt = boundedTimestamp(read("occurredAt"), options.observedAt);
    const kind = asString(read("kind"));
    const status = asString(read("status"));
    // Without any of these the row cannot be stored idempotently, ordered, dated
    // or read as a verdict, which is everything it exists for.
    if (eventId === undefined || sequence === undefined || occurredAt === undefined || !kind || !status) {
      dropped += 1;
      continue;
    }

    const actor = record(read("actor"));
    const actorType = actor ? asString(pick(actor, "actorType", AUDIT_FIELD_ALIASES.actorType, options.inventory)) : undefined;
    const actorId = actor ? asString(pick(actor, "actorId", AUDIT_FIELD_ALIASES.actorId, options.inventory)) : undefined;

    // Read once each. Every one of these is optional, and the spread below omits
    // the absent ones rather than storing a blank: a row that did not report a
    // session is not a row about a session named "".
    const sourceSequence = asInteger(read("sourceSequence"));
    const action = asString(read("action"));
    const errorCode = asString(read("errorCode"));
    const agentId = asString(read("agentId"));
    const sessionKey = asString(read("sessionKey"));
    const sessionId = asString(read("sessionId"));
    const runId = asString(read("runId"));
    const toolCallId = asString(read("toolCallId"));
    const toolName = asString(read("toolName"));

    writes.push({
      eventId,
      sequence,
      ...(sourceSequence !== undefined ? { sourceSequence } : {}),
      occurredAt,
      kind,
      ...(action ? { action } : {}),
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(actorType ? { actorType } : {}),
      ...(actorId ? { actorId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
      observedAt: options.observedAt,
    });
  }

  const sequences = writes.map((write) => write.sequence);
  const nextCursor = asString(pick(payload, "nextCursor", AUDIT_PAGE_ALIASES.nextCursor, options.inventory));

  return {
    writes,
    // Passed on whenever the Gateway sent one, including from a page none of whose
    // rows could be read. The cursor is derived from the Gateway's own last row,
    // not from what this projector kept, so it still points below this page — and
    // dropping it would report an unreadable stretch as the end of the trail,
    // which is the one conclusion that stops the backwards walk for good.
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(sequences.length > 0 ? { newestSequence: Math.max(...sequences) } : {}),
    ...(sequences.length > 0 ? { oldestSequence: Math.min(...sequences) } : {}),
    dropped,
  };
}
