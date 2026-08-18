import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentOverview } from "../../../src/contracts";
import { collectorApi } from "../api";
import { useCollector } from "./collector-context";

/**
 * Agent roster with its overview aggregates.
 *
 * Fetched here rather than in the collector context so the live board never
 * pulls a roster it does not display. Four topics move these numbers:
 * `agents` changes the roster, `sessions` changes the per-agent session counts,
 * `activities` changes the 24h/7d rollups, and `usage` changes the cost.
 */
export function useAgents(): {
  agents?: AgentOverview[];
  error?: string;
  reload: () => Promise<void>;
} {
  const { subscribeTopics } = useCollector();
  const [agents, setAgents] = useState<AgentOverview[]>();
  const [error, setError] = useState<string>();

  // Those four topics can fire faster than the roster comes back, and only the
  // newest answer may be written: an earlier one landing later would put stale
  // rollups on the cards, or revive an error the retry had already cleared.
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const requested = (generation.current += 1);
    try {
      const response = await collectorApi.agents();
      if (requested !== generation.current) return;
      setAgents(response.agents);
      setError(undefined);
    } catch (cause) {
      if (requested !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
    return subscribeTopics(["agents", "sessions", "activities", "usage"], () => void reload());
  }, [reload, subscribeTopics]);

  return { agents, error, reload };
}
