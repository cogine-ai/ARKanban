import type { DatabaseSync } from "node:sqlite";
import type { AgentRollupWindow, SessionUsage, UsageTotals } from "../contracts.js";

/**
 * Token and cost accounting for sessions.
 *
 * Snapshots are cumulative readings, not deltas: the Gateway reports a
 * session's running totals, so the newest row per session is the truth and
 * older rows exist only to show change over time. Summing raw snapshots would
 * therefore multiply-count, which is why every aggregate here starts from the
 * latest row per session.
 */

export const USAGE_ROLLUP_WINDOW_MS: Record<AgentRollupWindow, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
};

export const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Snapshots stay raw for a week so the Agents card's 7d window always reads
 * real observations, then fold into daily rows.
 */
export const USAGE_ROLLUP_AFTER_DAYS = 7;

export type UsageWrite = Omit<SessionUsage, "unpricedModels"> & { unpricedModels: string[] };

/** A session the usage loop should refresh, and why it was chosen. */
export type UsageCandidate = {
  sessionKey: string;
  reason: "active" | "recent" | "stale";
};

type Row = Record<string, unknown>;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseModels(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** One model keeps its name; several collapse to a combined key, never split. */
function modelLabel(models: string[]): string {
  if (models.length === 0) return "unknown";
  return models.length === 1 ? models[0]! : [...models].sort().join("+");
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    hasCost: true,
    sessionCount: 0,
    unpricedModels: [],
  };
}

/**
 * A reading's total tokens, which is what the high-water gate in `record`
 * compares so a cumulative figure cannot be replaced by a lower one.
 */
function readingTotal(row: Row): number {
  return (
    Number(row.input_tokens ?? 0) +
    Number(row.output_tokens ?? 0) +
    Number(row.cache_read_tokens ?? 0) +
    Number(row.cache_write_tokens ?? 0)
  );
}

function writeTotal(write: UsageWrite): number {
  return write.inputTokens + write.outputTokens + write.cacheReadTokens + write.cacheWriteTokens;
}

/**
 * The cost to store for a reading, which is never less than the cost already
 * recorded for that session.
 *
 * Cost is cumulative like the token counts, but it can regress on its own: the
 * same counts can come back with the price missing, and a token-only comparison
 * would let that through and turn a measured cost into $0.00. Dropping such a
 * reading is not right either — it may be the one reporting a model the Gateway
 * could not price, and that has to reach `hasCost`. So the reading is stored
 * with its own completeness, floored at the price already known.
 */
function costFloor(write: UsageWrite, previous: Row | undefined): number | undefined {
  const recorded = previous ? asNumber(previous.cost_micro_usd) : undefined;
  if (recorded === undefined) return write.costMicroUsd;
  return Math.max(write.costMicroUsd ?? 0, recorded);
}

/**
 * How much of a session's cumulative reading has already been folded into the
 * daily rollup. Kept per session so a later day contributes only its own
 * increment, and so the still-raw snapshot can be reduced by the same amount
 * instead of being counted a second time.
 */
type FoldWatermark = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
  /** The day bucket that counted this session, absent until it is first folded. */
  firstDay?: number;
};

const EMPTY_WATERMARK: FoldWatermark = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function readingWatermark(row: Row): FoldWatermark {
  const cost = asNumber(row.cost_micro_usd);
  const firstDay = asNumber(row.first_day);
  return {
    input: Number(row.input_tokens ?? 0),
    output: Number(row.output_tokens ?? 0),
    cacheRead: Number(row.cache_read_tokens ?? 0),
    cacheWrite: Number(row.cache_write_tokens ?? 0),
    ...(cost !== undefined ? { cost } : {}),
    ...(firstDay !== undefined ? { firstDay } : {}),
  };
}

/**
 * Never negative: a reading below the watermark means the session's accounting
 * restarted, and a negative increment would subtract spend that did happen.
 */
function increment(reading: number, folded: number): number {
  return Math.max(0, reading - folded);
}

/**
 * The part of a cumulative reading that is not already in the daily rollup.
 *
 * `counted` says whether the rollup rows inside the range being summarised have
 * already counted this session, in which case the raw row contributes its
 * remaining tokens but not a second session.
 */
