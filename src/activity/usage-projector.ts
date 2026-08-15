import { FieldInventory, pick } from "../collector/field-inventory.js";
import type { UsageWrite } from "../storage/usage-store.js";

/**
 * Projects `sessions.usage` and `usage.cost` replies into usage writes.
 *
 * Every field goes through an alias list for the same reason as the other
 * projectors: these names come from protocol documentation, not from a Gateway
 * anyone here has read. Correcting one is a single-line edit — move the real
 * key to the front of its list.
 */

export const USAGE_FIELD_ALIASES = {
  sessionKey: ["sessionKey", "session", "sessionId", "key"],
  inputTokens: ["inputTokens", "input", "promptTokens", "prompt_tokens"],
  outputTokens: ["outputTokens", "output", "completionTokens", "completion_tokens"],
  cacheReadTokens: ["cacheReadTokens", "cacheRead", "cache_read_input_tokens", "cachedTokens"],
  cacheWriteTokens: ["cacheWriteTokens", "cacheWrite", "cache_creation_input_tokens"],
  peakContextTokens: ["peakContextTokens", "peakContext", "maxContextTokens", "contextTokens"],
  costMicroUsd: ["costMicroUsd", "costMicros", "cost_micro_usd"],
  costUsd: ["costUsd", "cost", "totalCost", "amountUsd"],
  models: ["models", "model", "modelIds"],
  unpricedModels: ["unpricedModels", "unpriced", "missingPricing"],
  observedAt: ["observedAt", "ts", "timestamp", "updatedAt"],
} as const satisfies Record<string, readonly string[]>;

export const USAGE_PAGE_ALIASES = {
  sessions: ["sessions", "items", "usage", "entries", "results"],
} as const satisfies Record<string, readonly string[]>;

type UsageField = keyof typeof USAGE_FIELD_ALIASES;

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asTokens(value: unknown): number {
  const parsed = asNumber(value);
  // Negative token counts are meaningless and would silently subtract from a
  // total, so they are treated as absent rather than trusted.
  return parsed !== undefined && parsed >= 0 ? Math.round(parsed) : 0;
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else if (entry && typeof entry === "object") {
      const name = (entry as Record<string, unknown>).model ?? (entry as Record<string, unknown>).id;
      if (typeof name === "string" && name.trim()) out.push(name.trim());
    }
  }
  return out;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Converts a dollar amount to integer micro-USD.
 *
 * Rounding happens once, here, at the boundary. Everything downstream stays
 * integral so summing thousands of sessions cannot accumulate float drift.
 */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export type ProjectUsageOptions = {
  observedAt: number;
  /** Used when the reply omits the key, which happens on single-session reads. */
  sessionKey?: string;
  inventory?: FieldInventory;
};

/**
 * Reads one usage row.
 *
 * A row with no recognisable token counts is dropped rather than stored as
 * zeros: an invented zero would be indistinguishable from a measured one and
 * would drag a real average down.
 */
export function projectUsageRow(raw: unknown, options: ProjectUsageOptions): UsageWrite | undefined {
  const row = record(raw);
  if (!row) return undefined;
  options.inventory?.observeRow(row);
  const read = (field: UsageField): unknown => pick(row, field, USAGE_FIELD_ALIASES[field], options.inventory);

  const sessionKey = (() => {
    const value = read("sessionKey");
    return typeof value === "string" && value.trim() ? value.trim() : options.sessionKey;
  })();
  if (!sessionKey) return undefined;

  const inputTokens = asNumber(read("inputTokens"));
  const outputTokens = asNumber(read("outputTokens"));
  if (inputTokens === undefined && outputTokens === undefined) return undefined;

  const models = asStringList(read("models"));
  const unpricedModels = asStringList(read("unpricedModels"));

  const micros = asNumber(read("costMicroUsd"));
  const dollars = asNumber(read("costUsd"));
  const costMicroUsd = micros !== undefined ? Math.round(micros) : dollars !== undefined ? toMicroUsd(dollars) : undefined;
  // A cost of zero is still a price; only a missing figure or a model the
  // Gateway could not price makes the total a floor.
  const hasCost = costMicroUsd !== undefined && unpricedModels.length === 0;

  const peakContextTokens = asNumber(read("peakContextTokens"));
  const observedAt = asNumber(read("observedAt")) ?? options.observedAt;

  return {
    sessionKey,
    observedAt,
    inputTokens: asTokens(inputTokens),
    outputTokens: asTokens(outputTokens),
    cacheReadTokens: asTokens(read("cacheReadTokens")),
    cacheWriteTokens: asTokens(read("cacheWriteTokens")),
    ...(peakContextTokens !== undefined && peakContextTokens >= 0
      ? { peakContextTokens: Math.round(peakContextTokens) }
      : {}),
    ...(costMicroUsd !== undefined ? { costMicroUsd } : {}),
    hasCost,
    models,
    unpricedModels,
  };
}

