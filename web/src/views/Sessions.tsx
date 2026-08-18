import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import type { ChangeTopic, SessionSignalGrade, SessionSummary } from "../../../src/contracts";
import type { SessionSort } from "../../../src/storage/keyset-cursor";
import { collectorApi, type SessionListFilters } from "../api";
import { GradeChip } from "../components/GradeChip";
import { TranscriptSearch } from "../components/TranscriptSearch";
import { AGENT_COLORS } from "../lib/board";
import { formatRelative, hash, shortAgent } from "../lib/format";
import { Link, useLocation, useNavigate } from "../router";
import { useMeasuredHeight } from "../state/use-measured-height";
import { usePagedQuery } from "../state/use-paged-query";

/**
 * Every control writes to the query string rather than to component state, so a
 * filtered list survives a reload and can be handed to someone else as a link.
 * The URL is the only source of truth here; there is no second copy to drift.
 */

const STATES = ["active", "terminal", "archived"] as const;
const GRADES: SessionSignalGrade[] = ["A", "B", "C", "D", "F", "unscored"];
const SORTS: Array<{ value: SessionSort; label: string }> = [
  { value: "lastActivity", label: "Last activity" },
  { value: "grade", label: "Worst grade" },
  { value: "cost", label: "Cost" },
  { value: "duration", label: "Duration" },
];

/** Rows rendered outside the viewport, so scrolling does not expose blank space. */
const OVERSCAN = 8;
const ROW_HEIGHT = 44;
/** Below this, plain rendering is cheaper than the windowing bookkeeping. */
const VIRTUALIZE_ABOVE = 100;
/**
 * Only used until the list has been measured. The height itself belongs to CSS,
 * which can size the list against the window; see `.session-list` for the bounds.
 */
const VIEWPORT_HEIGHT_FALLBACK = 560;

const SESSION_TOPICS: readonly ChangeTopic[] = ["sessions"];
/** How long the typed agent filter waits before it becomes a URL change. */
const FILTER_SETTLE_MS = 250;

/** The query-string keys the list itself depends on; `q` drives the search panel. */
const FILTER_KEYS = ["agentId", "state", "grade", "sort"] as const;

/** A canonical query string of just those keys, so it can be re-parsed as one. */
function filterSignature(params: URLSearchParams): string {
  const filtered = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filtered.set(key, value);
  }
  return filtered.toString();
}

function readFilters(params: URLSearchParams): SessionListFilters {
  const state = params.get("state");
  const grade = params.get("grade");
  const sort = params.get("sort");
  return {
    ...(params.get("agentId") ? { agentId: params.get("agentId")! } : {}),
    ...(state && (STATES as readonly string[]).includes(state) ? { state: state as SessionListFilters["state"] } : {}),
    ...(grade && GRADES.includes(grade as SessionSignalGrade) ? { grade: grade as SessionSignalGrade } : {}),
    ...(sort && SORTS.some((entry) => entry.value === sort) ? { sort: sort as SessionSort } : {}),
  };
}

function SessionRow({ session }: { session: SessionSummary }) {
  const tone = AGENT_COLORS[hash(session.agentId) % AGENT_COLORS.length];
  return (
    <Link className="session-row" to={`/sessions/${encodeURIComponent(session.sessionKey)}`}>
      <span className="session-agent" style={{ background: tone }} title={session.agentId}>
        {shortAgent(session.agentId)}
      </span>
      <span className="session-label">
        <b>{session.label}</b>
        <small>{session.sessionKey}</small>
      </span>
      <GradeChip signals={session.signals} />
      <span className="session-state" data-active={session.hasActiveRun ? "true" : "false"}>
        {session.archived ? "archived" : session.hasActiveRun ? "running" : "idle"}
      </span>
      <span className="session-count">{session.activityCount}</span>
      <span className="session-seen">{formatRelative(session.lastActivityAt)}</span>
    </Link>
  );
}