function netOfFold(row: Row, folded: FoldWatermark | undefined, counted: boolean): Row {
  if (!folded) return row;
  const reading = readingWatermark(row);
  const cost = reading.cost === undefined ? undefined : increment(reading.cost, folded.cost ?? 0);
  return {
    ...row,
    input_tokens: increment(reading.input, folded.input),
    output_tokens: increment(reading.output, folded.output),
    cache_read_tokens: increment(reading.cacheRead, folded.cacheRead),
    cache_write_tokens: increment(reading.cacheWrite, folded.cacheWrite),
    cost_micro_usd: cost ?? null,
    session_count: counted ? 0 : 1,
  };
}

/**
 * Folds one row into a running total.
 *
 * `hasCost` is sticky-false: once any contributor is unpriced the sum can only
 * be a lower bound, and reporting it as complete would understate spend
 * silently. Callers decide whether a row was priced, because the raw snapshot
 * table records that as a flag while the rollup table can only express it as a
 * missing cost.
 */
function accumulate(totals: UsageTotals, row: Row, priced: boolean, unpricedModels: Iterable<string>): void {
  totals.inputTokens += Number(row.input_tokens ?? 0);
  totals.outputTokens += Number(row.output_tokens ?? 0);
  totals.cacheReadTokens += Number(row.cache_read_tokens ?? 0);
  totals.cacheWriteTokens += Number(row.cache_write_tokens ?? 0);
  totals.sessionCount += Number(row.session_count ?? 1);
  const cost = asNumber(row.cost_micro_usd);
  if (cost !== undefined) totals.costMicroUsd = (totals.costMicroUsd ?? 0) + cost;
  if (!priced) totals.hasCost = false;
  for (const model of unpricedModels) {
    if (!totals.unpricedModels.includes(model)) totals.unpricedModels.push(model);
  }
}

