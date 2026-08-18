import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeTopic } from "../../../src/contracts";
import { useCollector } from "./collector-context";

/**
 * Cursor-paged fetching for lists the collector serves a page at a time.
 *
 * Deliberately different from the snapshot mode the live board uses. A snapshot
 * can be replaced wholesale on every invalidate; an appended page cannot — the
 * rows the reader already scrolled past would reorder underneath them. So an
 * SSE change only raises `hasNewData` here, and refetching is the reader's
 * decision.
 */

export type Page<T> = { items: T[]; nextCursor?: string };

export type PagedQuery<T> = {
  items: T[];
  error?: string;
  /** True during the first load, when there is nothing to show yet. */
  loading: boolean;
  /** True while a further page is being appended. */
  loadingMore: boolean;
  hasMore: boolean;
  /** The server reported matching changes; the list is intentionally not reloaded. */
  hasNewData: boolean;
  loadMore: () => void;
  reload: () => void;
};

export function usePagedQuery<T>(
  fetchPage: (cursor?: string) => Promise<Page<T>>,
  topics: readonly ChangeTopic[],
): PagedQuery<T> {
  const { subscribeTopics } = useCollector();
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNewData, setHasNewData] = useState(false);

  // Guards against a stale page landing after the query changed: filters live in
  // the URL, so a slow first page can resolve after the reader has already
  // narrowed the list, and appending it would show rows that do not match.
  const generation = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(
    async (from: string | undefined, mode: "replace" | "append") => {
      // Only appends are serialised. A replace must never be dropped: filters
      // change faster than a page loads, and skipping the newest query would
      // leave the list showing the previous filter's rows for good.
      if (mode === "append" && inFlight.current) return;
      inFlight.current = true;
      const requested = generation.current;
      if (mode === "append") setLoadingMore(true);
      try {
        const page = await fetchPage(from);
        if (requested !== generation.current) return;
        setItems((previous) => (mode === "append" ? [...previous, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(undefined);
        if (mode === "replace") setHasNewData(false);
      } catch (cause) {
        if (requested !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        // Only the newest request may report that loading finished. A superseded
        // one settling here would clear the spinner while its replacement is still
        // in flight, showing the empty-list state for a list that is about to fill.
        if (requested === generation.current) {
          inFlight.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setCursor(undefined);
    setLoading(true);
    setHasNewData(false);
    void load(undefined, "replace");
  }, [load]);

  useEffect(() => subscribeTopics(topics, () => setHasNewData(true)), [subscribeTopics, topics]);

  const loadMore = useCallback(() => {
    if (cursor === undefined) return;
    void load(cursor, "append");
  }, [cursor, load]);

  const reload = useCallback(() => {
    generation.current += 1;
    void load(undefined, "replace");
  }, [load]);

  return {
    items,
    ...(error !== undefined ? { error } : {}),
    loading,
    loadingMore,
    hasMore: cursor !== undefined,
    hasNewData,
    loadMore,
    reload,
  };
}