export function SessionsView() {
  const { searchParams } = useLocation();
  const navigateTo = useNavigate();
  const search = searchParams.toString();

  // Derived from the filter params alone, not the whole query string. Keying on
  // the latter rebuilt this object whenever `q` changed, which restarted the paged
  // query: typing in the transcript search discarded every page the reader had
  // loaded, along with their scroll position.
  const filterKey = filterSignature(searchParams);
  const filters = useMemo(() => readFilters(new URLSearchParams(filterKey)), [filterKey]);
  const fetchPage = useCallback((cursor?: string) => collectorApi.sessions(filters, cursor), [filters]);
  const { items, error, loading, loadingMore, hasMore, hasNewData, loadMore, reload } = usePagedQuery(
    fetchPage,
    SESSION_TOPICS,
  );

  const setParam = useCallback(
    (key: string, value: string | undefined) => {
      const next = new URLSearchParams(search);
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, value);
      const query = next.toString();
      navigateTo(`/sessions${query ? `?${query}` : ""}`);
    },
    [navigateTo, search],
  );

  // The typed controls are held here and settle before they reach the URL.
  // Writing every keystroke would restart the query per character and push a
  // history entry per character with it.
  const [agentDraft, setAgentDraft] = useState(filters.agentId ?? "");
  useEffect(() => setAgentDraft(filters.agentId ?? ""), [filters.agentId]);
  useEffect(() => {
    const settled = agentDraft.trim();
    if (settled === (filters.agentId ?? "")) return;
    const timer = setTimeout(() => setParam("agentId", settled), FILTER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [agentDraft, filters.agentId, setParam]);

  const searchQuery = searchParams.get("q") ?? "";
  const [searchDraft, setSearchDraft] = useState(searchQuery);
  useEffect(() => setSearchDraft(searchQuery), [searchQuery]);
  useEffect(() => {
    const settled = searchDraft.trim();
    if (settled === searchQuery) return;
    const timer = setTimeout(() => setParam("q", settled), FILTER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, searchQuery, setParam]);

  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const virtualized = items.length > VIRTUALIZE_ABOVE;
  const viewportHeight = useMeasuredHeight(viewport, VIEWPORT_HEIGHT_FALLBACK, virtualized);
  const first = virtualized ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const visibleCount = virtualized ? Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2 : items.length;
  const visible = items.slice(first, first + visibleCount);

  return (
    <section className="surface view-surface">
      <div className="view-heading">
        <div><span className="eyebrow">SESSION ARCHIVE</span><h1>Sessions</h1></div>
        <span className="count-chip">
          {items.length} loaded{hasMore ? "+" : ""}
        </span>
      </div>

      <div className="session-filters">
        <label>
          <span className="eyebrow">AGENT</span>
          <input
            type="search"
            value={agentDraft}
            placeholder="All agents"
            onChange={(event) => setAgentDraft(event.target.value)}
          />
        </label>
        <label>
          <span className="eyebrow">STATE</span>
          <select value={filters.state ?? ""} onChange={(event) => setParam("state", event.target.value)}>
            <option value="">Any</option>
            {STATES.map((state) => <option key={state} value={state}>{state}</option>)}
          </select>
        </label>
        <label>
          <span className="eyebrow">GRADE</span>
          <select value={filters.grade ?? ""} onChange={(event) => setParam("grade", event.target.value)}>
            <option value="">Any</option>
            {GRADES.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
          </select>
        </label>
        <label>
          <span className="eyebrow">SORT</span>
          <select value={filters.sort ?? "lastActivity"} onChange={(event) => setParam("sort", event.target.value)}>
            {SORTS.map((sort) => <option key={sort.value} value={sort.value}>{sort.label}</option>)}
          </select>
        </label>
        <label className="session-search">
          <span className="eyebrow">SEARCH TRANSCRIPTS</span>
          <input
            type="search"
            value={searchDraft}
            placeholder="Find text in archived conversations"
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </label>
      </div>

      {/* Searching reads the local archive, so it answers a different question
          from the list below and is shown as its own result set. Narrowing by
          agent also narrows the search, which is what makes a query shorter
          than the trigram index allows servable at all. */}
      <TranscriptSearch query={searchQuery} {...(filters.agentId ? { agentId: filters.agentId } : {})} />

      {error ? <div className="inline-error">{error}</div> : null}

      {/* The list is never reordered underneath the reader. A change upstream
          offers a refresh; taking it is their decision. */}
      {hasNewData ? (
        <button className="session-refresh-hint" onClick={reload}>
          Sessions changed since this list loaded — refresh
        </button>
      ) : null}

      {loading ? <div className="simple-empty">Loading sessions…</div> : null}
      {!loading && items.length === 0 ? (
        <div className="simple-empty">No session matches this filter.</div>
      ) : null}

      {items.length > 0 ? (
        <div
          className="session-list"
          ref={viewport}
          data-virtualized={virtualized ? "true" : "false"}
          {...(virtualized
            ? { onScroll: (event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop) }
            : {})}
        >
          {virtualized ? <div style={{ height: first * ROW_HEIGHT }} aria-hidden="true" /> : null}
          {visible.map((session) => <SessionRow key={session.sessionKey} session={session} />)}
          {virtualized ? (
            <div style={{ height: Math.max(0, (items.length - first - visible.length) * ROW_HEIGHT) }} aria-hidden="true" />
          ) : null}
        </div>
      ) : null}

      {hasMore ? (
        <button className="session-load-more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}
