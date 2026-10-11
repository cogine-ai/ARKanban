import { useEffect, useMemo, useState } from "react";
import type { ActivityItem, SettledGroupSummary, SettledRange, UpcomingSchedule } from "../../../src/contracts";
import { FlowBoard } from "../components/FlowBoard";
import type { KindFilter } from "../lib/board";
import { formatRelative, statusLabel } from "../lib/format";
import { Link } from "../router";
import { useCollector } from "../state/collector-context";
import "./live-flow.css";

function BoardHealth() {
  const { status, snapshot, live } = useCollector();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const observedAt = snapshot?.sync.lastAuthoritativeSnapshotAt ?? snapshot?.generatedAt;
  const seconds = observedAt ? Math.max(0, Math.floor((now - observedAt) / 1_000)) : undefined;
  const sources = status?.hosts;
  const healthy = sources?.filter((host) => host.reachable && host.gatewayConnected === true).length;
  const partial = sources && healthy !== sources.length;
  const label = live.state === "reconnecting" || live.state === "stopped"
    ? "Updates paused"
    : live.state === "connecting" ? "Connecting" : partial ? "Partial" : statusLabel(status);
  const good = label === "Live";
  return (
    <Link className={`board-health${good ? " is-live" : ""}`} to="/connections" aria-label={`Data sources: ${label}`}>
      <span className="board-health-dot" aria-hidden="true" />
      <b>{label}</b>
      {sources ? <span>{healthy}/{sources.length} sources</span> : null}
      {seconds !== undefined ? <span title={new Date(observedAt!).toLocaleString()}>{seconds < 60 ? `${seconds}s ago` : formatRelative(observedAt)}</span> : null}
    </Link>
  );
}

/**
 * Kind and query are owned by the app shell rather than by this view: the live
 * board unmounts when another view is shown, and operators expect their search
 * text to still be there when they come back.
 */
