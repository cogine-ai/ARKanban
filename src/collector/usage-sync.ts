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

/** Per-agent cost for one window, as priced by the Gateway. */
export type CostWindows = Record<AgentRollupWindow, Map<string, number>>;

function emptyCostWindows(): CostWindows {
  return { "24h": new Map(), "7d": new Map() };
}

export class UsageSynchronizer {
  private coverage: SessionUsageCoverage = "not_observed";
  private costWindows = emptyCostWindows();
  private costCoverage: SessionUsageCoverage = "not_observed";
  private lastCostAt = 0;

  constructor(private readonly deps: UsageSyncDeps) {}

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

  getCostCoverage(): SessionUsageCoverage {
    return this.costCoverage;
  }

  getCoverage(): SessionUsageCoverage {
    return this.coverage;
  }

  /** Forgets Gateway-priced cost; call when the connection generation changes. */
  resetCost(): void {
    this.costWindows = emptyCostWindows();
    this.costCoverage = "not_observed";
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
    let errorCode: string | undefined;
    const writes: UsageWrite[] = [];

    for (const candidate of candidates) {
      requests += 1;
      try {
        const payload = await this.deps.request("sessions.usage", { sessionKey: candidate.sessionKey });
        const page = projectUsagePage(payload, {
          observedAt: options.now,
          sessionKey: candidate.sessionKey,
          ...(this.deps.inventory ? { inventory: this.deps.inventory } : {}),
        });
        writes.push(...page.writes);
        succeeded += 1;
      } catch (error) {
        errorCode ??= classifyUsageFailure(error);
      }
    }

    if (writes.length > 0) recorded = this.deps.store.record(writes);

    // One flaky session should not repaint the whole cost view as broken, so
    // `error` is reserved for a round where nothing came back at all.
    this.coverage = succeeded === 0 ? "error" : demand > candidates.length ? "snapshot" : "live";

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
      this.costCoverage = "unavailable";
      return false;
    }
    if (options.costState === "unauthorized") {
      this.costCoverage = "unauthorized";
      return false;
    }
    if (options.now - this.lastCostAt < COST_SYNC_MS) return false;
    this.lastCostAt = options.now;

    const next = emptyCostWindows();
    let succeeded = 0;
    for (const window of ["24h", "7d"] as const) {
      try {
        const payload = await this.deps.request("usage.cost", {
          from: options.now - USAGE_ROLLUP_WINDOW_MS[window],
          to: options.now,
          groupBy: "agent",
        });
        next[window] = projectCostReport(
          payload,
          this.deps.costInventory ?? undefined,
        ).byAgent;
        succeeded += 1;
      } catch {
        this.costCoverage = "error";
      }
    }

    if (succeeded === 0) return false;
    this.costWindows = next;
    this.costCoverage = "live";
    return true;
  }
}
