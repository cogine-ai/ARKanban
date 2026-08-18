import { projectCostReport, projectUsagePage } from "../activity/usage-projector.js";
import type { AgentRollupWindow, SessionUsageCoverage } from "../contracts.js";
import type { FieldInventory } from "./field-inventory.js";
import type { CapabilityState } from "./capability-probe.js";
import { USAGE_ROLLUP_WINDOW_MS, type UsageStore, type UsageWrite } from "../storage/usage-store.js";

/**
 * Token and cost collection.
 *
 * Reads are per session and the round is capped, because polling every session
 * every minute does not survive contact with a few thousand of them. Sessions
 * the user is likely looking at — running, or touched in the last quarter hour
 * — are read first, and a small allowance goes to sessions nobody has measured
 * in hours so the long tail still converges.
 */

export const USAGE_SYNC_MS = 60_000;
/** Pricing moves slowly, and this call covers a whole range rather than a session. */
export const COST_SYNC_MS = 300_000;
export const USAGE_ROUND_LIMIT = 100;
export const USAGE_RECENT_WINDOW_MS = 15 * 60_000;
export const USAGE_STALE_AFTER_MS = 6 * 60 * 60_000;
export const USAGE_STALE_LIMIT = 20;

export type UsageRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type UsageSyncOutcome = {
  requests: number;
  recorded: number;
  sessions: number;
  coverage: SessionUsageCoverage;
  /** Present when the round did nothing, naming the gate that stopped it. */
  skipped?: "not_connected" | "unavailable" | "unauthorized" | "no_candidates";
  /** Set when at least one read failed, even if the round otherwise succeeded. */
  errorCode?: string;
  costRefreshed: boolean;
};

export type UsageSyncDeps = {
  store: UsageStore;
  request: UsageRequest;
  inventory?: FieldInventory;
  costInventory?: FieldInventory;
};

/**
 * Failure codes are a closed set so they can be logged and surfaced without
 * carrying session-specific text.
 */
export function classifyUsageFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("method_not_found") || message.includes("unknown method")) return "unavailable";
  if (message.includes("unauthorized") || message.includes("forbidden") || message.includes("scope")) {
    return "unauthorized";
  }
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  return "error";
}

/**
 * Whether the Gateway's usage cache was still catching up when it answered.
 *
 * A reply carries `cacheStatus: { status, cachedFiles, pendingFiles, staleFiles,
 * refreshedAt }`. It does not explain away an empty reading — the calibration
 * machine reported `fresh` with `staleFiles: 0` while returning zeros for a
 * session that had been running for minutes — but `refreshing` does mean the
 * figures may still arrive, and a session in that state must not be recorded as
 * having no accounting.
 */
function cacheCatchingUp(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const status = (payload as Record<string, unknown>).cacheStatus;
  if (!status || typeof status !== "object") return false;
  const row = status as Record<string, unknown>;
  const stale = typeof row.staleFiles === "number" ? row.staleFiles : 0;
  const pending = typeof row.pendingFiles === "number" ? row.pendingFiles : 0;
  return (typeof row.status === "string" && row.status !== "fresh") || stale > 0 || pending > 0;
}

/** Per-agent cost for one window, as priced by the Gateway. */
export type CostWindows = Record<AgentRollupWindow, Map<string, number>>;

function emptyCostWindows(): CostWindows {
  return { "24h": new Map(), "7d": new Map() };
}

function costCoverageByWindow(state: SessionUsageCoverage): Record<AgentRollupWindow, SessionUsageCoverage> {
  return { "24h": state, "7d": state };
}

export class UsageSynchronizer {
  private coverage: SessionUsageCoverage = "not_observed";
  private costWindows = emptyCostWindows();
  /**
   * Kept per window because the windows are separate requests that fail
   * separately. One collector-wide verdict let a failed 24h call be reported as
   * `live` on the strength of the 7d call that followed it, which is the shape of
   * mistake this whole cost path exists to avoid: a figure presented as priced
   * when nothing priced it.
   */
  private costCoverage = costCoverageByWindow("not_observed");
  private lastCostAt = 0;
  private readonly unreported = new Set<string>();

  constructor(private readonly deps: UsageSyncDeps) {}

  /**
   * Sessions the endpoint answered for and reported no usage.
   *
   * Tracked per session because the round's own coverage is collector-wide: on a
   * Gateway where some harnesses record token counts and others do not, a round
   * is `live` overall while individual sessions have nothing, and those sessions
   * must not read as merely unmeasured. Membership is dropped as soon as a
   * session does report, so a warming cache clears itself.
   */
  unreportedSessions(): string[] {
    return [...this.unreported];
  }

  /**
   * Gateway-priced cost per agent, when `usage.cost` answered.
   *
   * Held in memory rather than stored: it is a five-minute cross-check of a
   * range, so persisting it would create a second, staler cost of record that
   * could disagree with the snapshots after a restart.
   */
  costFor(window: AgentRollupWindow, agentId: string): number | undefined {
    return this.costWindows[window].get(agentId);
  }

  getCostCoverage(window: AgentRollupWindow): SessionUsageCoverage {
    return this.costCoverage[window];
  }

  getCoverage(): SessionUsageCoverage {
    return this.coverage;
  }

