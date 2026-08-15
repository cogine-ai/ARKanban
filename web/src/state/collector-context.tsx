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
};

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

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 90);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/v1/events");
    events.addEventListener("status", (event) => {
      try {
        setStatus(JSON.parse((event as MessageEvent<string>).data) as CollectorStatus);
      } catch {
        scheduleRefresh();
      }
    });
    events.addEventListener("invalidate", scheduleRefresh);
    events.onerror = () => setError("Live updates disconnected; retrying automatically");
    return () => {
      events.close();
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
    };
  }, [refresh, scheduleRefresh]);

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
    }),
    [status, snapshot, settled, error, range, refresh],
  );

  return <CollectorContext.Provider value={value}>{children}</CollectorContext.Provider>;
}

export function useCollector(): CollectorContextValue {
  const value = useContext(CollectorContext);
  if (!value) throw new Error("useCollector must be used inside CollectorProvider");
  return value;
}
