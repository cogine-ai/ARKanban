/**
 * Probes Gateway methods that are callable but absent from
 * `hello-ok.features.methods`.
 *
 * The v1 preflight assumed advertisement implies availability and, more
 * damagingly, that absence implies unavailability. The OpenClaw protocol
 * documentation contradicts the second half: the discovery list is deliberately
 * conservative and omits `sessions.usage` among others. Detecting those requires
 * one read-only call whose failure mode is then classified.
 */

export type CapabilityState = "unknown" | "live" | "unavailable" | "unauthorized" | "error";

/** Methods that must be probed because discovery will never mention them. */
export const NON_DISCOVERABLE_METHODS = [
  "sessions.usage",
  "sessions.usage.timeseries",
  "usage.cost",
] as const;

export type NonDiscoverableMethod = (typeof NON_DISCOVERABLE_METHODS)[number];

/**
 * Classifies a failed probe.
 *
 * The distinction matters operationally: `unavailable` and `unauthorized` are
 * permanent for this connection and must stop further calls, while `error` is
 * transient and should be retried on the next reconcile. Collapsing them would
 * either hammer a Gateway that will never answer, or give up on one that was
 * only briefly unhealthy.
 */
export function classifyProbeFailure(error: unknown): Exclude<CapabilityState, "unknown" | "live"> {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("method_not_found") || message.includes("unknown method") || message.includes("not found")) {
    return "unavailable";
  }
  if (
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("scope") ||
    message.includes("permission")
  ) {
    return "unauthorized";
  }
  return "error";
}

/** Minimal read-only arguments; a probe must never have side effects. */
const PROBE_PARAMS: Record<NonDiscoverableMethod, Record<string, unknown>> = {
  "sessions.usage": { limit: 1 },
  "sessions.usage.timeseries": { limit: 1 },
  "usage.cost": { limit: 1 },
};

export type ProbeCaller = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Results are tied to a connection generation. A reconnect may reach a different
 * Gateway build with a different method set, so cached verdicts must not survive
 * it.
 */
export class CapabilityRegistry {
  private states = new Map<string, CapabilityState>();
  private generation = 0;

  get currentGeneration(): number {
    return this.generation;
  }

  /** Discards every cached verdict; call on each successful (re)connect. */
  newGeneration(): void {
    this.generation += 1;
    this.states.clear();
  }

  stateOf(method: string): CapabilityState {
    return this.states.get(method) ?? "unknown";
  }

  /** True when the verdict is settled and further calls would be pointless. */
  isSettledUnavailable(method: string): boolean {
    const state = this.stateOf(method);
    return state === "unavailable" || state === "unauthorized";
  }

  snapshot(): Record<string, CapabilityState> {
    return Object.fromEntries(NON_DISCOVERABLE_METHODS.map((method) => [method, this.stateOf(method)]));
  }

  /**
   * Probes every method whose verdict is not already settled. `error` results are
   * retried on later passes; `unavailable` and `unauthorized` are not.
   */
  async probeAll(call: ProbeCaller): Promise<Record<string, CapabilityState>> {
    for (const method of NON_DISCOVERABLE_METHODS) {
      if (this.isSettledUnavailable(method) || this.stateOf(method) === "live") continue;
      try {
        await call(method, PROBE_PARAMS[method]);
        this.states.set(method, "live");
      } catch (error) {
        this.states.set(method, classifyProbeFailure(error));
      }
    }
    return this.snapshot();
  }
}