export function LiveFlowView({
  kind,
  query,
  hostFilter,
  onKindChange,
  onQueryChange,
  onHostFilterChange,
  onRangeChange,
  selectedId,
  selectedSeriesKey,
  onSelectActivity,
  onSelectSeries,
  onSelectOverflow,
  onOpenIncomingOverflow,
}: {
  kind: KindFilter;
  query: string;
  hostFilter: string;
  onKindChange: (kind: KindFilter) => void;
  onQueryChange: (query: string) => void;
  onHostFilterChange: (hostId: string) => void;
  onRangeChange: (range: SettledRange) => void;
  selectedId?: string;
  selectedSeriesKey?: string;
  onSelectActivity: (id: string) => void;
  onSelectSeries: (seriesKey: string) => void;
  onSelectOverflow: (agentId: string, groups: SettledGroupSummary[]) => void;
  onOpenIncomingOverflow: (agentId: string, queued: ActivityItem[], schedules: UpcomingSchedule[]) => void;
}) {
  const { status, snapshot, settled, error, range, refresh, live } = useCollector();

  const hostOptions = useMemo(() => {
    if (status?.hosts && status.hosts.length > 0) {
      return status.hosts.map((host) => ({ id: host.id, label: host.label }));
    }
    if (status?.host) return [{ id: status.host.id, label: status.host.label }];
    const ids = new Set((snapshot?.items ?? []).map((item) => item.hostId).filter(Boolean));
    return [...ids].sort().map((id) => ({ id, label: id }));
  }, [status, snapshot]);

  const visibleOperationalItems = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    return (snapshot?.items ?? []).filter((item) => {
      if (hostFilter !== "all" && item.hostId !== hostFilter) return false;
      if (item.state === "terminal" || item.stage === "settled") return false;
      if (kind !== "all" && item.kind !== kind) return false;
      return !lowered || `${item.title} ${item.agentId} ${item.hostId} ${item.lastToolName ?? ""}`.toLowerCase().includes(lowered);
    });
  }, [snapshot, kind, query, hostFilter]);

  const visibleSchedules = useMemo(() => {
    if (kind !== "all") return [];
    const lowered = query.trim().toLowerCase();
    return (snapshot?.schedule.items ?? []).filter((schedule) => (
      (hostFilter === "all" || schedule.hostId === hostFilter) &&
      (!lowered || `${schedule.title} ${schedule.agentId} ${schedule.hostId}`.toLowerCase().includes(lowered))
    ));
  }, [snapshot, kind, query, hostFilter]);

  const visibleSettled = useMemo(() => {
    if (!settled || hostFilter === "all") return settled;
    const groupsByAgent: typeof settled.groupsByAgent = {};
    const outcomeCounts = { ...settled.outcomeCounts };
    for (const key of Object.keys(outcomeCounts) as Array<keyof typeof outcomeCounts>) outcomeCounts[key] = 0;
    let totalSeries = 0;
    let totalRuns = 0;
    for (const [agentId, groups] of Object.entries(settled.groupsByAgent)) {
      const filtered = groups.filter((group) => group.hostId === hostFilter);
      if (filtered.length === 0) continue;
      groupsByAgent[agentId] = filtered;
      totalSeries += filtered.length;
      for (const group of filtered) {
        totalRuns += group.runCount;
        outcomeCounts.succeeded += group.succeededCount;
        outcomeCounts.failed += group.failedCount;
        outcomeCounts.timed_out += group.timedOutCount;
        outcomeCounts.cancelled += group.cancelledCount;
        outcomeCounts.blocked += group.blockedCount;
        outcomeCounts.unknown += group.unknownCount;
      }
    }
    return { ...settled, groupsByAgent, totalSeries, totalRuns, outcomeCounts };
  }, [settled, hostFilter]);

  return (
    <div className="live-flow-view">
      <section className="live-flow-toolbar">
        <div className="live-flow-title"><h1>Live flow</h1><BoardHealth /></div>
        <div className="filters live-flow-filters">
            <label className="search"><span>⌕</span><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search activity, schedule or series" aria-label="Search board" /></label>
            {hostOptions.length > 0 ? (
              <label className="host-filter">
                <span className="sr-only">Host</span>
                <select value={hostFilter} onChange={(event) => onHostFilterChange(event.target.value)} aria-label="Filter by host">
                  <option value="all">All hosts</option>
                  {hostOptions.map((host) => (
                    <option key={host.id} value={host.id}>{host.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="segmented" aria-label="Activity kind"><button aria-pressed={kind === "all"} onClick={() => onKindChange("all")}>All</button><button aria-pressed={kind === "task"} onClick={() => onKindChange("task")}>Tasks</button><button aria-pressed={kind === "attempt"} onClick={() => onKindChange("attempt")}>Attempts</button></div>
            <button className="refresh-button" onClick={() => void refresh()} aria-label="Refresh snapshots">↻</button>
        </div>
      </section>
      <main className="board-shell">
        {error && live.state === "open" ? <div className="live-flow-error" role="status"><span>{error}</span><button onClick={() => void refresh()}>Refresh</button></div> : null}
        <section className="flow-board" aria-label="Observed activity">
          <FlowBoard
            items={visibleOperationalItems}
            schedules={visibleSchedules}
            scheduleState={snapshot?.schedule}
            settled={visibleSettled}
            range={range}
            kind={kind}
            query={query}
            status={status}
            loading={!snapshot}
            paused={live.state !== "open"}
            onRangeChange={onRangeChange}
            selectedId={selectedId}
            selectedSeriesKey={selectedSeriesKey}
            onSelectActivity={onSelectActivity}
            onSelectSeries={onSelectSeries}
            onSelectOverflow={onSelectOverflow}
            onOpenIncomingOverflow={onOpenIncomingOverflow}
          />
        </section>
      </main>
    </div>
  );
}
