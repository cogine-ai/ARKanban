import { useCallback, useEffect, useState } from "react";
import type { AgentOverview } from "../../../src/contracts";
import { collectorApi } from "../api";
import { useCollector } from "./collector-context";

/**
 * Agent roster with its overview aggregates.
 *
 * Fetched here rather than in the collector context so the live board never
 * pulls a roster it does not display. Three topics move these numbers:
 * `agents` changes the roster, `sessions` changes the per-agent session counts,
 * and `activities` changes the 24h/7d rollups.
 */
export function useAgents(): {
  agents?: AgentOverview[];
  error?: string;
  reload: () => Promise<void>;
} {
  const { subscribeTopics } = useCollector();
  const [agents, setAgents] = useState<AgentOverview[]>();
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const response = await collectorApi.agents();
      setAgents(response.agents);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
    return subscribeTopics(["agents", "sessions", "activities"], () => void reload());
  }, [reload, subscribeTopics]);

  return { agents, error, reload };
}
