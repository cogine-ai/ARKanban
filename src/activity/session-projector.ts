import type { SessionCoverage, SessionKindHint } from "../contracts.js";
import { FieldInventory, pick } from "../collector/field-inventory.js";
import type { AgentWrite, SessionWrite } from "../storage/repository.js";
import { agentIdFromSessionKey, type RawSessionRow } from "./projector.js";

/**
 * Projects raw Gateway rows into Session and Agent archive records.
 *
 * Every field is read through an alias list rather than a hard-coded key, so
 * correcting one is a single-line edit here. `FieldInventory` reports which
 * logical fields never matched and which response keys nothing consumed.
 *
 * The lists were originally guessed from protocol prose. They have since been
 * checked against the response builders shipped in OpenClaw 2026.7.1-2
 * (`buildGatewaySessionRow`, `listAgentsForGateway`), and the real name is
 * first in each list. Two classes of correction were needed and neither would
 * have announced itself: names that exist nowhere we looked, and names that
 * match while carrying an object where a string was expected.
 */

export type RawAgentRow = Record<string, unknown>;

export const SESSION_FIELD_ALIASES = {
  sessionKey: ["key", "sessionKey"],
  sessionId: ["sessionId"],
  agentId: ["agentId", "agent"],
  label: ["label", "displayName", "title"],
  runtime: ["agentRuntime", "runtime"],
  model: ["model", "modelId"],
  category: ["category", "group"],
  kind: ["kind", "sessionKind", "conversationKind"],
  archived: ["archived", "isArchived", "archivedAt"],
  hasActiveRun: ["hasActiveRun", "active"],
  placement: ["placement"],
  // 2026.7.1-2 rows carry no creation time. `startedAt` is the newest run's
  // start and used to sit in this list, which would have labelled a long-lived
  // session as created moments ago every time it ran.
  createdAt: ["createdAt"],
  lastActivityAt: ["lastActivityAt", "updatedAt", "lastMessageAt"],
  parentSessionKey: ["parentSessionKey", "parentKey"],
  previousSessionId: ["previousSessionId", "priorSessionId"],
  forkSourceKey: ["forkedFromParent", "forkSource", "forkSourceKey", "forkedFrom"],
  spawnedBy: ["spawnedBy", "spawnedByKey"],
  spawnDepth: ["spawnDepth", "depth"],
  subagentRole: ["subagentRole", "role"],
  worktree: ["worktree"],
} as const satisfies Record<string, readonly string[]>;

export const AGENT_FIELD_ALIASES = {
  id: ["id", "agentId"],
  displayName: ["name", "displayName", "label"],
  // No agent kind is exposed. Roster rows are `{ id, name, model, agentRuntime,
  // workspace, identity, ... }` with nothing marking an agent as built-in, so
  // every entry projects as `unknown` and callers must not read that as a fact
  // about the agent.
  kind: ["kind", "type"],
  runtime: ["agentRuntime", "runtime"],
  model: ["model", "modelId"],
} as const satisfies Record<string, readonly string[]>;

type SessionField = keyof typeof SESSION_FIELD_ALIASES;
type AgentField = keyof typeof AGENT_FIELD_ALIASES;

/**
 * `classifySessionKey` in 2026.7.1-2 answers only `global`, `unknown`, `group`,
 * or `direct`. The fork and subagent variants are kept for other Gateway lines
 * but cannot arrive from this one, which is why `projectSession` decides them
 * from lineage instead; `group` has no counterpart here and stays `unknown`
 * rather than being flattened into `main`.
 *
 * Null-prototype: the key is a Gateway-supplied string, and on a plain object
 * `hints["constructor"]` would resolve up the prototype chain to a function.
 */
const KIND_HINTS: Record<string, SessionKindHint> = Object.assign(Object.create(null), {
  main: "main",
  direct: "main",
  primary: "main",
  fork: "fork",
  forked: "fork",
  subagent: "subagent",
  sub: "subagent",
  child: "subagent",
  global: "global",
});

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Anything older is a unit mismatch — seconds read as milliseconds — not a date. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2015, 0, 1);

/**
 * Bounds a Gateway timestamp by the moment it was observed.
 *
 * A future date is clock skew, and it does real damage here: a session counts as
 * needing rescoring while `computed_at < last_activity_at`, so one dated ahead of
 * now is permanently stale — the recompute loop would rescore it every pass and
 * never reach the rest of the backlog. A date from before this project existed is
 * a wrong unit rather than a time, and is dropped so it cannot drive retention.
 */
function boundedTimestamp(value: unknown, observedAt: number): number | undefined {
  const parsed = asTimestamp(value);
  if (parsed === undefined || parsed < EARLIEST_PLAUSIBLE_MS) return undefined;
  return Math.min(parsed, observedAt);
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

/**
 * Accepts booleans as well as the timestamp form (`archivedAt`), because a
 * present archival timestamp is itself the signal.
 */
function asFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "1") return true;
    if (lowered === "false" || lowered === "0" || lowered === "") return false;
    return Date.parse(value) > 0;
  }
  return false;
}