export const COST_FIELD_ALIASES = {
  agentId: ["agentId", "agent", "id", "key", "name"],
  costMicroUsd: ["costMicroUsd", "costMicros", "cost_micro_usd"],
  costUsd: ["costUsd", "cost", "amountUsd", "total"],
} as const satisfies Record<string, readonly string[]>;

export const COST_PAGE_ALIASES = {
  entries: ["agents", "byAgent", "breakdown", "items", "entries", "results", "costs"],
  totalMicroUsd: ["totalMicroUsd", "totalCostMicroUsd"],
  totalUsd: ["totalUsd", "totalCost", "total", "cost"],
} as const satisfies Record<string, readonly string[]>;

export type CostReport = { byAgent: Map<string, number>; totalMicroUsd?: number };

/**
 * Reads a ranged `usage.cost` reply into per-agent micro-USD.
 *
 * The Gateway prices work it knows about, which is why its figure takes
 * precedence over one derived from token counts: local pricing would have to
 * guess at rates that change without notice.
 */
export function projectCostReport(payload: unknown, inventory?: FieldInventory): CostReport {
  const byAgent = new Map<string, number>();
  const envelope = record(payload);
  if (!envelope) return { byAgent };
  inventory?.observeRow(envelope);

  const listed = pick(envelope, "entries", COST_PAGE_ALIASES.entries, inventory);
  const rows = Array.isArray(listed)
    ? listed
    : record(listed)
      ? Object.entries(record(listed)!).map(([key, value]) => ({ agentId: key, ...(record(value) ?? {}) }))
      : [];

  for (const entry of rows) {
    const row = record(entry);
    if (!row) continue;
    inventory?.observeRow(row);
    const agentId = pick(row, "agentId", COST_FIELD_ALIASES.agentId, inventory);
    if (typeof agentId !== "string" || !agentId.trim()) continue;
    const micros = asNumber(pick(row, "costMicroUsd", COST_FIELD_ALIASES.costMicroUsd, inventory));
    const dollars = asNumber(pick(row, "costUsd", COST_FIELD_ALIASES.costUsd, inventory));
    const cost = micros !== undefined ? Math.round(micros) : dollars !== undefined ? toMicroUsd(dollars) : undefined;
    if (cost === undefined) continue;
    byAgent.set(agentId.trim(), (byAgent.get(agentId.trim()) ?? 0) + cost);
  }

  const totalMicros = asNumber(pick(envelope, "totalMicroUsd", COST_PAGE_ALIASES.totalMicroUsd, inventory));
  const totalDollars = asNumber(pick(envelope, "totalUsd", COST_PAGE_ALIASES.totalUsd, inventory));
  const totalMicroUsd =
    totalMicros !== undefined
      ? Math.round(totalMicros)
      : totalDollars !== undefined
        ? toMicroUsd(totalDollars)
        : byAgent.size > 0
          ? [...byAgent.values()].reduce((sum, value) => sum + value, 0)
          : undefined;

  return { byAgent, ...(totalMicroUsd !== undefined ? { totalMicroUsd } : {}) };
}

/** Reads a batched `sessions.usage` reply, tolerating both list and map shapes. */
export function projectUsagePage(
  payload: unknown,
  options: ProjectUsageOptions,
): { writes: UsageWrite[]; dropped: number } {
  const envelope = record(payload);
  const listed = envelope ? pick(envelope, "sessions", USAGE_PAGE_ALIASES.sessions, options.inventory) : undefined;

  // The list shape is checked before the single-row shape: a reply that carries
  // both per-session rows and a rolled-up total would otherwise be read as one
  // row and lose every session's identity.
  const rows = (() => {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(listed)) return listed;
    // Some replies key usage by session rather than listing it; fold the key in
    // so the row keeps its identity.
    const map = record(listed);
    if (map) return Object.entries(map).map(([key, value]) => ({ sessionKey: key, ...(record(value) ?? {}) }));
    return undefined;
  })();

  if (rows === undefined) {
    const single = envelope ? projectUsageRow(envelope, options) : undefined;
    return single ? { writes: [single], dropped: 0 } : { writes: [], dropped: envelope ? 1 : 0 };
  }

  const writes: UsageWrite[] = [];
  let dropped = 0;
  for (const entry of rows) {
    const write = projectUsageRow(entry, options);
    if (write) writes.push(write);
    else dropped += 1;
  }
  return { writes, dropped };
}
