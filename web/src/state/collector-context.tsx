import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ActivitySnapshot,
  ChangeTopic,
  CollectorChange,
  CollectorStatus,
  SettledGroupSnapshot,
  SettledRange,
} from "../../../src/contracts";
import { collectorApi } from "../api";
import { initialSettledRange, RANGE_STORAGE_KEY } from "../lib/settled-range";

/**
 * Single source of collector data for the whole app.
 *
 * Held in context rather than in the root component because the views that read
 * it are about to be split across routes, and prop-drilling status and snapshot
 * through a router would put a copy of the plumbing in every page. There is
 * still exactly one subscription: the provider mounts once, above the views.
 *
 * `range` lives here too — `settled` is fetched per range, so the two cannot be
 * owned separately without the fetch and the selector drifting apart.
 */
export type CollectorContextValue = {
  status?: CollectorStatus;
  snapshot?: ActivitySnapshot;
  settled?: SettledGroupSnapshot;
  error?: string;
  range: SettledRange;
  setRange: (range: SettledRange) => void;
  refresh: () => Promise<void>;
  /**
   * Notifies when the server reports a change touching any of `topics`.
   *
   * Lets a page refetch only its own resource: the agent roster changing must
   * not drag the whole activity snapshot down the wire, and the live board must
   * not refetch the roster it never displays.
   */
  subscribeTopics: (topics: readonly ChangeTopic[], listener: () => void) => () => void;
};

const ALL_TOPICS: ChangeTopic[] = ["activities", "sessions", "usage", "agents"];

const CollectorContext = createContext<CollectorContextValue | undefined>(undefined);

export function CollectorProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<SettledRange>(initialSettledRange);
  const [status, setStatus] = useState<CollectorStatus>();
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const [settled, setSettled] = useState<SettledGroupSnapshot>();
  const [error, setError] = useState<string>();
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextSnapshot, nextSettled] = await Promise.all([
        collectorApi.status(),
        collectorApi.snapshot(),
        collectorApi.settledGroups(range),
      ]);
      setStatus(nextStatus);
      setSnapshot(nextSnapshot);
      setSettled(nextSettled);
      setError(undefined);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, [range]);

  // Held in a ref so that invalidation, and the event stream that drives it, do
  // not have to be rebuilt when `refresh` changes with the range. Reconnecting the
  // stream to change a date range would drop the changes arriving in between.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const topicListeners = useRef(new Set<{ topics: readonly ChangeTopic[]; listener: () => void }>());
  const pendingTopics = useRef(new Set<ChangeTopic>());

  const subscribeTopics = useCallback((topics: readonly ChangeTopic[], listener: () => void) => {
    const entry = { topics, listener };
    topicListeners.current.add(entry);
    return () => {
      topicListeners.current.delete(entry);
    };
  }, []);

  const flushInvalidation = useCallback(() => {
    const topics = new Set(pendingTopics.current);
    pendingTopics.current.clear();
    if (topics.has("activities")) void refreshRef.current();
    for (const entry of topicListeners.current) {
      if (entry.topics.some((topic) => topics.has(topic))) entry.listener();
    }
  }, []);

  const scheduleInvalidation = useCallback(
    (topics: readonly ChangeTopic[]) => {
      for (const topic of topics) pendingTopics.current.add(topic);
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(flushInvalidation, 90);
    },
    [flushInvalidation],
  );

  // Refetching for a new range is separate from the stream's lifetime.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const events = new EventSource("/api/v1/events");
    events.addEventListener("status", (event) => {
      try {
        setStatus(JSON.parse((event as MessageEvent<string>).data) as CollectorStatus);
      } catch {
        scheduleInvalidation(ALL_TOPICS);
      }
    });
    events.addEventListener("invalidate", (event) => {
      try {
        const change = JSON.parse((event as MessageEvent<string>).data) as CollectorChange;
        // A server that cannot say what changed is treated as changing
        // everything, so an older collector degrades to the previous behaviour
        // instead of silently never refreshing.
        scheduleInvalidation(change.topics?.length ? change.topics : ALL_TOPICS);
      } catch {
        scheduleInvalidation(ALL_TOPICS);
      }
    });
    events.onerror = () => setError("Live updates disconnected; retrying automatically");
    return () => {
      events.close();
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
    };
  }, [scheduleInvalidation]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, range);
    } catch {
      // Local preference persistence is best effort.
    }
  }, [range]);

  const value = useMemo<CollectorContextValue>(
    () => ({
      status,
      snapshot,
      // A settled snapshot for the previous range is stale the moment the range
      // changes, so it is withheld rather than shown against the new label.
      settled: settled?.range === range ? settled : undefined,
      error,
      range,
      setRange,
      refresh,
      subscribeTopics,
    }),
    [status, snapshot, settled, error, range, refresh, subscribeTopics],
  );

  return <CollectorContext.Provider value={value}>{children}</CollectorContext.Provider>;
}

export function useCollector(): CollectorContextValue {
  const value = useContext(CollectorContext);
  if (!value) throw new Error("useCollector must be used inside CollectorProvider");
  return value;
}