  /** Forgets Gateway-priced cost; call when the connection generation changes. */
  resetCost(): void {
    this.costWindows = emptyCostWindows();
    this.costCoverage = costCoverageByWindow("not_observed");
    this.lastCostAt = 0;
  }

  async runOnce(options: {
    now: number;
    connected: boolean;
    usageState: CapabilityState;
    costState: CapabilityState;
  }): Promise<UsageSyncOutcome> {
    const idle: UsageSyncOutcome = {
      requests: 0,
      recorded: 0,
      sessions: 0,
      coverage: this.coverage,
      costRefreshed: false,
    };
    if (!options.connected) return { ...idle, skipped: "not_connected" };
    if (options.usageState === "unavailable") {
      this.coverage = "unavailable";
      return { ...idle, coverage: this.coverage, skipped: "unavailable" };
    }
    if (options.usageState === "unauthorized") {
      this.coverage = "unauthorized";
      return { ...idle, coverage: this.coverage, skipped: "unauthorized" };
    }

    const costRefreshed = await this.refreshCost(options);

    const { candidates, demand } = this.deps.store.candidates({
      now: options.now,
      recentWindowMs: USAGE_RECENT_WINDOW_MS,
      staleAfterMs: USAGE_STALE_AFTER_MS,
      staleLimit: USAGE_STALE_LIMIT,
      limit: USAGE_ROUND_LIMIT,
    });
    if (candidates.length === 0) {
      return { ...idle, coverage: this.coverage, skipped: "no_candidates", costRefreshed };
    }

    let requests = 0;
    let recorded = 0;
    let succeeded = 0;
    let catchingUp = 0;
    let errorCode: string | undefined;
    const writes: UsageWrite[] = [];

    for (const candidate of candidates) {
      requests += 1;
      try {
        // The selector is `key`, and the schema refuses unknown params, so the
        // `sessionKey` this used to send made every call an error.
        //
        // `range: "all"` matters as much as the name. The reply is an aggregate
        // over a date window that defaults to the last 30 days, while the store
        // treats each reading as a lifetime cumulative total. Left at the
        // default, a session's total would shrink as its early days aged out of
        // the window. `groupBy: "family"` then keeps a session whose transcript
        // id has rotated as one logical row, which is how the archive keys it.
        const payload = await this.deps.request("sessions.usage", {
          key: candidate.sessionKey,
          range: "all",
          groupBy: "family",
        });
        const page = projectUsagePage(payload, {
          observedAt: options.now,
          sessionKey: candidate.sessionKey,
          ...(this.deps.inventory ? { inventory: this.deps.inventory } : {}),
        });
        if (page.writes.length > 0) this.unreported.delete(candidate.sessionKey);
        else if (cacheCatchingUp(payload)) catchingUp += 1;
        else this.unreported.add(candidate.sessionKey);
        writes.push(...page.writes);
        succeeded += 1;
      } catch (error) {
        errorCode ??= classifyUsageFailure(error);
      }
    }

    if (writes.length > 0) recorded = this.deps.store.record(writes);

    // One flaky session should not repaint the whole cost view as broken, so
    // `error` is reserved for a round where nothing came back at all.
    //
    // A round can also succeed and yield nothing, which is what the calibration
    // machine did every time: the endpoint answered for every session with every
    // count zero, because it totals a session file the harness never wrote counts
    // into. Calling that `live` would leave a cost view showing $0.00 with no
    // indication that nothing was ever measured.
    this.coverage =
      succeeded === 0
        ? "error"
        : writes.length === 0
          // A round that came back empty only because the cache was still
          // building has not established anything yet.
          ? catchingUp === succeeded
            ? "not_observed"
            : "unreported"
          : demand > candidates.length
            ? "snapshot"
            : "live";

    return {
      requests,
      recorded,
      sessions: writes.length,
      coverage: this.coverage,
      ...(errorCode ? { errorCode } : {}),
      costRefreshed,
    };
  }

  /**
   * Refreshes Gateway-priced cost on its own slower cadence, in a try boundary
   * of its own so a pricing failure cannot stop token collection.
   */
  private async refreshCost(options: { now: number; costState: CapabilityState }): Promise<boolean> {
    if (options.costState === "unavailable") {
      this.costCoverage = costCoverageByWindow("unavailable");
      return false;
    }
    if (options.costState === "unauthorized") {
      this.costCoverage = costCoverageByWindow("unauthorized");
      return false;
    }
    if (options.now - this.lastCostAt < COST_SYNC_MS) return false;
    this.lastCostAt = options.now;

    let succeeded = 0;
    for (const window of ["24h", "7d"] as const) {
      try {
        const payload = await this.deps.request("usage.cost", {
          from: options.now - USAGE_ROLLUP_WINDOW_MS[window],
          to: options.now,
          groupBy: "agent",
        });
        // Each window is replaced only by its own successful answer. Building a
        // fresh pair and swapping both in meant a failed window arrived as an
        // empty map — every price in it silently gone — on the strength of the
        // other window having answered.
        this.costWindows[window] = projectCostReport(payload, this.deps.costInventory ?? undefined).byAgent;
        this.costCoverage[window] = "live";
        succeeded += 1;
      } catch {
        this.costCoverage[window] = "error";
      }
    }

    return succeeded > 0;
  }
}