export class UsageStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Records a reading, unless it would move a session's cumulative total
   * backwards.
   *
   * The newest row per session is what every aggregate reads, so a reading that
   * came back smaller than the last one would replace a measured total with a
   * lower claim about spend. A cumulative figure cannot shrink, so the lower
   * reading is the worse measurement and is dropped — which is the guard against
   * a Gateway whose usage cache answers with zeros for a session it has already
   * measured.
   *
   * The cost is that a genuine reset — a session whose accounting really does
   * restart — leaves the high-water mark in place until it is exceeded.
   * `groupBy: "family"` keeps transcript rotation from causing one, and holding a
   * total that is too high is the safer failure on a view about money.
   *
   * Cost is floored the same way but without dropping the row, because a reading
   * that lost its price may be the one reporting an unpriced model; see
   * `costFloor`.
   *
   * Re-observing a session within the same millisecond replaces the row rather
   * than failing, since the second read is the better one and the primary key
   * cannot hold both.
   */
  record(writes: UsageWrite[]): number {
    if (writes.length === 0) return 0;
    const statement = this.db.prepare(`
      INSERT INTO session_usage_snapshots (
        session_key, observed_at, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, peak_context_tokens, cost_micro_usd, has_cost, models_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_key, observed_at) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        peak_context_tokens = excluded.peak_context_tokens,
        cost_micro_usd = excluded.cost_micro_usd,
        has_cost = excluded.has_cost,
        models_json = excluded.models_json
    `);
    const highWater = this.db.prepare(`
      SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd
      FROM session_usage_snapshots WHERE session_key = ? ORDER BY observed_at DESC LIMIT 1
    `);
    let written = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        const previous = highWater.get(write.sessionKey) as Row | undefined;
        if (previous && writeTotal(write) < readingTotal(previous)) continue;
        statement.run(
          write.sessionKey,
          write.observedAt,
          write.inputTokens,
          write.outputTokens,
          write.cacheReadTokens,
          write.cacheWriteTokens,
          write.peakContextTokens ?? null,
          costFloor(write, previous) ?? null,
          write.hasCost ? 1 : 0,
          JSON.stringify([...new Set([...write.models, ...write.unpricedModels])]),
        );
        written += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return written;
  }

  latest(sessionKey: string): SessionUsage | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_usage_snapshots WHERE session_key = ? ORDER BY observed_at DESC LIMIT 1")
      .get(sessionKey) as Row | undefined;
    if (!row) return undefined;
    const models = parseModels(row.models_json);
    return {
      sessionKey,
      observedAt: Number(row.observed_at),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      ...(asNumber(row.peak_context_tokens) !== undefined
        ? { peakContextTokens: asNumber(row.peak_context_tokens) }
        : {}),
      ...(asNumber(row.cost_micro_usd) !== undefined ? { costMicroUsd: asNumber(row.cost_micro_usd) } : {}),
      hasCost: Number(row.has_cost) === 1,
      models,
      unpricedModels: Number(row.has_cost) === 1 ? [] : models,
    };
  }

  /**
   * Sessions worth re-reading this round, in priority order.
   *
   * Running sessions first, then anything touched recently, then a small
   * allowance for sessions nobody has measured in hours. The stale allowance is
   * capped separately so a long tail of idle sessions cannot crowd out the
   * active ones the user is actually watching.
   */
  candidates(options: {
    now: number;
    recentWindowMs: number;
    staleAfterMs: number;
    staleLimit: number;
    limit: number;
  }): { candidates: UsageCandidate[]; demand: number } {
    const rows = this.db
      .prepare(`
        SELECT s.session_key,
               s.has_active_run,
               s.last_activity_at,
               (SELECT MAX(observed_at) FROM session_usage_snapshots u WHERE u.session_key = s.session_key) AS observed
        FROM sessions s
        WHERE s.archived = 0
        ORDER BY s.has_active_run DESC, s.last_activity_at DESC
      `)
      .all() as Row[];

    const picked: UsageCandidate[] = [];
    const stale: UsageCandidate[] = [];
    for (const row of rows) {
      const sessionKey = String(row.session_key);
      const observed = asNumber(row.observed);
      if (Number(row.has_active_run) === 1) picked.push({ sessionKey, reason: "active" });
      else if (Number(row.last_activity_at) >= options.now - options.recentWindowMs) {
        picked.push({ sessionKey, reason: "recent" });
      } else if (observed === undefined || observed <= options.now - options.staleAfterMs) {
        stale.push({ sessionKey, reason: "stale" });
      }
    }

    const wanted = [...picked, ...stale.slice(0, options.staleLimit)];
    // `demand` is what the rules asked for before the round ceiling applied; the
    // caller needs it to decide between `live` and `snapshot` coverage.
    return { candidates: wanted.slice(0, options.limit), demand: wanted.length };
  }

  /**
   * Per-agent totals for the windows the Agents card shows.
   *
   * Reads the newest snapshot per session rather than summing every snapshot,
   * because snapshots are cumulative.
   */
  agentWindows(
    agentIds: string[],
    rangeEnd: number,
  ): Map<string, Record<AgentRollupWindow, UsageTotals>> {
    const result = new Map<string, Record<AgentRollupWindow, UsageTotals>>();
    for (const agentId of agentIds) {
      result.set(agentId, { "24h": emptyTotals(), "7d": emptyTotals() });
    }
    if (agentIds.length === 0) return result;

    const rows = this.db
      .prepare(`
        SELECT s.agent_id AS agent_id, u.*
        FROM sessions s
        JOIN session_usage_snapshots u ON u.session_key = s.session_key
        WHERE u.observed_at = (
          SELECT MAX(observed_at) FROM session_usage_snapshots x WHERE x.session_key = s.session_key
        )
      `)
      .all() as Row[];

    for (const row of rows) {
      const windows = result.get(String(row.agent_id));
      if (!windows) continue;
      const observedAt = Number(row.observed_at);
      const models = parseModels(row.models_json);
      const priced = Number(row.has_cost) === 1;
      for (const window of ["24h", "7d"] as const) {
        if (observedAt < rangeEnd - USAGE_ROLLUP_WINDOW_MS[window]) continue;
        accumulate(windows[window], row, priced, priced ? [] : models);
      }
    }
    return result;
  }

  /**
   * Range summary combining still-raw snapshots with anything already folded
   * into the daily rollup, so a range crossing the rollup horizon does not
   * report a cliff where the raw rows were pruned.
   */
  summary(from: number, to: number): { totals: UsageTotals; byAgent: Map<string, UsageTotals>; byModel: Map<string, UsageTotals> } {
    const totals = emptyTotals();
    const byAgent = new Map<string, UsageTotals>();
    const byModel = new Map<string, UsageTotals>();

    const forAgent = (agentId: string): UsageTotals => {
      const existing = byAgent.get(agentId);
      if (existing) return existing;
      const created = emptyTotals();
      byAgent.set(agentId, created);
      return created;
    };
    const forModel = (model: string): UsageTotals => {
      const existing = byModel.get(model);
      if (existing) return existing;
      const created = emptyTotals();
      byModel.set(model, created);
      return created;
    };

    const snapshots = this.db
      .prepare(`
        SELECT s.agent_id AS agent_id, u.*
        FROM sessions s
        JOIN session_usage_snapshots u ON u.session_key = s.session_key
        WHERE u.observed_at BETWEEN ? AND ?
          AND u.observed_at = (
            SELECT MAX(observed_at) FROM session_usage_snapshots x
            WHERE x.session_key = s.session_key AND x.observed_at BETWEEN ? AND ?
          )
      `)
      .all(from, to, from, to) as Row[];

    const fromDay = Math.floor(from / DAY_MS) * DAY_MS;
    const folded = this.foldWatermarks();
    for (const row of snapshots) {
      const models = parseModels(row.models_json);
      const priced = Number(row.has_cost) === 1;
      const unpriced = priced ? [] : models;
      // A session whose earlier days are already in the rollup is still holding a
      // cumulative reading here, so the folded part is subtracted rather than
      // counted for a second time under the raw side.
      const watermark = folded.get(String(row.session_key));
      const firstDay = watermark?.firstDay;
      const counted = firstDay !== undefined && firstDay >= fromDay && firstDay <= to;
      const remainder = netOfFold(row, watermark, counted);
      accumulate(totals, remainder, priced, unpriced);
      accumulate(forAgent(String(row.agent_id)), remainder, priced, unpriced);
      // A session may span models, and splitting its total between them is not
      // possible from a cumulative reading. Multi-model sessions are therefore
      // reported under a combined label rather than double counted.
      accumulate(forModel(modelLabel(models)), remainder, priced, unpriced);
    }

    const rolled = this.db
      .prepare("SELECT * FROM usage_daily_rollup WHERE day BETWEEN ? AND ?")
      .all(fromDay, to) as Row[];
    for (const row of rolled) {
      const model = String(row.model);
      // The rollup table has no priced flag, so a missing cost is the only
      // remaining signal that the bucket was never priced.
      const priced = asNumber(row.cost_micro_usd) !== undefined;
      const unpriced = priced ? [] : [model];
      accumulate(totals, row, priced, unpriced);
      accumulate(forAgent(String(row.agent_id)), row, priced, unpriced);
      accumulate(forModel(model), row, priced, unpriced);
    }

    return { totals, byAgent, byModel };
  }

  /**
   * Folds snapshots older than the cutoff into per-day rows and deletes them.
   *
   * The rollup holds each day's **increment**, not the cumulative reading taken
   * that day. Storing the reading and summing days would count a long-running
   * session once per day it survived: 100 tokens on Monday and 300 cumulative on
   * Tuesday is 300 spent, not 400. Each day therefore contributes the reading
   * minus what has already been folded for that session, tracked in
   * `usage_rollup_watermark` because the earlier snapshots are gone by then.
   *
   * Only whole days are folded, so a day is written exactly once and the replace
   * semantics below stay idempotent.
   */
  rollupOlderThan(cutoff: number): { days: number; snapshots: number } {
    const foldBefore = Math.floor(cutoff / DAY_MS) * DAY_MS;
    const rows = this.db
      .prepare(`
        SELECT (u.observed_at / ${DAY_MS}) * ${DAY_MS} AS day,
               s.agent_id AS agent_id,
               u.models_json,
               u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
               u.cost_micro_usd, u.has_cost, u.session_key
        FROM session_usage_snapshots u
        JOIN sessions s ON s.session_key = u.session_key
        WHERE u.observed_at < ?
          AND u.observed_at = (
            SELECT MAX(observed_at) FROM session_usage_snapshots x
            WHERE x.session_key = u.session_key
              AND (x.observed_at / ${DAY_MS}) = (u.observed_at / ${DAY_MS})
          )
        ORDER BY day ASC
      `)
      .all(foldBefore) as Row[];

    type Bucket = {
      day: number;
      agentId: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost?: number;
      hasCost: boolean;
      sessions: Set<string>;
    };
    const folded = this.foldWatermarks();
    const buckets = new Map<string, Bucket>();
    const advanced = new Map<string, FoldWatermark>();
    for (const row of rows) {
      const model = modelLabel(parseModels(row.models_json));
      const day = Number(row.day);
      const agentId = String(row.agent_id);
      const sessionKey = String(row.session_key);
      const id = `${day}\u0000${agentId}\u0000${model}`;
      const bucket = buckets.get(id) ?? {
        day,
        agentId,
        model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        hasCost: true,
        sessions: new Set<string>(),
      };
      // Rows arrive oldest day first, so the previous day's reading for this
      // session is already the watermark by the time the next one is folded.
      const previous = advanced.get(sessionKey) ?? folded.get(sessionKey) ?? EMPTY_WATERMARK;
      const reading = readingWatermark(row);

      const added = {
        input: increment(reading.input, previous.input),
        output: increment(reading.output, previous.output),
        cacheRead: increment(reading.cacheRead, previous.cacheRead),
        cacheWrite: increment(reading.cacheWrite, previous.cacheWrite),
        cost: reading.cost === undefined ? 0 : increment(reading.cost, previous.cost ?? 0),
      };
      // A reading that adds nothing beyond what is already folded — the same
      // snapshot observed again — must not reach the bucket at all, or it would
      // count the session a second time in `session_count`.
      const contributes = Object.values(added).some((value) => value > 0);
      // The watermark only ever rises. A reading that came back lower would
      // otherwise lower the base the next day is measured against, and that day
      // would fold the difference a second time.
      advanced.set(sessionKey, {
        input: Math.max(reading.input, previous.input),
        output: Math.max(reading.output, previous.output),
        cacheRead: Math.max(reading.cacheRead, previous.cacheRead),
        cacheWrite: Math.max(reading.cacheWrite, previous.cacheWrite),
        ...(reading.cost !== undefined || previous.cost !== undefined
          ? { cost: Math.max(reading.cost ?? 0, previous.cost ?? 0) }
          : {}),
        ...(previous.firstDay !== undefined
          ? { firstDay: previous.firstDay }
          : contributes
            ? { firstDay: day }
            : {}),
      });
      if (!contributes) continue;

      bucket.input += added.input;
      bucket.output += added.output;
      bucket.cacheRead += added.cacheRead;
      bucket.cacheWrite += added.cacheWrite;
      if (reading.cost !== undefined) bucket.cost = (bucket.cost ?? 0) + added.cost;
      if (Number(row.has_cost) !== 1) bucket.hasCost = false;
      // Counted on the first day it is folded and never again, so summing the
      // days of a session that lived across several reports one session.
      if (previous.firstDay === undefined) bucket.sessions.add(sessionKey);
      buckets.set(id, bucket);
    }

    const upsert = this.db.prepare(`
      INSERT INTO usage_daily_rollup (
        day, agent_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_micro_usd, session_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      -- Increments add. A day is normally folded in one pass, but a session that
      -- reports again for an already-folded day brings only what is new, and
      -- replacing the row would drop everything folded before it.
      ON CONFLICT (day, agent_id, model) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        cost_micro_usd = CASE
          WHEN excluded.cost_micro_usd IS NULL THEN cost_micro_usd
          ELSE COALESCE(cost_micro_usd, 0) + excluded.cost_micro_usd
        END,
        session_count = session_count + excluded.session_count
    `);
    const markFolded = this.db.prepare(`
      INSERT INTO usage_rollup_watermark (
        session_key, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd,
        first_day
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_key) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        cost_micro_usd = COALESCE(excluded.cost_micro_usd, usage_rollup_watermark.cost_micro_usd),
        -- The day that counted the session is decided once. Later folds move the
        -- token watermark, they do not move where the session was counted.
        first_day = COALESCE(usage_rollup_watermark.first_day, excluded.first_day)
    `);
    let snapshots = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const bucket of buckets.values()) {
        upsert.run(
          bucket.day,
          bucket.agentId,
          bucket.model,
          bucket.input,
          bucket.output,
          bucket.cacheRead,
          bucket.cacheWrite,
          bucket.cost ?? null,
          bucket.sessions.size,
        );
      }
      for (const [sessionKey, reading] of advanced) {
        markFolded.run(
          sessionKey,
          reading.input,
          reading.output,
          reading.cacheRead,
          reading.cacheWrite,
          reading.cost ?? null,
          reading.firstDay ?? null,
        );
      }
      snapshots = Number(
        this.db.prepare("DELETE FROM session_usage_snapshots WHERE observed_at < ?").run(foldBefore).changes,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { days: buckets.size, snapshots };
  }

  private foldWatermarks(): Map<string, FoldWatermark> {
    const rows = this.db.prepare("SELECT * FROM usage_rollup_watermark").all() as Row[];
    return new Map(rows.map((row) => [String(row.session_key), readingWatermark(row)]));
  }

  pruneSnapshots(cutoff: number): number {
    return Number(
      this.db.prepare("DELETE FROM session_usage_snapshots WHERE observed_at < ?").run(cutoff).changes,
    );
  }
}
