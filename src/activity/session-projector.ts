import type { SessionCoverage, SessionKindHint } from "../contracts.js";
import { FieldInventory, pick } from "../collector/field-inventory.js";
import type { AgentWrite, SessionWrite } from "../storage/repository.js";
import { agentIdFromSessionKey, type RawSessionRow } from "./projector.js";

/**
 * Projects raw Gateway rows into Session and Agent archive records.
 *
 * Every field is read through an alias list rather than a hard-coded key. The
 * names come from the OpenClaw protocol documentation and have not been checked
 * against a live Gateway, so correcting one is meant to be a single-line edit
 * here: add the real key to the front of the relevant list. `FieldInventory`
 * reports which logical fields never matched and which response keys nothing
 * consumed.
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
  createdAt: ["createdAt", "startedAt"],
  lastActivityAt: ["lastActivityAt", "updatedAt", "lastMessageAt"],
  parentSessionKey: ["parentSessionKey", "parentKey"],
  previousSessionId: ["previousSessionId", "priorSessionId"],
  forkSourceKey: ["forkSource", "forkSourceKey", "forkedFrom"],
  spawnedBy: ["spawnedBy", "spawnedByKey"],
  spawnDepth: ["spawnDepth", "depth"],
  subagentRole: ["subagentRole", "role"],
  worktree: ["worktree"],
} as const satisfies Record<string, readonly string[]>;

export const AGENT_FIELD_ALIASES = {
  id: ["id", "agentId"],
  displayName: ["displayName", "name", "label"],
  kind: ["kind", "type"],
  runtime: ["runtime", "agentRuntime"],
  model: ["model", "modelId"],
} as const satisfies Record<string, readonly string[]>;

type SessionField = keyof typeof SESSION_FIELD_ALIASES;
type AgentField = keyof typeof AGENT_FIELD_ALIASES;

const KIND_HINTS: Record<string, SessionKindHint> = {
  main: "main",
  direct: "main",
  primary: "main",
  fork: "fork",
  forked: "fork",
  subagent: "subagent",
  sub: "subagent",
  child: "subagent",
  global: "global",
};

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

  return {
    sessionKey,
    ...optional("sessionId", asString(read("sessionId"))),
    agentId: asString(read("agentId")) ?? agentIdFromSessionKey(sessionKey) ?? "Unattributed",
    label: asString(read("label")) ?? sessionKey,
    ...optional("runtime", asString(read("runtime"))),
    ...optional("model", asString(read("model"))),
    ...optional("category", asString(read("category"))),
    kindHint: sessionKindHint(read("kind"), sessionKey),
    archived: asFlag(read("archived")),
    hasActiveRun: asFlag(read("hasActiveRun")),
    ...optional("placement", asString(read("placement"))),
    lineage: {
      ...optional("parentSessionKey", asString(read("parentSessionKey"))),
      ...optional("previousSessionId", asString(read("previousSessionId"))),
      ...optional("forkSourceKey", asString(read("forkSourceKey"))),
      ...optional("spawnedBy", asString(read("spawnedBy"))),
      ...optional("spawnDepth", asInteger(read("spawnDepth"))),
      ...optional("subagentRole", asString(read("subagentRole"))),
      ...optional("worktreeBranch", branchOf(read("worktree"))),
    },
    ...optional("createdAt", asTimestamp(read("createdAt"))),
    lastActivityAt: asTimestamp(read("lastActivityAt")) ?? observedAt,
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
    ...optional("runtime", asString(read("runtime"))),
    ...optional("model", asString(read("model"))),
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