/** Omits the key entirely when the value is undefined, keeping rows sparse. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Reads a field that may be a plain string or a descriptor object.
 *
 * `agentRuntime` is `{ id, source }` and an agent's `model` is
 * `{ primary, fallbacks }`. Both names matched our alias lists all along, so
 * the projection found the field, asked for a string, got an object, and stored
 * nothing — the failure mode of a correct name with the wrong shape.
 */
function asNamed(value: unknown, ...keys: string[]): string | undefined {
  const direct = asString(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const nested = asString(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function branchOf(worktree: unknown): string | undefined {
  if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) return undefined;
  // Only the branch name is allowed; repoRoot and other host paths stay out per §8.2.
  return asString((worktree as Record<string, unknown>).branch);
}

export function sessionKindHint(raw: unknown, sessionKey: string | undefined): SessionKindHint {
  const token = asString(raw)?.toLowerCase();
  if (token && KIND_HINTS[token]) return KIND_HINTS[token]!;
  if (sessionKey?.startsWith("global:")) return "global";
  return "unknown";
}

/**
 * Lineage outranks the reported kind when deciding fork versus subagent.
 *
 * A forked or spawned session reports `kind: "direct"` like any other, so
 * trusting the token alone would file every subagent under `main` and leave the
 * fork and subagent buckets permanently empty. The lineage fields are the only
 * evidence that survives.
 */
function kindFromLineage(lineage: {
  forkSourceKey?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  subagentRole?: string;
}): SessionKindHint | undefined {
  if (lineage.subagentRole !== undefined || lineage.spawnedBy !== undefined) return "subagent";
  if (lineage.spawnDepth !== undefined && lineage.spawnDepth > 0) return "subagent";
  if (lineage.forkSourceKey !== undefined) return "fork";
  return undefined;
}

/**
 * Returns undefined for rows without a usable key. A session archive entry with
 * no key cannot be referenced by anything, so dropping it is preferable to
 * inventing a synthetic identifier that later collides with the real one.
 */
export function projectSession(
  row: RawSessionRow,
  observedAt: number,
  inventory?: FieldInventory,
): SessionWrite | undefined {
  inventory?.observeRow(row);
  const read = (field: SessionField): unknown => pick(row, field, SESSION_FIELD_ALIASES[field], inventory);

  const sessionKey = asString(read("sessionKey"));
  if (!sessionKey) return undefined;

  const coverage: SessionCoverage = {
    index: "live",
    detail: "not_observed",
    usage: "not_observed",
    messages: "not_observed",
  };

  const lineage: SessionWrite["lineage"] = {
    ...optional("parentSessionKey", asString(read("parentSessionKey"))),
    ...optional("previousSessionId", asString(read("previousSessionId"))),
    ...optional("forkSourceKey", asString(read("forkSourceKey"))),
    ...optional("spawnedBy", asString(read("spawnedBy"))),
    ...optional("spawnDepth", asInteger(read("spawnDepth"))),
    ...optional("subagentRole", asString(read("subagentRole"))),
    ...optional("worktreeBranch", branchOf(read("worktree"))),
  };

  return {
    sessionKey,
    ...optional("sessionId", asString(read("sessionId"))),
    // Rows carry no `agentId`; the key is the only place it appears.
    agentId: asString(read("agentId")) ?? agentIdFromSessionKey(sessionKey) ?? "Unattributed",
    label: asString(read("label")) ?? sessionKey,
    ...optional("runtime", asNamed(read("runtime"), "id")),
    ...optional("model", asNamed(read("model"), "primary")),
    ...optional("category", asString(read("category"))),
    kindHint: kindFromLineage(lineage) ?? sessionKindHint(read("kind"), sessionKey),
    archived: asFlag(read("archived")),
    hasActiveRun: asFlag(read("hasActiveRun")),
    ...optional("placement", asString(read("placement"))),
    lineage,
    ...optional("createdAt", boundedTimestamp(read("createdAt"), observedAt)),
    lastActivityAt: boundedTimestamp(read("lastActivityAt"), observedAt) ?? observedAt,
    observedAt,
    coverage,
  };
}

export function projectAgent(row: RawAgentRow, observedAt: number, inventory?: FieldInventory): AgentWrite | undefined {
  inventory?.observeRow(row);
  const read = (field: AgentField): unknown => pick(row, field, AGENT_FIELD_ALIASES[field], inventory);

  const id = asString(read("id"));
  if (!id) return undefined;
  const kind = asString(read("kind"))?.toLowerCase();

  return {
    id,
    displayName: asString(read("displayName")) ?? id,
    kind: kind === "agent" || kind === "system" ? kind : "unknown",
    ...optional("runtime", asNamed(read("runtime"), "id")),
    ...optional("model", asNamed(read("model"), "primary")),
    origin: "roster",
    observedAt,
  };
}

/**
 * Builds a roster from agent ids already seen on sessions, used when
 * `agents.list` is unavailable. These entries are marked `observed` so the
 * upsert never lets them overwrite an authoritative roster row.
 */
export function inferAgents(agentIds: Iterable<string>, observedAt: number): AgentWrite[] {
  return [...new Set(agentIds)]
    .filter((id) => id.length > 0)
    .map((id) => ({
      id,
      displayName: id,
      kind: "unknown" as const,
      origin: "observed" as const,
      observedAt,
    }));
}
