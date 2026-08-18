import { FieldInventory, pick } from "../collector/field-inventory.js";
import type { UsageWrite } from "../storage/usage-store.js";
import { boundedTimestamp } from "./timestamps.js";

/**
 * Projects `sessions.usage` replies into usage writes and per-agent cost.
 *
 * Every field goes through an alias list, so correcting one is a single-line
 * edit — move the real key to the front. The lists have been checked against
 * OpenClaw 2026.7.1-2, where the counts sit one level down in a `usage` object.
 */

/**
 * Token and cost figures live in a nested object, not on the row.
 *
 * A usage row is `{ key, label, agentId, model, usage: { input, output,
 * cacheRead, cacheWrite, totalCost, missingCostEntries, ... } }`. Several alias
 * names below did match the inner object's keys all along, which is why this
 * reads both levels rather than being rewritten to the inner names only.
 */
const USAGE_ENVELOPE_KEY = "usage";

export const USAGE_FIELD_ALIASES = {
  // `key` leads deliberately. `sessionId` used to outrank it, and since rows
  // carry both, usage would have been filed under the transcript generation id
  // instead of the session it belongs to.
  sessionKey: ["key", "sessionKey", "session"],
  inputTokens: ["input", "inputTokens", "promptTokens", "prompt_tokens"],
  outputTokens: ["output", "outputTokens", "completionTokens", "completion_tokens"],
  cacheReadTokens: ["cacheRead", "cacheReadTokens", "cache_read_input_tokens", "cachedTokens"],
  cacheWriteTokens: ["cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens"],
  // No peak-context figure is published. `contextTokens` used to sit in this
  // list and is the model's context *window*, so a 200k budget would have been
  // reported as 200k of context consumed.
  peakContextTokens: ["peakContextTokens", "peakContext"],
  costMicroUsd: ["costMicroUsd", "costMicros", "cost_micro_usd"],
  costUsd: ["totalCost", "costUsd", "cost", "amountUsd"],
  models: ["modelUsage", "models", "model", "modelIds"],
  unpricedModels: ["unpricedModels", "unpriced", "missingPricing"],
  /** Count of entries the Gateway could not price; see `unpricedCount` below. */
  missingCostEntries: ["missingCostEntries"],
  observedAt: ["updatedAt", "observedAt", "ts", "timestamp"],
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
 *
 * A row whose counts are all present and all zero is dropped for the same
 * reason. The endpoint totals a session's own accounting file, and on the
 * calibration machine every session came back with zeros — including one the
 * index priced at $0.034 — because the file recorded no counts. Storing that
 * would assert the session was free, and `hasCost` would have called the
 * assertion complete.
 */
export function projectUsageRow(raw: unknown, options: ProjectUsageOptions): UsageWrite | undefined {
  const row = record(raw);
  if (!row) return undefined;
  options.inventory?.observeRow(row);
  const envelope = record(row[USAGE_ENVELOPE_KEY]);
  const read = (field: UsageField): unknown => {
    const direct = pick(row, field, USAGE_FIELD_ALIASES[field], options.inventory);
    if (direct !== undefined) return direct;
    return envelope ? pick(envelope, field, USAGE_FIELD_ALIASES[field], options.inventory) : undefined;
  };

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
  // 2026.7.1-2 reports how many entries it could not price, without naming the
  // models. That is enough to know the total is a floor, which is what `hasCost`
  // is for; `unpricedModels` stays empty because the names are genuinely not
  // available, and an empty list must not be read as "everything was priced".
  const unpricedCount = asNumber(read("missingCostEntries")) ?? 0;
  // A cost of zero is still a price; only a missing figure or a model the
  // Gateway could not price makes the total a floor.
  const hasCost = costMicroUsd !== undefined && unpricedModels.length === 0 && unpricedCount === 0;

  const peakContextTokens = asNumber(read("peakContextTokens"));
  // Bounded like every other projected time. A reading dated ahead of now is
  // never superseded — the store keeps the newest observation — so one skewed
  // value would freeze this session's usage at that figure for good.
  const observedAt = boundedTimestamp(read("observedAt"), options.observedAt) ?? options.observedAt;

  const tokens = {
    inputTokens: asTokens(inputTokens),
    outputTokens: asTokens(outputTokens),
    cacheReadTokens: asTokens(read("cacheReadTokens")),
    cacheWriteTokens: asTokens(read("cacheWriteTokens")),
  };
  const counted = Object.values(tokens).some((value) => value > 0);
  if (!counted && !(costMicroUsd !== undefined && costMicroUsd > 0)) return undefined;

  return {
    sessionKey,
    observedAt,
    ...tokens,
    ...(peakContextTokens !== undefined && peakContextTokens >= 0
      ? { peakContextTokens: Math.round(peakContextTokens) }
      : {}),
    ...(costMicroUsd !== undefined ? { costMicroUsd } : {}),
    hasCost,
    models,
    unpricedModels,
  };
}

/**
 * The session index's token and cost fields are deliberately not read here.
 *
 * `sessions.list` rows carry `inputTokens`, `outputTokens`, `totalTokens` and
 * `estimatedCostUsd`, and on the calibration machine they were the only figures
 * with any content — the usage endpoint reported zeros for every session. They
 * are still the wrong numbers: the runtime assigns rather than accumulates them,
 * so each one describes the session's *last run*. `estimatedCostUsd` comes from
 * a function named for a run, and `totalTokens` is derived from the last call's
 * usage against the context window, which is why the Gateway's own `/usage`
 * command divides it by `contextTokens` to show a context percentage and reports
 * `input + output` as the total instead.
 *
 * Summed across sessions on an agent card they would read as spend while being
 * one turn's context, so a session whose harness records no usage is reported as
 * `unreported` rather than filled in from here. See
 * docs/v1/real-gateway-field-calibration.md §2.7.
 */

export const COST_FIELD_ALIASES = {
  agentId: ["agentId", "agent", "id", "key", "name"],
  costMicroUsd: ["costMicroUsd", "costMicros", "cost_micro_usd"],
  costUsd: ["totalCost", "costUsd", "cost", "amountUsd", "total"],
  missingCostEntries: ["missingCostEntries"],
} as const satisfies Record<string, readonly string[]>;

export const COST_PAGE_ALIASES = {
  entries: ["byAgent", "agents", "breakdown", "items", "entries", "results", "costs"],
  totalMicroUsd: ["totalMicroUsd", "totalCostMicroUsd"],
  totalUsd: ["totalCost", "totalUsd", "total", "cost"],
  pricedFrom: ["startDate", "from", "rangeStart"],
  pricedTo: ["endDate", "to", "rangeEnd"],
} as const satisfies Record<string, readonly string[]>;

/**
 * The per-agent breakdown and the per-agent amount each sit one level down.
 *
 * A reply is `{ updatedAt, startDate, endDate, sessions, totals, aggregates:
 * { byAgent: [{ agentId, totals: { totalCost, missingCostEntries, ... } }], ... },
 * cacheStatus }`. Both levels are read, so a Gateway that puts the breakdown or
 * the amount on the row still lands.
 */
const COST_AGGREGATE_KEY = "aggregates";
const COST_TOTALS_KEY = "totals";

/**
 * One agent's spend over the requested span.
 *
 * `hasCost` carries the same meaning as it does on a stored reading: false says
 * the amount is a floor, because the Gateway counted entries it could not price.
 * Without it a ranged total would be presented as complete on the strength of
 * having arrived.
 */
export type AgentCostEntry = { costMicroUsd: number; hasCost: boolean };

export type CostReport = {
  byAgent: Map<string, AgentCostEntry>;
  totalMicroUsd?: number;
  /** The calendar span the Gateway actually priced, as it reported it. */
  pricedFrom?: string;
  pricedTo?: string;
};

/**
 * Reads the per-agent breakdown of a ranged `sessions.usage` reply.
 *
 * The Gateway prices work it knows about, which is why its figure takes
 * precedence over one derived from token counts: local pricing would have to
 * guess at rates that change without notice.
 *
 * `usage.cost` used to be the source and cannot be: it takes an agent scope but
 * merges every agent into one total, so the per-agent split exists only here.
 * See docs/v1/real-gateway-field-calibration.md §2.4.
 */
export function projectCostReport(payload: unknown, inventory?: FieldInventory): CostReport {
  const byAgent = new Map<string, AgentCostEntry>();
  const envelope = record(payload);
  if (!envelope) return { byAgent };
  inventory?.observeRow(envelope);
  const aggregates = record(envelope[COST_AGGREGATE_KEY]);
  if (aggregates) inventory?.observeRow(aggregates);

  const listed =
    (aggregates ? pick(aggregates, "entries", COST_PAGE_ALIASES.entries, inventory) : undefined) ??
    pick(envelope, "entries", COST_PAGE_ALIASES.entries, inventory);
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
    const totals = record(row[COST_TOTALS_KEY]);
    if (totals) inventory?.observeRow(totals);
    const read = (field: keyof typeof COST_FIELD_ALIASES): unknown => {
      const direct = pick(row, field, COST_FIELD_ALIASES[field], inventory);
      if (direct !== undefined) return direct;
      return totals ? pick(totals, field, COST_FIELD_ALIASES[field], inventory) : undefined;
    };
    const micros = asNumber(read("costMicroUsd"));
    const dollars = asNumber(read("costUsd"));
    const cost = micros !== undefined ? Math.round(micros) : dollars !== undefined ? toMicroUsd(dollars) : undefined;
    if (cost === undefined) continue;
    const unpriced = asNumber(read("missingCostEntries")) ?? 0;
    const id = agentId.trim();
    const previous = byAgent.get(id);
    // Zero priced against entries it could not price is not an amount. The
    // calibration machine answers exactly this for a week holding 27,844 tokens:
    // `totalCost: 0` with `missingCostEntries: 1`, because the codex harness has
    // no price table. Carried through, the card would read "$0.00+" over a week of
    // real work — the floor marker attached to a figure that measures nothing. The
    // window is left to say it has no price instead.
    if (cost === 0 && unpriced > 0) {
      if (previous) byAgent.set(id, { ...previous, hasCost: false });
      continue;
    }
    byAgent.set(id, {
      costMicroUsd: (previous?.costMicroUsd ?? 0) + cost,
      // One unpriced entry anywhere in the span makes the whole amount a floor.
      hasCost: (previous?.hasCost ?? true) && unpriced === 0,
    });
  }

  const totalMicros = asNumber(pick(envelope, "totalMicroUsd", COST_PAGE_ALIASES.totalMicroUsd, inventory));
  const totalsEnvelope = record(envelope[COST_TOTALS_KEY]);
  const totalDollars = asNumber(
    pick(envelope, "totalUsd", COST_PAGE_ALIASES.totalUsd, inventory) ??
      (totalsEnvelope ? pick(totalsEnvelope, "totalUsd", COST_PAGE_ALIASES.totalUsd, inventory) : undefined),
  );
  const totalMicroUsd =
    totalMicros !== undefined
      ? Math.round(totalMicros)
      : totalDollars !== undefined
        ? toMicroUsd(totalDollars)
        : byAgent.size > 0
          ? [...byAgent.values()].reduce((sum, entry) => sum + entry.costMicroUsd, 0)
          : undefined;

  const pricedFrom = pick(envelope, "pricedFrom", COST_PAGE_ALIASES.pricedFrom, inventory);
  const pricedTo = pick(envelope, "pricedTo", COST_PAGE_ALIASES.pricedTo, inventory);

  return {
    byAgent,
    ...(totalMicroUsd !== undefined ? { totalMicroUsd } : {}),
    ...(typeof pricedFrom === "string" && pricedFrom ? { pricedFrom } : {}),
    ...(typeof pricedTo === "string" && pricedTo ? { pricedTo } : {}),
  };
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
